/**
 * ErrorCatalog único (D11, §7.2): cada código estável tem status HTTP, se
 * persiste, se é retentável, ação no consumidor SQS e ação esperada do provedor.
 * `satisfies Record<ErrorCode, ErrorMeta>` torna o registro exaustivo em tempo
 * de compilação.
 */
export type SqsAction = 'ACK' | 'RETRY' | 'DLQ' | 'DEAD_LETTER';
export type ProviderAction =
  'FIX_AND_RESEND' | 'DO_NOT_RESEND' | 'GIVE_UP' | 'WAIT_OR_QUERY' | 'RETRY_SAME_KEY' | 'ESCALATE';
export type ErrorCategory =
  | 'validation'
  | 'transport'
  | 'authentication'
  | 'identity'
  | 'not_found'
  | 'conflict'
  | 'business'
  | 'transient'
  | 'permanent'
  | 'queue';

export interface ErrorMeta {
  readonly category: ErrorCategory;
  /** undefined: código que só existe na fila (não tem resposta HTTP). */
  readonly http: number | undefined;
  /** true = grava WagerTransaction (REJECTED ou FAILED). */
  readonly persists: boolean;
  readonly retryable: boolean;
  readonly sqs: SqsAction;
  readonly provider: ProviderAction;
}

const validation = {
  category: 'validation',
  http: 400,
  persists: false,
  retryable: false,
  sqs: 'DLQ',
  provider: 'FIX_AND_RESEND',
} as const;
const business = {
  category: 'business',
  http: 422,
  persists: true,
  retryable: false,
  sqs: 'ACK',
  provider: 'GIVE_UP',
} as const;
const conflict = {
  category: 'conflict',
  http: 409,
  persists: false,
  retryable: false,
  sqs: 'DEAD_LETTER',
  provider: 'DO_NOT_RESEND',
} as const;
const transient = {
  category: 'transient',
  http: 503,
  persists: false,
  retryable: true,
  sqs: 'RETRY',
  provider: 'RETRY_SAME_KEY',
} as const;
const queueOnly = {
  category: 'queue',
  http: undefined,
  persists: false,
  retryable: false,
  sqs: 'DLQ',
  provider: 'FIX_AND_RESEND',
} as const;

export const ERROR_CATALOG = {
  // 400: contrato e endereçamento; nada é persistido; a mesma key pode ser reenviada corrigida.
  VALIDATION_ERROR: validation,
  MALFORMED_JSON: validation,
  IDEMPOTENCY_KEY_MISSING: validation,
  IDEMPOTENCY_KEY_INVALID: validation,
  INVALID_AMOUNT: validation,
  UNSUPPORTED_CURRENCY: validation,
  KIND_NOT_ALLOWED: validation,
  REFERENCE_REQUIRED: validation,
  REFERENCE_NOT_ALLOWED: validation,
  SELF_REFERENCE: validation,
  WALLET_PLAYER_MISMATCH: validation,
  CURRENCY_MISMATCH: validation,
  INVALID_CURSOR: validation,
  // 413/415: transporte HTTP; nada é persistido.
  PAYLOAD_TOO_LARGE: {
    category: 'transport',
    http: 413,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    category: 'transport',
    http: 415,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  // 401: a porta de autenticação recusou a requisição (ponto de extensão do §2; hoje no-op).
  AUTHENTICATION_REQUIRED: {
    category: 'authentication',
    http: 401,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  // 403
  PROVIDER_NOT_RECOGNIZED: {
    category: 'identity',
    http: 403,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  PROVIDER_IDENTITY_MISMATCH: {
    category: 'identity',
    http: 403,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  // 404
  WALLET_NOT_FOUND: {
    category: 'not_found',
    http: 404,
    persists: false,
    retryable: false,
    sqs: 'DEAD_LETTER',
    provider: 'FIX_AND_RESEND',
  },
  ROUTE_NOT_FOUND: {
    category: 'not_found',
    http: 404,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  TRANSACTION_NOT_FOUND: {
    category: 'not_found',
    http: 404,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'FIX_AND_RESEND',
  },
  // 409: conflito não é replay.
  IDEMPOTENCY_KEY_REUSED: conflict,
  EXTERNAL_TRANSACTION_ID_CONFLICT: conflict,
  WALLET_ALREADY_EXISTS: conflict,
  // 422: regra de negócio; REJECTED persistido + evento; uma nova operação exige novo externalTransactionId.
  INSUFFICIENT_FUNDS: business,
  REVERSAL_INSUFFICIENT_FUNDS: business,
  BALANCE_LIMIT_EXCEEDED: business,
  REFERENCE_NOT_FOUND: business,
  REFERENCE_NOT_PROCESSED: business,
  REFERENCE_SCOPE_MISMATCH: business,
  INVALID_REFERENCE_KIND: business,
  REFERENCE_AMOUNT_MISMATCH: business,
  REVERSAL_KIND_ALREADY_USED: business,
  REFERENCE_ALREADY_REVERSED: business,
  REFERENCED_BET_REVERSED: business,
  BET_ALREADY_SETTLED: business,
  // 503 + Retry-After: resultado incerto; reenviar com a MESMA key vira replay.
  DATABASE_UNAVAILABLE: transient,
  CONCURRENCY_CONFLICT: transient,
  SERVICE_SHUTTING_DOWN: transient,
  // 500
  INTERNAL_ERROR: {
    category: 'permanent',
    http: 500,
    persists: false,
    retryable: false,
    sqs: 'DLQ',
    provider: 'ESCALATE',
  },
  PROCESSING_PERMANENT_FAILURE: {
    category: 'permanent',
    http: 500,
    persists: true,
    retryable: false,
    sqs: 'DLQ',
    provider: 'ESCALATE',
  },
  // Só na fila.
  UNSUPPORTED_MESSAGE_TYPE: queueOnly,
  MESSAGE_ID_PAYLOAD_MISMATCH: { ...queueOnly, sqs: 'DEAD_LETTER', provider: 'DO_NOT_RESEND' },
  MESSAGE_TOO_LARGE: queueOnly,
} as const satisfies Record<string, ErrorMeta>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** Códigos de rejeição de negócio (status REJECTED). */
export type RejectionCode = {
  [K in ErrorCode]: (typeof ERROR_CATALOG)[K]['category'] extends 'business' ? K : never;
}[ErrorCode];

/** Códigos de falha permanente gravados como FAILED (só no worker). */
export type PermanentFailureCode = 'PROCESSING_PERMANENT_FAILURE';

export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_CATALOG, value);
}

export function errorMeta(code: ErrorCode): ErrorMeta {
  return ERROR_CATALOG[code];
}

export const REJECTION_CODES: readonly RejectionCode[] = Object.keys(ERROR_CATALOG).filter(
  (code): code is RejectionCode => isErrorCode(code) && ERROR_CATALOG[code].category === 'business',
);

/** Classificação de SQLSTATE do PostgreSQL (D26). */
export type SqlStateClass = 'RETRY_UOW' | 'UNIQUE_VIOLATION' | 'INTEGRITY_BUG' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNKNOWN';

export function classifySqlState(sqlState: string | undefined): SqlStateClass {
  if (sqlState === undefined) return 'UNKNOWN';
  if (sqlState === '40001' || sqlState === '40P01' || sqlState === '55P03') return 'RETRY_UOW';
  if (sqlState === '23505') return 'UNIQUE_VIOLATION';
  if (sqlState.startsWith('23')) return 'INTEGRITY_BUG';
  if (sqlState === '57014') return 'TIMEOUT';
  // 25P03: o servidor encerrou a sessão ociosa dentro da transação (processo congelado); nada comitou.
  if (
    sqlState === '25P03' ||
    sqlState.startsWith('08') ||
    sqlState === '57P01' ||
    sqlState === '57P02' ||
    sqlState === '57P03' ||
    sqlState === '53300'
  ) {
    return 'UNAVAILABLE';
  }
  return 'UNKNOWN';
}
