import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError, WalletLedgerEntry } from '../../src/modules/wallet/domain/ledger-entry.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/modules/wagering/domain/events.ts';
import { Wallet } from '../../src/modules/wallet/domain/wallet.ts';
import { AT, brl, pending } from '../support/factories.ts';

const base = {
  id: 'le-1',
  walletId: 'w1',
  transactionId: 'tx-1',
  direction: 'DEBIT' as const,
  money: brl('25.00'),
  balanceBefore: brl('1000.00'),
  balanceAfter: brl('975.00'),
  walletVersion: 2,
  createdAt: AT,
};
const eventContext = { eventId: 'ev-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: AT };

describe('[UT-06] WalletLedgerEntry e eventos de integração', () => {
  test('[UT-06] lançamento válido é balanceado e estruturalmente imutável', () => {
    const entry = WalletLedgerEntry.create(base);
    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    // Objeto congelado: a escrita é recusada e o valor permanece.
    expect(Reflect.set(entry, 'walletVersion', 9)).toBe(false);
    expect(entry.walletVersion).toBe(2);
  });

  test('[UT-06] create recusa aritmética errada, valor zero, saldo negativo, moeda e versão inválidas', () => {
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl('975.01') })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, direction: 'CREDIT' })).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, money: brl('0.00'), balanceAfter: brl('1000.00') })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00').subtract(brl('25.00')),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() => WalletLedgerEntry.create({ ...base, walletVersion: 0 })).toThrow(InvalidLedgerEntryError);
  });

  test('[UT-06] WalletBalanceChanged carrega MoneyProps (strings) e o envelope serializado', () => {
    const wallet = Wallet.open({
      id: 'w1',
      playerId: 'p1',
      initialBalance: brl('1000.00'),
      at: AT,
      opening: { transactionId: 'o', entryId: 'le-o' },
    });
    const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'le-1', at: AT });
    const event = WalletBalanceChanged.from(wallet, entry, eventContext);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.toJSON()).toEqual({
      eventId: 'ev-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-11-11T12:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w1',
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '1000.00', currency: 'BRL' },
        balanceAfter: { amount: '975.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test('[UT-06] eventos de transação exigem o status correspondente', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: 'p1',
      currency: 'BRL',
      balance: brl('90.00'),
      version: 2,
      createdAt: AT,
      updatedAt: AT,
    });
    const processed = pending('LOSS', '0.00');
    expect(() => WagerTransactionProcessed.from(processed, wallet, eventContext)).toThrow();
    processed.markProcessed(undefined, AT);
    expect(WagerTransactionProcessed.from(processed, wallet, eventContext).toJSON().data).toMatchObject({
      kind: 'LOSS',
      balance: { amount: '90.00', currency: 'BRL' },
      walletVersion: 2,
    });

    const rejected = pending('BET', '100.00');
    rejected.reject('INSUFFICIENT_FUNDS', AT);
    expect(WagerTransactionRejected.from(rejected, wallet, eventContext).toJSON().data.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );

    const awaiting = pending('REFUND', '10.00', { referenceExternalId: 'b1' });
    awaiting.markPendingReference();
    const event = WagerTransactionPendingReference.from(awaiting, {
      eventId: 'ev-2',
      correlationId: 'corr-2',
      occurredAt: AT,
    });
    expect(event.toJSON().data.referenceExternalTransactionId).toBe('b1');
    expect('causationId' in event.toJSON()).toBe(false);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
  });
});
