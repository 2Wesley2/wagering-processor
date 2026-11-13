import { z } from 'zod';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';

export interface RetentionOptions {
  /** Inbox processada há mais de N dias (mínimo 30, imposto também pelo banco). */
  readonly inboxDays: number;
  /** Outbox PUBLICADA há mais de N dias (mínimo 7); eventos à espera de publicação nunca saem. */
  readonly outboxDays: number;
  readonly batchSize: number;
  readonly intervalMs: number;
}

const resultSchema = z.object({ inboxDeleted: z.coerce.number(), outboxDeleted: z.coerce.number() });

export interface PurgeReport {
  readonly inboxDeleted: number;
  readonly outboxDeleted: number;
}

/**
 * Limpeza por retenção (D18, D38). A única porta é a função `wagering_purge_retention` (dono do
 * schema, SECURITY DEFINER): ela recusa prazos abaixo do mínimo, nunca apaga evento não publicado
 * e não toca tabelas financeiras. Roda em lotes até não sobrar nada vencido; várias instâncias
 * podem chamar ao mesmo tempo (advisory lock dentro da função: uma purga por vez).
 */
export class RetentionPurger {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<PurgeReport> | undefined;

  constructor(
    private readonly sql: AutocommitSql,
    private readonly logger: AppLogger,
    private readonly options: RetentionOptions,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.purge().catch((error: unknown) =>
        this.logger.warn(
          { event: 'retention.purge_failed', error: error instanceof Error ? error.message : String(error) },
          'retention.purge_failed',
        ),
      );
    }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  async purge(): Promise<PurgeReport> {
    this.running ??= this.purgeAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async purgeAll(): Promise<PurgeReport> {
    let inboxDeleted = 0;
    let outboxDeleted = 0;
    for (let round = 0; round < 1000; round++) {
      const rows = await this.sql.all<unknown>(
        `SELECT inbox_deleted::text AS "inboxDeleted", outbox_deleted::text AS "outboxDeleted"
           FROM wagering_purge_retention(?, ?, ?)`,
        [this.options.inboxDays, this.options.outboxDays, this.options.batchSize],
      );
      const result = resultSchema.parse(rows[0]);
      inboxDeleted += result.inboxDeleted;
      outboxDeleted += result.outboxDeleted;
      if (result.inboxDeleted < this.options.batchSize && result.outboxDeleted < this.options.batchSize) break;
    }
    this.logger.info(
      {
        event: 'retention.purged',
        inboxDeleted,
        outboxDeleted,
        inboxDays: this.options.inboxDays,
        outboxDays: this.options.outboxDays,
      },
      'retention.purged',
    );
    return { inboxDeleted, outboxDeleted };
  }
}
