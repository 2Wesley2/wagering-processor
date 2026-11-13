import type { MikroORM } from '@mikro-orm/postgresql';
import { LedgerEntryRecord, WalletRecord } from '../../../platform/persistence/records.ts';
import type { LedgerEntryView, WalletQueries, WalletView } from '../application/ports.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Leituras com os records do MikroORM, sempre num fork novo (nada de Identity
 * Map compartilhado entre requisições). Dinheiro chega do banco como string.
 */
export class OrmWalletQueries implements WalletQueries {
  constructor(private readonly orm: MikroORM) {}

  async findById(walletId: string): Promise<WalletView | undefined> {
    if (!UUID_RE.test(walletId)) return undefined;
    const wallet = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (wallet === null) return undefined;
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: { amount: wallet.balance, currency: wallet.currency },
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  async findIdByPlayerAndCurrency(playerId: string, currency: string): Promise<string | undefined> {
    const wallet = await this.orm.em.fork().findOne(WalletRecord, { playerId, currency }, { fields: ['id'] });
    return wallet?.id;
  }

  async ledgerAfter(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]> {
    const rows = await this.orm.em
      .fork()
      .find(
        LedgerEntryRecord,
        { walletId, walletVersion: { $gt: afterVersion } },
        { orderBy: { walletVersion: 'asc' }, limit },
      );
    return rows.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      direction: entry.direction === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      money: { amount: entry.amount, currency: entry.currency },
      balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
      balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}
