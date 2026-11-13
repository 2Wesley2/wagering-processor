import { hashV1 } from '../../../shared/canonical-json.ts';
import type { IdGenerator, DatabaseTransaction } from '../../../shared/ports.ts';
import type { OpeningRecorder } from '../../wallet/application/ports.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/ledger-entry.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { SqlOutboxRepository } from '../../messaging/infrastructure/sql-outbox-repository.ts';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';
import type { SqlTransactionRepository } from './sql-transaction-repository.ts';

/**
 * OPENING interna (§9, D06): transação PROCESSED, mais os eventos
 * WagerTransactionProcessed e WalletBalanceChanged na outbox, tudo na mesma
 * transação SQL da criação da wallet.
 */
export class SqlOpeningRecorder implements OpeningRecorder {
  constructor(
    private readonly transactions: SqlTransactionRepository,
    private readonly outbox: SqlOutboxRepository,
    private readonly idGenerator: IdGenerator,
  ) {}

  async record(
    databaseTransaction: DatabaseTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: { correlationId: string; at: Date },
  ): Promise<void> {
    const opening = WagerTransaction.createOpening({
      id: entry.transactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: entry.money,
      payloadHash: hashV1({
        kind: 'OPENING',
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: entry.money.toJSON(),
      }),
      createdAt: context.at,
    });
    await this.transactions.insertDecided(
      databaseTransaction,
      opening,
      { balance: entry.balanceAfter, walletVersion: entry.walletVersion },
      context.correlationId,
    );
    const eventCtx = (eventId: string) => ({ eventId, correlationId: context.correlationId, occurredAt: context.at });
    await this.outbox.append(databaseTransaction, [
      WagerTransactionProcessed.from(opening, wallet, eventCtx(this.idGenerator.next())),
      WalletBalanceChanged.from(wallet, entry, eventCtx(this.idGenerator.next())),
    ]);
  }
}
