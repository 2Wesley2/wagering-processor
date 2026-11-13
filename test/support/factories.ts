/**
 * Construtores de cenário para testes de unidade. Montam objetos de produção;
 * NÃO calculam resultados esperados (os oráculos são valores fixos, D58).
 */
import { Money } from '../../src/shared/money.ts';
import { Wallet } from '../../src/modules/wallet/domain/wallet.ts';
import {
  type WagerKind,
  type WagerStatus,
  WagerTransaction,
} from '../../src/modules/wagering/domain/wager-transaction.ts';

export const AT = new Date('2026-11-11T12:00:00.000Z');
export const HASH = `v1:${'a'.repeat(64)}`;
export const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

export function wallet(balance: string, options: { id?: string; playerId?: string; currency?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: options.id ?? 'w1',
    playerId: options.playerId ?? 'p1',
    currency: options.currency ?? 'BRL',
    balance: Money.from({ amount: balance, currency: options.currency ?? 'BRL' }),
    version: 1,
    createdAt: AT,
    updatedAt: AT,
  });
}

export interface TxOpts {
  id?: string;
  externalId?: string;
  referenceExternalId?: string | undefined;
  providerId?: string;
  playerId?: string;
  walletId?: string;
  roundId?: string;
  currency?: string;
}

/** Transação nova (PENDING) via factory de produção. */
export function pending(kind: WagerKind, amount: string, options: TxOpts = {}): WagerTransaction {
  const externalTransactionId = options.externalId ?? `${kind.toLowerCase()}-${amount}`;
  return WagerTransaction.create({
    id: options.id ?? `id-${externalTransactionId}`,
    providerId: options.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: options.walletId ?? 'w1',
    playerId: options.playerId ?? 'p1',
    roundId: options.roundId ?? 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount, currency: options.currency ?? 'BRL' }),
    referenceExternalTransactionId: options.referenceExternalId,
    createdAt: AT,
  });
}

/** Transação persistida em um status qualquer (como viria do repositório). */
export function stored(kind: WagerKind, amount: string, status: WagerStatus, options: TxOpts = {}): WagerTransaction {
  const externalTransactionId = options.externalId ?? `${kind.toLowerCase()}-${amount}`;
  return WagerTransaction.rehydrate({
    id: options.id ?? `id-${externalTransactionId}`,
    providerId: options.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: options.walletId ?? 'w1',
    playerId: options.playerId ?? 'p1',
    roundId: options.roundId ?? 'round-1',
    gameId: 'game-1',
    kind,
    money: Money.from({ amount, currency: options.currency ?? 'BRL' }),
    referenceExternalTransactionId: options.referenceExternalId,
    createdAt: AT,
    status,
    referenceTransactionId: undefined,
    failureCode: status === 'REJECTED' ? 'INSUFFICIENT_FUNDS' : undefined,
    decidedAt: status === 'PENDING_REFERENCE' ? undefined : AT,
  });
}
