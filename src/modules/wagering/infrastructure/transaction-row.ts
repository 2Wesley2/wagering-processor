import { z } from 'zod';
import type { TimedTransaction, TransactionInstants, TransactionRow } from '../application/ports.ts';

/** Versão vinda do banco: texto (SQL explícito) ou number (record do ORM); sempre inteiro ≥ 1. */
const version = z.union([z.string().regex(/^[1-9]\d{0,15}$/), z.number().int().min(1)]).transform(Number);

/**
 * Validação de formato de uma linha de `wager_transactions` (§6.0: formato e conversão, sem
 * reprocessar transições). Serve às duas fontes: SQL explícito (aliases em camelCase) e o record
 * de leitura do ORM.
 */
const transactionRowSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  externalTransactionId: z.string(),
  idempotencyKey: z.string(),
  payloadHash: z.string(),
  walletId: z.string(),
  playerId: z.string(),
  roundId: z.string(),
  gameId: z.string(),
  kind: z.string(),
  currency: z.string(),
  amount: z.string(),
  referenceExternalTransactionId: z.string().nullable(),
  referenceTransactionId: z.string().nullable(),
  status: z.string(),
  failureCode: z.string().nullable(),
  initialStatus: z.string(),
  acceptedBalance: z.string(),
  acceptedWalletVersion: version,
  acceptedAt: z.coerce.date(),
  resultBalance: z.string().nullable(),
  resultWalletVersion: version.nullable(),
  decidedAt: z.coerce.date().nullable(),
  availableAt: z.coerce.date().nullable(),
  pendingDeadlineAt: z.coerce.date().nullable(),
  correlationId: z.string(),
  createdAt: z.coerce.date(),
});

export function parseTransactionRow(raw: unknown): TransactionRow {
  return transactionRowSchema.parse(raw);
}

/** Microssegundos desde a época Unix, como texto inteiro gerado pelo PostgreSQL (ver EXACT_INSTANT_COLUMNS). */
const microseconds = z
  .string()
  .regex(/^-?\d{1,19}$/)
  .transform((value) => BigInt(value));

const instantsSchema = z.object({
  acceptedAtMicros: microseconds,
  availableAtMicros: microseconds.nullable(),
  pendingDeadlineAtMicros: microseconds.nullable(),
});

/** Converte um `timestamptz` em microssegundos exatos (`extract(epoch)` é numeric desde o PostgreSQL 14). */
export const exactInstantSql = (column: string): string => `(extract(epoch FROM ${column}) * 1000000)::bigint::text`;

/** Colunas extras com os instantes exatos usados pela regra de prazo (D40). */
export const EXACT_INSTANT_COLUMNS = `
  ${exactInstantSql('accepted_at')} AS "acceptedAtMicros",
  ${exactInstantSql('available_at')} AS "availableAtMicros",
  ${exactInstantSql('pending_deadline_at')} AS "pendingDeadlineAtMicros"`;

export function parseTimedTransaction(raw: unknown): TimedTransaction {
  const instants = instantsSchema.parse(raw);
  const exact: TransactionInstants = {
    acceptedAt: instants.acceptedAtMicros,
    availableAt: instants.availableAtMicros,
    pendingDeadlineAt: instants.pendingDeadlineAtMicros,
  };
  return { row: parseTransactionRow(raw), instants: exact };
}

/** Lista de colunas com os aliases da linha neutra (contrato desta consulta). */
export const TRANSACTION_COLUMNS = `
  id::text AS "id", provider_id AS "providerId", external_transaction_id AS "externalTransactionId",
  idempotency_key AS "idempotencyKey", payload_hash AS "payloadHash", wallet_id::text AS "walletId",
  player_id::text AS "playerId", round_id AS "roundId", game_id AS "gameId", kind, currency,
  amount::text AS "amount", reference_external_transaction_id AS "referenceExternalTransactionId",
  reference_transaction_id::text AS "referenceTransactionId", status, failure_code AS "failureCode",
  initial_status AS "initialStatus", accepted_balance::text AS "acceptedBalance",
  accepted_wallet_version::text AS "acceptedWalletVersion", accepted_at AS "acceptedAt",
  result_balance::text AS "resultBalance", result_wallet_version::text AS "resultWalletVersion",
  decided_at AS "decidedAt", available_at AS "availableAt",
  pending_deadline_at AS "pendingDeadlineAt", correlation_id AS "correlationId", created_at AS "createdAt"`;
