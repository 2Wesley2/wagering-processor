import os from 'node:os';
import { z } from 'zod';

export const APP_ROLES = [
  'api',
  'consumer',
  'outbox-publisher',
  'pending-reference-worker',
  'events-projection',
] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Papéis ligados quando APP_ROLES não é informado. `events-projection` (consumidor de referência
 * dos eventos, D39) fica de fora: numa fila SQS cada mensagem vai para um consumidor só, e a
 * projeção não pode competir com os consumidores reais da fila de eventos.
 */
export const DEFAULT_APP_ROLES: readonly AppRole[] = [
  'api',
  'consumer',
  'outbox-publisher',
  'pending-reference-worker',
];

/** Pontos de injeção de falha (D47). Só têm efeito com NODE_ENV=test e FAULT_INJECTION=enabled. */
export const FAULT_POINTS = [
  'uow.beforeCommit',
  'consumer.afterReceive',
  'consumer.afterCommitBeforeAck',
  'consumer.afterDeadLetterCommitBeforeSend',
  'consumer.afterDlqSendBeforeDelete',
  'consumer.dlqSendFails',
  'redrive.afterPendingBeforeSend',
  'redrive.afterSendBeforeMark',
  'redrive.afterMarkBeforeDelete',
  'outbox.afterClaimBeforePublish',
  'outbox.afterPublishBeforeMark',
  'republish.beforeSend',
  'worker.afterClaim',
  'selfcheck.probe',
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export function isFaultPoint(value: string): value is FaultPoint {
  return FAULT_POINTS.some((point) => point === value);
}

export function isAppRole(value: string): value is AppRole {
  return APP_ROLES.some((role) => role === value);
}

/** Adaptadores da porta de autenticação (§2, U1). `deny-all` existe só para testes. */
export const AUTHENTICATION_ADAPTERS = ['noop', 'deny-all'] as const;
export type AuthenticationAdapter = (typeof AUTHENTICATION_ADAPTERS)[number];

/** Mesmo formato do providerId no contrato de submissão; o id interno `__internal__` não passa. */
const PROVIDER_ID_FORMAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const faultPlanSchema = z.array(
  z
    .object({
      point: z.enum(FAULT_POINTS),
      match: z
        .object({ messageId: z.string().min(1).optional(), eventId: z.string().min(1).optional() })
        .strict()
        .optional(),
      action: z.enum(['kill', 'pause', 'fail', 'failOnce']),
    })
    .strict(),
);
export type FaultPlanEntry = z.infer<typeof faultPlanSchema>[number];

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  readonly nodeEnv: 'production' | 'test' | 'development';
  readonly roles: ReadonlySet<AppRole>;
  readonly instanceId: string;
  readonly port: number;
  readonly logLevel: string;
  readonly databaseUrl: string;
  readonly dbPoolMax: number;
  readonly healthTimeoutMs: number;
  /**
   * Timeouts do banco (D25): lock, instrução e sessão ociosa em transação são locais da
   * UnitOfWork; query e conexão são do cliente (pool do `pg`).
   */
  readonly database: {
    readonly lockTimeoutMs: number;
    readonly statementTimeoutMs: number;
    readonly idleInTransactionTimeoutMs: number;
    readonly queryTimeoutMs: number;
    readonly connectTimeoutMs: number;
  };
  /** Registro de provedores reconhecidos (D33): fora dele, 403 PROVIDER_NOT_RECOGNIZED. */
  readonly providers: ReadonlySet<string>;
  /**
   * Pendências de referência (D40): TTL contado do aceite no relógio do PostgreSQL e o worker
   * agendado (papel `pending-reference-worker`), com claims curtos e backoff exponencial.
   */
  readonly pendingReferences: {
    readonly ttlMs: number;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
  };
  readonly authenticationAdapter: AuthenticationAdapter;
  /**
   * Consumidor SQS (D35): pollers por instância, nome do consumidor (identidade da inbox e do
   * dead-letter), backoff de reentrega para erro transitório e alerta de dead-letter preso.
   */
  readonly consumer: {
    readonly name: string;
    readonly pollers: number;
    readonly retryBaseS: number;
    readonly retryMaxS: number;
    readonly deadLetterStuckAfterMs: number;
    readonly breakerOpenMs: number;
  };
  /**
   * Retenção (D18, D38): inbox processada há mais de `inboxDays` (≥ 30) e outbox PUBLICADA há mais
   * de `outboxDays` (≥ 7). Eventos não publicados nunca são apagados.
   */
  readonly retention: {
    readonly inboxDays: number;
    readonly outboxDays: number;
    readonly batchSize: number;
    readonly intervalMs: number;
  };
  /** Publicador da outbox (D38): claims com lease, lote de até 10 (SendMessageBatch) e backoff. */
  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
  };
  readonly sqs: {
    readonly endpoint: string;
    readonly region: string;
    readonly inboundQueue: string;
    readonly dlq: string;
    readonly eventsQueue: string;
    readonly waitTimeS: number;
    readonly visibilityTimeoutS: number;
    readonly maxReceiveCount: number;
    /** Reprovisiona as filas no boot e ao receber QueueDoesNotExist (ligado no compose). */
    readonly provisionOnBoot: boolean;
    /** Visibilidade das cópias lidas da DLQ pelo `sqs:redrive`. */
    readonly redriveVisibilityTimeoutS: number;
  };
  readonly shutdown: {
    readonly drainMs: number;
    readonly hardTimeoutMs: number;
    readonly readinessDrainDelayMs: number;
    /** Prazo de cada fechamento de recurso (pool, clientes) depois do HTTP. */
    readonly closeTimeoutMs: number;
    readonly exitOnStdinEof: boolean;
  };
  readonly fault: { readonly enabled: boolean; readonly plan: readonly FaultPlanEntry[] };
}

const int = (min: number, max: number, fallback: number) => z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(['production', 'test', 'development']).default('production'),
  APP_ROLES: z.string().default(DEFAULT_APP_ROLES.join(',')),
  INSTANCE_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .default(os.hostname().slice(0, 64)),
  PORT: int(0, 65535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'DATABASE_URL deve ser uma URL postgres://'),
  DB_POOL_MAX: int(1, 100, 10),
  HEALTH_TIMEOUT_MS: int(100, 10_000, 1000),
  DB_LOCK_TIMEOUT_MS: int(1, 600_000, 2000),
  DB_STATEMENT_TIMEOUT_MS: int(1, 600_000, 5000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int(1, 600_000, 15_000),
  DB_QUERY_TIMEOUT_MS: int(1, 600_000, 6000),
  DB_CONNECT_TIMEOUT_MS: int(1, 600_000, 2000),
  PROVIDER_IDS: z.string().default('provider-a,provider-b'),
  AUTHENTICATION_ADAPTER: z.enum(AUTHENTICATION_ADAPTERS).default('noop'),
  PENDING_REFERENCE_TTL_MS: int(1, 86_400_000, 1_800_000),
  WORKER_POLL_INTERVAL_MS: int(10, 600_000, 1000),
  WORKER_BATCH_SIZE: int(1, 500, 50),
  WORKER_LEASE_MS: int(100, 600_000, 30_000),
  WORKER_BACKOFF_BASE_MS: int(1, 600_000, 1000),
  WORKER_BACKOFF_MAX_MS: int(1, 3_600_000, 60_000),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  SQS_ENDPOINT: z.string().regex(/^https?:\/\//, 'SQS_ENDPOINT deve ser uma URL http(s)://'),
  SQS_INBOUND_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wagering-events.fifo'),
  SQS_WAIT_TIME_S: int(0, 20, 10),
  SQS_VISIBILITY_TIMEOUT_S: int(1, 43_200, 30),
  SQS_MAX_RECEIVE_COUNT: int(1, 1000, 8),
  SQS_PROVISION_ON_BOOT: z.enum(['0', '1']).default('0'),
  REDRIVE_VISIBILITY_TIMEOUT_S: int(1, 43_200, 30),
  CONSUMER_NAME: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,64}$/)
    .default('wager-transactions'),
  CONSUMER_POLLERS: int(1, 32, 4),
  CONSUMER_RETRY_BASE_S: int(0, 900, 1),
  CONSUMER_RETRY_MAX_S: int(0, 900, 60),
  DEAD_LETTER_STUCK_AFTER_MS: int(1, 86_400_000, 900_000),
  CONSUMER_BREAKER_OPEN_MS: int(100, 600_000, 5000),
  RETENTION_INBOX_DAYS: int(30, 3650, 30),
  RETENTION_OUTBOX_DAYS: int(7, 3650, 7),
  RETENTION_BATCH_SIZE: int(1, 10_000, 1000),
  RETENTION_INTERVAL_MS: int(1000, 86_400_000, 3_600_000),
  OUTBOX_POLL_INTERVAL_MS: int(10, 600_000, 200),
  OUTBOX_BATCH_SIZE: int(1, 10, 10),
  OUTBOX_LEASE_MS: int(100, 600_000, 30_000),
  OUTBOX_BACKOFF_BASE_MS: int(1, 600_000, 1000),
  OUTBOX_BACKOFF_MAX_MS: int(1, 3_600_000, 300_000),
  SHUTDOWN_DRAIN_MS: int(0, 600_000, 20_000),
  SHUTDOWN_HARD_TIMEOUT_MS: int(1, 600_000, 30_000),
  READINESS_DRAIN_DELAY_MS: int(0, 60_000, 0),
  SHUTDOWN_CLOSE_TIMEOUT_MS: int(100, 60_000, 2000),
  EXIT_ON_STDIN_EOF: z.enum(['0', '1']).default('0'),
  FAULT_INJECTION: z.string().optional(),
  FAULT_PLAN: z.string().optional(),
});

function parseRoles(raw: string): ReadonlySet<AppRole> {
  const roles = raw
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
  const invalid = roles.filter((role) => !isAppRole(role));
  if (invalid.length > 0) {
    throw new ConfigError('config.invalid_roles', `APP_ROLES inválido: ${invalid.join(', ')}`);
  }
  return new Set(roles.filter(isAppRole));
}

function parseProviders(raw: string): ReadonlySet<string> {
  const providers = raw
    .split(',')
    .map((provider) => provider.trim())
    .filter((provider) => provider.length > 0);
  const invalid = providers.filter((provider) => !PROVIDER_ID_FORMAT.test(provider));
  if (providers.length === 0 || invalid.length > 0) {
    throw new ConfigError('config.invalid_providers', `PROVIDER_IDS inválido: ${invalid.join(', ') || '(vazio)'}`);
  }
  return new Set(providers);
}

function parseFaultPlan(raw: string | undefined): FaultPlanEntry[] {
  if (raw === undefined || raw.trim() === '') return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError('config.invalid_fault_plan', 'FAULT_PLAN não é JSON válido');
  }
  const parsed = faultPlanSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError('config.invalid_fault_plan', `FAULT_PLAN inválido: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Lê e valida a configuração. Lança ConfigError, que o bootstrap converte em
 * log fatal + exit 1 (nunca sobe com configuração inválida).
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  // Guarda dupla da injeção de falhas (D47): fora de NODE_ENV=test a app recusa subir.
  const nodeEnvRaw = env['NODE_ENV'] ?? 'production';
  const wantsFault = env['FAULT_INJECTION'] !== undefined || env['FAULT_PLAN'] !== undefined;
  if (wantsFault && nodeEnvRaw !== 'test') {
    throw new ConfigError(
      'config.fault_injection_forbidden',
      'FAULT_INJECTION/FAULT_PLAN só são aceitos com NODE_ENV=test',
    );
  }
  if (env['FAULT_INJECTION'] !== undefined && env['FAULT_INJECTION'] !== 'enabled') {
    throw new ConfigError('config.invalid_fault_injection', "FAULT_INJECTION só aceita o valor 'enabled'");
  }
  if (env['FAULT_PLAN'] !== undefined && env['FAULT_INJECTION'] !== 'enabled') {
    throw new ConfigError('config.fault_plan_requires_enable', 'FAULT_PLAN exige FAULT_INJECTION=enabled');
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      'config.invalid',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const environment = parsed.data;

  if (environment.AUTHENTICATION_ADAPTER === 'deny-all' && environment.NODE_ENV !== 'test') {
    throw new ConfigError('config.authentication_adapter_forbidden', 'AUTHENTICATION_ADAPTER=deny-all só em teste');
  }
  // O cliente só desiste depois do servidor: o statement_timeout cancela a consulta antes (D25).
  if (environment.DB_QUERY_TIMEOUT_MS <= environment.DB_STATEMENT_TIMEOUT_MS) {
    throw new ConfigError(
      'config.invalid_timing',
      `exige DB_QUERY_TIMEOUT_MS (${environment.DB_QUERY_TIMEOUT_MS}) > DB_STATEMENT_TIMEOUT_MS (${environment.DB_STATEMENT_TIMEOUT_MS})`,
    );
  }

  // Tabela de tempos (seção 14): long poll < drenagem < limite duro.
  const waitMs = environment.SQS_WAIT_TIME_S * 1000;
  if (!(
    waitMs < environment.SHUTDOWN_DRAIN_MS && environment.SHUTDOWN_DRAIN_MS < environment.SHUTDOWN_HARD_TIMEOUT_MS
  )) {
    throw new ConfigError(
      'config.invalid_timing',
      `exige SQS_WAIT_TIME_S*1000 (${waitMs}) < SHUTDOWN_DRAIN_MS (${environment.SHUTDOWN_DRAIN_MS}) < SHUTDOWN_HARD_TIMEOUT_MS (${environment.SHUTDOWN_HARD_TIMEOUT_MS})`,
    );
  }

  return {
    nodeEnv: environment.NODE_ENV,
    roles: parseRoles(environment.APP_ROLES),
    instanceId: environment.INSTANCE_ID,
    port: environment.PORT,
    logLevel: environment.LOG_LEVEL,
    databaseUrl: environment.DATABASE_URL,
    dbPoolMax: environment.DB_POOL_MAX,
    healthTimeoutMs: environment.HEALTH_TIMEOUT_MS,
    database: {
      lockTimeoutMs: environment.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: environment.DB_STATEMENT_TIMEOUT_MS,
      idleInTransactionTimeoutMs: environment.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      queryTimeoutMs: environment.DB_QUERY_TIMEOUT_MS,
      connectTimeoutMs: environment.DB_CONNECT_TIMEOUT_MS,
    },
    providers: parseProviders(environment.PROVIDER_IDS),
    pendingReferences: {
      ttlMs: environment.PENDING_REFERENCE_TTL_MS,
      pollIntervalMs: environment.WORKER_POLL_INTERVAL_MS,
      batchSize: environment.WORKER_BATCH_SIZE,
      leaseMs: environment.WORKER_LEASE_MS,
      backoffBaseMs: environment.WORKER_BACKOFF_BASE_MS,
      backoffMaxMs: environment.WORKER_BACKOFF_MAX_MS,
    },
    authenticationAdapter: environment.AUTHENTICATION_ADAPTER,
    consumer: {
      name: environment.CONSUMER_NAME,
      pollers: environment.CONSUMER_POLLERS,
      retryBaseS: environment.CONSUMER_RETRY_BASE_S,
      retryMaxS: environment.CONSUMER_RETRY_MAX_S,
      deadLetterStuckAfterMs: environment.DEAD_LETTER_STUCK_AFTER_MS,
      breakerOpenMs: environment.CONSUMER_BREAKER_OPEN_MS,
    },
    retention: {
      inboxDays: environment.RETENTION_INBOX_DAYS,
      outboxDays: environment.RETENTION_OUTBOX_DAYS,
      batchSize: environment.RETENTION_BATCH_SIZE,
      intervalMs: environment.RETENTION_INTERVAL_MS,
    },
    outbox: {
      pollIntervalMs: environment.OUTBOX_POLL_INTERVAL_MS,
      batchSize: environment.OUTBOX_BATCH_SIZE,
      leaseMs: environment.OUTBOX_LEASE_MS,
      backoffBaseMs: environment.OUTBOX_BACKOFF_BASE_MS,
      backoffMaxMs: environment.OUTBOX_BACKOFF_MAX_MS,
    },
    sqs: {
      endpoint: environment.SQS_ENDPOINT,
      region: environment.AWS_REGION,
      inboundQueue: environment.SQS_INBOUND_QUEUE,
      dlq: environment.SQS_DLQ,
      eventsQueue: environment.SQS_EVENTS_QUEUE,
      waitTimeS: environment.SQS_WAIT_TIME_S,
      visibilityTimeoutS: environment.SQS_VISIBILITY_TIMEOUT_S,
      maxReceiveCount: environment.SQS_MAX_RECEIVE_COUNT,
      provisionOnBoot: environment.SQS_PROVISION_ON_BOOT === '1',
      redriveVisibilityTimeoutS: environment.REDRIVE_VISIBILITY_TIMEOUT_S,
    },
    shutdown: {
      drainMs: environment.SHUTDOWN_DRAIN_MS,
      hardTimeoutMs: environment.SHUTDOWN_HARD_TIMEOUT_MS,
      readinessDrainDelayMs: environment.READINESS_DRAIN_DELAY_MS,
      closeTimeoutMs: environment.SHUTDOWN_CLOSE_TIMEOUT_MS,
      exitOnStdinEof: environment.EXIT_ON_STDIN_EOF === '1',
    },
    fault: { enabled: environment.FAULT_INJECTION === 'enabled', plan: parseFaultPlan(environment.FAULT_PLAN) },
  };
}
