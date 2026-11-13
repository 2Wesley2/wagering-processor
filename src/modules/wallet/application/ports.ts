import type { MoneyProps } from '../../../shared/money.ts';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import type { WalletLedgerEntry } from '../domain/ledger-entry.ts';
import type { Wallet } from '../domain/wallet.ts';

/** Escrita transacional da wallet (SQL explícito dentro da UnitOfWork). */
export interface WalletRepository {
  insert(databaseTransaction: DatabaseTransaction, wallet: Wallet): Promise<void>;
  insertLedgerEntries(databaseTransaction: DatabaseTransaction, entries: readonly WalletLedgerEntry[]): Promise<void>;
  /** `SELECT … FOR UPDATE` da wallet (D23), reidratada sem o Identity Map; undefined se não existe. */
  lockForUpdate(databaseTransaction: DatabaseTransaction, walletId: string): Promise<Wallet | undefined>;
  /**
   * Grava saldo e versão já alterados pelo domínio, condicionados à versão lida sob o lock
   * (`WHERE version = expectedVersion`); qualquer rowcount diferente de 1 é bug e lança.
   */
  saveBalance(databaseTransaction: DatabaseTransaction, wallet: Wallet, expectedVersion: number): Promise<void>;
}

/** O UPDATE condicionado da wallet não encontrou a versão lida sob o lock: erro de programação. */
export class WalletVersionMismatchError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`wallet ${walletId} não estava na versão ${expectedVersion} ao gravar o saldo`);
    this.name = 'WalletVersionMismatchError';
  }
}

/** A unicidade (player, moeda) foi violada no banco: outra criação venceu a corrida. */
export class DuplicateWalletError extends Error {
  constructor() {
    super('wallet duplicada para (playerId, currency)');
    this.name = 'DuplicateWalletError';
  }
}

/**
 * Registra a transação interna OPENING e os eventos dela (implementada pelo
 * módulo wagering): mantém a regra de dependência wagering → wallet.
 */
export interface OpeningRecorder {
  record(
    databaseTransaction: DatabaseTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: { correlationId: string; at: Date },
  ): Promise<void>;
}

export interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyProps;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
  readonly createdAt: string;
}

/** Leituras fora da transação financeira (records do ORM). */
export interface WalletQueries {
  findById(walletId: string): Promise<WalletView | undefined>;
  findIdByPlayerAndCurrency(playerId: string, currency: string): Promise<string | undefined>;
  /** Lançamentos com wallet_version > afterVersion, em ordem crescente (keyset, D21). */
  ledgerAfter(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]>;
}

export type ReconciliationIssue =
  'BALANCE_MISMATCH' | 'HEAD_MISMATCH' | 'CHAIN_BREAK' | 'ORPHAN_ENTRY' | 'MISSING_ENTRY';

/** Fatos lidos num único snapshot REPEATABLE READ READ ONLY, sem locks (D22). */
export interface ReconciliationFacts {
  readonly currency: string;
  readonly storedBalance: string;
  readonly storedVersion: number;
  readonly calculatedBalance: string;
  readonly entries: number;
  readonly headBalance: string | undefined;
  readonly headVersion: number | undefined;
  readonly hasOpening: boolean;
  readonly chainBreaks: number;
  readonly orphanEntries: number;
  readonly missingEntries: number;
}

export interface ReconciliationReader {
  read(walletId: string): Promise<ReconciliationFacts | undefined>;
}

/** Divergências nunca são corrigidas: são logadas e contadas (§9). */
export interface ReconciliationObserver {
  divergence(walletId: string, issues: readonly ReconciliationIssue[]): void;
}
