import { z } from 'zod';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import { Money } from '../../../shared/money.ts';
import { isUniqueViolation } from '../../../platform/persistence/pg-errors.ts';
import { toTransactionSql } from '../../../platform/persistence/unit-of-work.ts';
import { DuplicateWalletError, type WalletRepository, WalletVersionMismatchError } from '../application/ports.ts';
import type { WalletLedgerEntry } from '../domain/ledger-entry.ts';
import { Wallet } from '../domain/wallet.ts';

/** Linha de `wallets` lida sob lock; dinheiro e versão chegam como texto (nunca number) e são validados. */
const lockedWalletRowSchema = z.object({
  id: z.string(),
  playerId: z.string(),
  currency: z.string(),
  balance: z.string(),
  version: z.string().regex(/^[1-9]\d{0,15}$/),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** Escrita da wallet e do ledger com SQL explícito (D19, D23). Valores monetários sempre como string. */
export class SqlWalletRepository implements WalletRepository {
  async insert(databaseTransaction: DatabaseTransaction, wallet: Wallet): Promise<void> {
    try {
      await toTransactionSql(databaseTransaction).run(
        `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?::numeric, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_uq')) throw new DuplicateWalletError();
      throw error;
    }
  }

  async insertLedgerEntries(
    databaseTransaction: DatabaseTransaction,
    entries: readonly WalletLedgerEntry[],
  ): Promise<void> {
    const sql = toTransactionSql(databaseTransaction);
    for (const entry of entries) {
      await sql.run(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric, ?, ?)`,
        [
          entry.id,
          entry.walletId,
          entry.transactionId,
          entry.money.currency,
          entry.direction,
          entry.money.toString(),
          entry.balanceBefore.toString(),
          entry.balanceAfter.toString(),
          entry.walletVersion,
          entry.createdAt,
        ],
      );
    }
  }

  async lockForUpdate(databaseTransaction: DatabaseTransaction, walletId: string): Promise<Wallet | undefined> {
    // O lock evita que duas apostas decidam com o mesmo saldo da wallet.
    const raw = await toTransactionSql(databaseTransaction).one<unknown>(
      `SELECT id::text AS "id", player_id::text AS "playerId", currency, balance::text AS "balance",
              version::text AS "version", created_at AS "createdAt", updated_at AS "updatedAt"
         FROM wallets WHERE id = ? FOR UPDATE`,
      [walletId],
    );
    if (raw === undefined) return undefined;
    // rehydrate reconstrói o estado persistido; a leitura só valida formato e conversão (§6.0).
    const row = lockedWalletRowSchema.parse(raw);
    return Wallet.rehydrate({
      id: row.id,
      playerId: row.playerId,
      currency: row.currency,
      balance: Money.parseStored(row.balance, row.currency),
      version: Number.parseInt(row.version, 10),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async saveBalance(databaseTransaction: DatabaseTransaction, wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await toTransactionSql(databaseTransaction).run(
      `UPDATE wallets SET balance = ?::numeric, version = ?, updated_at = ? WHERE id = ? AND version = ?`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (affected !== 1) throw new WalletVersionMismatchError(wallet.id, expectedVersion);
  }
}
