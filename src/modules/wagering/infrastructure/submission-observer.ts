import { Counter, Histogram, type Registry } from 'prom-client';
import { ContextStore } from '../../../platform/observability/context.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import { pgErrorInfo } from '../../../platform/persistence/pg-errors.ts';
import type { DecisionRecord, PendingResolutionObserver, SubmissionObserver } from '../application/ports.ts';
import { IDEMPOTENCY_CONSTRAINTS } from '../application/submit-wager-transaction.ts';

/**
 * Logs e métricas da submissão (§12, D41, D42). Os logs levam ids e códigos, nunca valores
 * monetários nem playerId.
 */
export class LoggingSubmissionObserver implements SubmissionObserver {
  private readonly transactions: Counter<'kind' | 'status' | 'channel'>;
  private readonly duplicates: Counter<'source' | 'outcome'>;
  private readonly uniqueRaces: Counter<'constraint'>;
  private readonly rejections: Counter<'failure_code' | 'channel'>;
  private readonly duration: Histogram<'channel' | 'outcome'>;

  constructor(
    private readonly logger: AppLogger,
    registry: Registry,
  ) {
    this.transactions = new Counter({
      name: 'wagering_transactions_total',
      help: 'Transações decididas, por kind, status e canal',
      labelNames: ['kind', 'status', 'channel'],
      registers: [registry],
    });
    this.duplicates = new Counter({
      name: 'idempotency_duplicates_total',
      help: 'Duplicatas detectadas pela Idempotency-Key: replay ou conflito',
      labelNames: ['source', 'outcome'],
      registers: [registry],
    });
    this.rejections = new Counter({
      name: 'wagering_rejections_total',
      help: 'Transações rejeitadas por regra de negócio, por código e canal',
      labelNames: ['failure_code', 'channel'],
      registers: [registry],
    });
    this.duration = new Histogram({
      name: 'wagering_processing_duration_seconds',
      help: 'Duração da submissão (validação, lock, decisão e commit), por canal e resultado',
      labelNames: ['channel', 'outcome'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    });
    this.uniqueRaces = new Counter({
      name: 'wagering_unique_races_total',
      help: 'Corridas decididas pelo índice único (23505) e relidas como replay ou conflito',
      labelNames: ['constraint'],
      registers: [registry],
    });
  }

  decided(record: DecisionRecord): void {
    const channel = channelOf();
    this.transactions.inc({ kind: record.kind, status: record.status, channel });
    if (record.status === 'REJECTED') this.rejections.inc({ failure_code: record.failureCode ?? 'UNKNOWN', channel });
    this.logger.info(
      {
        event: 'transaction.decided',
        transactionId: record.transactionId,
        walletId: record.walletId,
        providerId: record.providerId,
        kind: record.kind,
        status: record.status,
        failureCode: record.failureCode,
      },
      'transaction.decided',
    );
  }

  replayed(record: { transactionId: string; providerId: string; status: string }): void {
    this.duplicates.inc({ source: channelOf(), outcome: 'replay' });
    this.logger.info({ event: 'transaction.replayed', ...record }, 'transaction.replayed');
  }

  conflict(code: 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_CONFLICT', providerId: string): void {
    this.duplicates.inc({ source: channelOf(), outcome: 'conflict' });
    this.logger.info({ event: 'transaction.conflict', code, providerId }, 'transaction.conflict');
  }

  uniqueRace(constraint: string): void {
    this.uniqueRaces.inc({ constraint });
    this.logger.info({ event: 'transaction.unique_race', constraint }, 'transaction.unique_race');
  }

  completed(durationSeconds: number, outcome: 'ok' | 'error'): void {
    this.duration.observe({ channel: channelOf(), outcome }, durationSeconds);
  }
}

/** Canal da submissão em curso: a entrega SQS põe o messageId no contexto de log (ALS). */
function channelOf(): 'http' | 'sqs' {
  return ContextStore.get().messageId === undefined ? 'http' : 'sqs';
}

/** Pendências resolvidas pelo worker: pela referência ou pelo prazo (§7.1, D42). */
export class LoggingPendingResolutionObserver implements PendingResolutionObserver {
  private readonly resolutions: Counter<'outcome' | 'reason'>;

  constructor(
    private readonly logger: AppLogger,
    registry: Registry,
  ) {
    this.resolutions = new Counter({
      name: 'pending_reference_resolutions_total',
      help: 'Pendências de referência resolvidas pelo worker, por desfecho e motivo',
      labelNames: ['outcome', 'reason'],
      registers: [registry],
    });
  }

  resolved(record: DecisionRecord, reason: 'REFERENCE' | 'DEADLINE'): void {
    this.resolutions.inc({ outcome: record.status, reason });
    this.logger.info(
      {
        event: 'pending_reference.resolved',
        transactionId: record.transactionId,
        walletId: record.walletId,
        providerId: record.providerId,
        kind: record.kind,
        status: record.status,
        failureCode: record.failureCode,
        reason,
      },
      'pending_reference.resolved',
    );
  }
}

/** Violação de unicidade das constraints de idempotência (23505), pelo nome da constraint. */
export function idempotencyViolationOf(error: unknown): string | undefined {
  const info = pgErrorInfo(error);
  if (info.sqlState !== '23505' || info.constraint === undefined) return undefined;
  return IDEMPOTENCY_CONSTRAINTS.some((name) => name === info.constraint) ? info.constraint : undefined;
}
