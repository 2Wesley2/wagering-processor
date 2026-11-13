import { hashV1 } from '../../../shared/canonical-json.ts';
import type { MoneyProps } from '../../../shared/money.ts';

/** Campos de negócio que definem "a mesma operação" (D28). */
export interface CommandHashInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | null | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normalizeUuid = (value: string): string => (UUID_RE.test(value) ? value.toLowerCase() : value);

/**
 * payloadHash = `v1:` + sha256 do JSON canônico do subconjunto de negócio.
 * Ficam de fora: Idempotency-Key, messageId, type, occurredAt e correlationId.
 * `null` ≡ ausente; UUIDs em minúsculas.
 */
export function commandHash(input: CommandHashInput): string {
  return hashV1({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: normalizeUuid(input.playerId),
    walletId: normalizeUuid(input.walletId),
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? undefined,
  });
}

/** Hash do envelope SQS para a inbox: `{type, data}` canônicos (D28). */
export function envelopeHash(envelope: { type: unknown; data: unknown }): string {
  return hashV1({ type: envelope.type, data: envelope.data });
}
