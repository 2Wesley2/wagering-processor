import { type EventContext, IntegrationEvent } from '../../../shared/integration-event.ts';
import type { MoneyProps } from '../../../shared/money.ts';
import type { LedgerDirection, WalletLedgerEntry } from '../../wallet/domain/ledger-entry.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WagerTransaction } from './wager-transaction.ts';

function props<T>(aggregateId: string, eventContext: EventContext, data: T) {
  return {
    eventId: eventContext.eventId,
    aggregateId,
    correlationId: eventContext.correlationId,
    ...(eventContext.causationId === undefined ? {} : { causationId: eventContext.causationId }),
    occurredAt: eventContext.occurredAt,
    data,
  };
}

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(transaction: WagerTransaction): TransactionData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: transaction.referenceExternalTransactionId }),
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  /** Saldo e versão da wallet observados na decisão (LOSS: inalterados). */
  balance: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, wallet: Wallet, eventContext: EventContext): WagerTransactionProcessed {
    if (transaction.status !== 'PROCESSED') throw new Error('WagerTransactionProcessed exige transação PROCESSED');
    return new WagerTransactionProcessed(
      props(transaction.walletId, eventContext, {
        ...transactionData(transaction),
        ...(transaction.referenceTransactionId === undefined
          ? {}
          : { referenceTransactionId: transaction.referenceTransactionId }),
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: string;
  balance: MoneyProps;
  walletVersion: number;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, wallet: Wallet, eventContext: EventContext): WagerTransactionRejected {
    if (transaction.status !== 'REJECTED' || transaction.failureCode === undefined)
      throw new Error('WagerTransactionRejected exige REJECTED');
    return new WagerTransactionRejected(
      props(transaction.walletId, eventContext, {
        ...transactionData(transaction),
        failureCode: transaction.failureCode,
        balance: wallet.balance.toJSON(),
        walletVersion: wallet.version,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, eventContext: EventContext): WagerTransactionPendingReference {
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (transaction.status !== 'PENDING_REFERENCE' || referenceExternalTransactionId === undefined)
      throw new Error('evento exige PENDING_REFERENCE');
    return new WagerTransactionPendingReference(
      props(transaction.walletId, eventContext, {
        ...transactionData(transaction),
        referenceExternalTransactionId: referenceExternalTransactionId,
      }),
    );
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  /** Um por lançamento: só existe quando o saldo muda (§11). */
  static from(wallet: Wallet, entry: WalletLedgerEntry, eventContext: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) throw new Error('lançamento de outra wallet');
    return new WalletBalanceChanged(
      props(wallet.id, eventContext, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
