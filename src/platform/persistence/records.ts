import { defineEntity, p } from '@mikro-orm/core';

/**
 * Records de leitura mapeados pelo MikroORM (D19), separados do domínio. Dinheiro
 * é `decimal` em modo string (nunca number); versões cabem em number (≤ 2^53).
 * O caminho financeiro NÃO usa estes records nem o Identity Map: a wallet é lida
 * com SQL explícito `FOR UPDATE` dentro da UnitOfWork (TxSql).
 */
export const WalletRecord = defineEntity({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: p.string().primary(),
    playerId: p.string(),
    currency: p.string(),
    balance: p.decimal(),
    version: p.bigint('number'),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const LedgerEntryRecord = defineEntity({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.string().primary(),
    walletId: p.string(),
    transactionId: p.string(),
    currency: p.string(),
    direction: p.string(),
    amount: p.decimal(),
    balanceBefore: p.decimal(),
    balanceAfter: p.decimal(),
    walletVersion: p.bigint('number'),
    createdAt: p.datetime(),
  },
});

/**
 * Leitura de `wager_transactions` (F3): caminho rápido de idempotência e GETs. Só colunas lidas;
 * `accept_seq` (identity) fica de fora.
 */
export const WagerTransactionRecord = defineEntity({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: p.string().primary(),
    providerId: p.string(),
    externalTransactionId: p.string(),
    idempotencyKey: p.string(),
    payloadHash: p.string(),
    walletId: p.string(),
    playerId: p.string(),
    roundId: p.string(),
    gameId: p.string(),
    kind: p.string(),
    currency: p.string(),
    amount: p.decimal(),
    referenceExternalTransactionId: p.string().nullable(),
    referenceTransactionId: p.string().nullable(),
    status: p.string(),
    failureCode: p.string().nullable(),
    initialStatus: p.string(),
    acceptedBalance: p.decimal(),
    acceptedWalletVersion: p.bigint('number'),
    acceptedAt: p.datetime(),
    resultBalance: p.decimal().nullable(),
    resultWalletVersion: p.bigint('number').nullable(),
    decidedAt: p.datetime().nullable(),
    availableAt: p.datetime().nullable(),
    pendingDeadlineAt: p.datetime().nullable(),
    correlationId: p.string(),
    createdAt: p.datetime(),
  },
});

export const READ_ENTITIES = [WalletRecord, LedgerEntryRecord, WagerTransactionRecord];
