import type { RejectionCode } from '../../../shared/error-catalog.ts';
import { Money, type MoneyProps } from '../../../shared/money.ts';
import {
  isRejectionCode,
  isTransactionFailureCode,
  isWagerKind,
  isWagerStatus,
  WagerTransaction,
} from '../domain/wager-transaction.ts';
import type { TransactionRow } from './ports.ts';

/** Status possíveis da primeira resposta (`initial_status`). */
export type OriginalStatus = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE';

export function isOriginalStatus(value: unknown): value is OriginalStatus {
  return value === 'PROCESSED' || value === 'REJECTED' || value === 'PENDING_REFERENCE';
}

/**
 * Resposta original de uma submissão (I1 = opção A). O replay devolve exatamente isto, trocando
 * apenas `idempotentReplay`.
 */
export interface OriginalResponse {
  readonly transactionId: string;
  readonly status: OriginalStatus;
  /** Saldo observado no aceite (`accepted_balance`). */
  readonly balance: MoneyProps;
  /** Só quando a primeira resposta foi REJECTED. */
  readonly failureCode: RejectionCode | undefined;
  /** correlationId da primeira requisição, gravado na transação. */
  readonly correlationId: string;
}

export class InvalidStoredTransactionError extends Error {
  constructor(transactionId: string, field: string) {
    super(`transação ${transactionId} gravada com ${field} fora do formato`);
    this.name = 'InvalidStoredTransactionError';
  }
}

export function originalResponseOf(row: TransactionRow): OriginalResponse {
  if (!isOriginalStatus(row.initialStatus)) throw new InvalidStoredTransactionError(row.id, 'initial_status');
  let failureCode: RejectionCode | undefined;
  if (row.initialStatus === 'REJECTED') {
    // Rejeição decidida na chegada é terminal desde o início: failure_code é o original.
    if (!isRejectionCode(row.failureCode)) throw new InvalidStoredTransactionError(row.id, 'failure_code');
    failureCode = row.failureCode;
  }
  // Só dados imutáveis da primeira decisão: o replay mantém o 202 original mesmo depois de o
  // worker resolver a pendência.
  return {
    transactionId: row.id,
    status: row.initialStatus,
    balance: Money.parseStored(row.acceptedBalance, row.currency).toJSON(),
    failureCode,
    correlationId: row.correlationId,
  };
}

/** Reconstrói a transação gravada (§6.0): valida formato e enums, sem reprocessar transições. */
export function rehydrateTransaction(row: TransactionRow): WagerTransaction {
  if (!isWagerKind(row.kind)) throw new InvalidStoredTransactionError(row.id, 'kind');
  if (!isWagerStatus(row.status)) throw new InvalidStoredTransactionError(row.id, 'status');
  const failureCode = row.failureCode ?? undefined;
  if (failureCode !== undefined && !isTransactionFailureCode(failureCode)) {
    throw new InvalidStoredTransactionError(row.id, 'failure_code');
  }
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind,
    money: Money.parseStored(row.amount, row.currency),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode,
    decidedAt: row.decidedAt ?? undefined,
  });
}

/**
 * Estado atual de uma transação (GETs, D29): status e, quando terminal, o saldo histórico da
 * decisão; para auditoria, o status e o saldo do aceite. Nunca o saldo atual da wallet.
 */
export interface TransactionView {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly balance: MoneyProps | null;
  readonly walletVersion: number | null;
  readonly decidedAt: string | null;
  readonly initialStatus: string;
  readonly acceptedBalance: MoneyProps;
  readonly acceptedWalletVersion: number;
  readonly acceptedAt: string;
  readonly createdAt: string;
}

export function transactionViewOf(row: TransactionRow): TransactionView {
  const transaction = rehydrateTransaction(row);
  if (!isOriginalStatus(row.initialStatus)) throw new InvalidStoredTransactionError(row.id, 'initial_status');
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: row.referenceExternalTransactionId,
    referenceTransactionId: row.referenceTransactionId,
    status: transaction.status,
    failureCode: row.failureCode,
    balance: row.resultBalance === null ? null : Money.parseStored(row.resultBalance, row.currency).toJSON(),
    walletVersion: row.resultWalletVersion,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    initialStatus: row.initialStatus,
    acceptedBalance: Money.parseStored(row.acceptedBalance, row.currency).toJSON(),
    acceptedWalletVersion: row.acceptedWalletVersion,
    acceptedAt: row.acceptedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
