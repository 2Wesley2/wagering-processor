import { z } from 'zod';
import {
  type ContractResult,
  describeIssues as describe,
  issueCode as codeOf,
  moneyContractSchema as moneySchema,
} from '../../../shared/zod-contract.ts';
import { isSubmittableKind, type SubmittableKind } from '../domain/wager-transaction.ts';

/**
 * Contrato único de submissão (D30): o mesmo schema serve HTTP e SQS. Strict:
 * campos desconhecidos são rejeitados (A17). Regras de referência por kind e
 * de valor zero ficam no domínio (WagerTransaction.create).
 */
const PRINTABLE = /^[!-~]+$/;
const printable = (max: number) => z.string().min(1).max(max).regex(PRINTABLE);

/** Começa com alfanumérico: o id reservado `__internal__` da OPENING nunca passa. */
export const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const IDEMPOTENCY_KEY_RE = /^[!-~]{1,255}$/;
export const MAX_SQS_BODY_BYTES = 16 * 1024;

const kindSchema = z.custom<SubmittableKind>(isSubmittableKind, {
  error: (issue) => (issue.input === 'OPENING' ? 'KIND_NOT_ALLOWED:OPENING' : 'VALIDATION_ERROR:kind'),
});

const businessFields = {
  providerId: z.string().regex(PROVIDER_ID_RE),
  externalTransactionId: printable(128),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: printable(128),
  gameId: printable(128),
  kind: kindSchema,
  money: moneySchema,
  referenceExternalTransactionId: printable(128).nullish(),
};

export const submitTransactionSchema = z.object(businessFields).strict();

export const wagerTransactionRequestedSchema = z
  .object({
    messageId: z.string().min(1).max(200),
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.iso.datetime({ offset: true }),
    data: z.object({ ...businessFields, idempotencyKey: z.string().regex(IDEMPOTENCY_KEY_RE) }).strict(),
  })
  .strict();

export type { ContractResult };

export interface SubmitTransactionCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: SubmittableKind;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId: string | undefined;
}

function toCommand(data: z.infer<typeof submitTransactionSchema>): SubmitTransactionCommand {
  return {
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId.toLowerCase(),
    walletId: data.walletId.toLowerCase(),
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: { amount: data.money.amount, currency: data.money.currency },
    referenceExternalTransactionId: data.referenceExternalTransactionId ?? undefined,
  };
}

export function parseSubmitTransaction(body: unknown): ContractResult<SubmitTransactionCommand> {
  const parsed = submitTransactionSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: codeOf(parsed.error.issues), issues: describe(parsed.error.issues) };
  return { ok: true, value: toCommand(parsed.data) };
}

export function parseIdempotencyKey(raw: string | string[] | undefined): ContractResult<string> {
  if (raw === undefined || raw === '')
    return { ok: false, code: 'IDEMPOTENCY_KEY_MISSING', issues: ['Idempotency-Key ausente'] };
  if (Array.isArray(raw)) return { ok: false, code: 'IDEMPOTENCY_KEY_INVALID', issues: ['Idempotency-Key repetido'] };
  if (!IDEMPOTENCY_KEY_RE.test(raw))
    return { ok: false, code: 'IDEMPOTENCY_KEY_INVALID', issues: ['Idempotency-Key fora do formato'] };
  return { ok: true, value: raw };
}

export interface SqsSubmitMessage {
  readonly messageId: string;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly command: SubmitTransactionCommand;
}

/** Envelope SQS: limite de bytes antes do JSON.parse; type desconhecido é código próprio. */
export function parseSqsEnvelope(body: string): ContractResult<SqsSubmitMessage> {
  if (Buffer.byteLength(body, 'utf8') > MAX_SQS_BODY_BYTES)
    return { ok: false, code: 'MESSAGE_TOO_LARGE', issues: ['corpo acima de 16 KiB'] };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', issues: ['JSON inválido'] };
  }
  if (typeof json === 'object' && json !== null && 'type' in json && json.type !== 'WagerTransactionRequested') {
    return { ok: false, code: 'UNSUPPORTED_MESSAGE_TYPE', issues: [`type ${String(json.type)}`] };
  }
  const parsed = wagerTransactionRequestedSchema.safeParse(json);
  if (!parsed.success) return { ok: false, code: codeOf(parsed.error.issues), issues: describe(parsed.error.issues) };
  const { idempotencyKey, ...business } = parsed.data.data;
  return {
    ok: true,
    value: {
      messageId: parsed.data.messageId,
      occurredAt: parsed.data.occurredAt,
      idempotencyKey,
      command: toCommand(business),
    },
  };
}
