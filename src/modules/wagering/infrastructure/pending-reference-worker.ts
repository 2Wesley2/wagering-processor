import { z } from 'zod';
import { ContextStore } from '../../../platform/observability/context.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';
import { pgErrorInfo } from '../../../platform/persistence/pg-errors.ts';
import type { ResolvePendingReferences } from '../application/resolve-pending-references.ts';

const claimedRowSchema = z.object({ walletId: z.string() });

export interface PendingReferenceWorkerOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
}

/**
 * Laço do worker agendado (papel `pending-reference-worker`, D40). Várias instâncias competem
 * sem eleição de líder: o claim é curto, em autocommit, com `FOR UPDATE SKIP LOCKED` e lease, e
 * não toca wallets. A decisão acontece depois, numa UnitOfWork por wallet, sob o lock dela.
 * Uma falha (inclusive 55P03) libera o claim sem consumir tentativa.
 */
export class PendingReferenceWorker {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly sql: AutocommitSql,
    private readonly resolver: ResolvePendingReferences,
    private readonly options: PendingReferenceWorkerOptions,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ event: 'pending_reference_worker.started' }, 'pending_reference_worker.started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info({ event: 'pending_reference_worker.stopped' }, 'pending_reference_worker.stopped');
  }

  /** Uma rodada: reivindica pendências vencidas e resolve cada wallet envolvida. */
  async tick(): Promise<number> {
    const token = Bun.randomUUIDv7();
    const claimed = (
      await this.sql.all<unknown>(
        `UPDATE pending_reference_checks c
            SET claim_token = ?, claimed_until = clock_timestamp() + make_interval(secs => ?::numeric / 1000)
          WHERE c.transaction_id IN (
                  SELECT transaction_id FROM pending_reference_checks
                   WHERE next_check_at <= clock_timestamp() AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
                   ORDER BY next_check_at
                   LIMIT ?
                     FOR UPDATE SKIP LOCKED)
          RETURNING c.wallet_id::text AS "walletId"`,
        [token, this.options.leaseMs, this.options.batchSize],
      )
    ).map((row) => claimedRowSchema.parse(row).walletId);
    const wallets = [...new Set(claimed)];
    for (const walletId of wallets) {
      try {
        // Contexto de log da rodada (ALS): toda linha emitida na resolução leva a wallet.
        await ContextStore.run({ walletId, correlationId: `pending-reference-worker:${walletId}` }, () =>
          this.resolver.resolveWallet(walletId),
        );
      } catch (error) {
        const info = pgErrorInfo(error);
        this.logger.warn(
          {
            event: 'pending_reference_worker.wallet_failed',
            walletId,
            sqlState: info.sqlState,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          'pending_reference_worker.wallet_failed',
        );
        await this.release(token, walletId, error instanceof Error ? error.message : String(error)).catch(
          () => undefined,
        );
      }
    }
    return wallets.length;
  }

  private async release(token: string, walletId: string, message: string): Promise<void> {
    await this.sql.all(
      `UPDATE pending_reference_checks SET claim_token = NULL, claimed_until = NULL, last_error = left(?, 500)
        WHERE claim_token = ? AND wallet_id = ?`,
      [message, token, walletId],
    );
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        this.logger.warn(
          {
            event: 'pending_reference_worker.tick_failed',
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
          'pending_reference_worker.tick_failed',
        );
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollIntervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

/** Backoff exponencial com jitter, limitado (D40): min(máximo, base·2^n)·U(0,5; 1). */
export function exponentialBackoff(baseMs: number, maxMs: number): (attempts: number) => number {
  return (attempts) => {
    const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 30));
    const jitter = 0.5 + (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) / 510;
    return Math.max(1, Math.trunc(ceiling * jitter));
  };
}
