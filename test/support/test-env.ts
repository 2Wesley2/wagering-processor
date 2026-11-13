import { requiredEnv } from './run-context.ts';

export interface InstanceEnvOptions {
  readonly databaseUrl: string;
  readonly inboundQueue: string;
  readonly dlq: string;
  readonly eventsQueue: string;
  readonly extra?: Record<string, string>;
}

/** Tabela de tempos de teste (seção 14): Wait 1 s < drain 5 s < limite 8 s; VT 3 s. */
export function instanceEnv(options: InstanceEnvOptions): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    APP_ROLES: 'api',
    DATABASE_URL: options.databaseUrl,
    SQS_ENDPOINT: requiredEnv('SQS_ENDPOINT'),
    AWS_REGION: process.env['AWS_REGION'] ?? 'us-east-1',
    SQS_INBOUND_QUEUE: options.inboundQueue,
    SQS_DLQ: options.dlq,
    SQS_EVENTS_QUEUE: options.eventsQueue,
    SQS_WAIT_TIME_S: '1',
    SQS_VISIBILITY_TIMEOUT_S: '3',
    SQS_MAX_RECEIVE_COUNT: '5',
    SHUTDOWN_DRAIN_MS: '5000',
    SHUTDOWN_HARD_TIMEOUT_MS: '8000',
    HEALTH_TIMEOUT_MS: '1000',
    DB_LOCK_TIMEOUT_MS: '10000',
    DB_STATEMENT_TIMEOUT_MS: '15000',
    DB_QUERY_TIMEOUT_MS: '20000',
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000',
    // Tabela de tempos de teste (seção 14): TTL de pendência 3 s; worker rápido.
    PENDING_REFERENCE_TTL_MS: '3000',
    WORKER_POLL_INTERVAL_MS: '100',
    WORKER_LEASE_MS: '2000',
    WORKER_BACKOFF_BASE_MS: '100',
    WORKER_BACKOFF_MAX_MS: '1000',
    // Mensageria (F5): retry curto, alerta de dead-letter preso em 1 s, outbox e redrive rápidos.
    CONSUMER_POLLERS: '2',
    CONSUMER_RETRY_BASE_S: '1',
    CONSUMER_RETRY_MAX_S: '1',
    DEAD_LETTER_STUCK_AFTER_MS: '1000',
    OUTBOX_POLL_INTERVAL_MS: '100',
    OUTBOX_LEASE_MS: '2000',
    OUTBOX_BACKOFF_BASE_MS: '100',
    OUTBOX_BACKOFF_MAX_MS: '1000',
    REDRIVE_VISIBILITY_TIMEOUT_S: '2',
    ...options.extra,
  };
}
