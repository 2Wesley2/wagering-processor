import { describe, expect, test } from 'bun:test';
import { PreconditionError } from '../../src/shared/errors.ts';
import { CurrencyMismatchError, Money } from '../../src/shared/money.ts';
import { BalanceLimitExceededError, InsufficientFundsError, Wallet } from '../../src/modules/wallet/domain/wallet.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-11T12:00:00.000Z');
let seq = 0;
const nextMovementIds = () => ({ transactionId: `tx-${++seq}`, entryId: `le-${seq}`, at });

function open(initial: string): Wallet {
  return Wallet.open({
    id: 'w1',
    playerId: 'p1',
    initialBalance: brl(initial),
    at,
    opening: { transactionId: 'open-1', entryId: 'le-open' },
  });
}

describe('[UT-03] Wallet: abertura, débito, crédito e versão', () => {
  test('[UT-03] abertura com 0.00: version 1 e nenhum lançamento', () => {
    const wallet = Wallet.open({ id: 'w0', playerId: 'p0', initialBalance: brl('0.00'), at });
    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(wallet.peekLedgerEntries()).toEqual([]);
  });

  test('[UT-03] abertura com saldo: lançamento CREDIT 0.00 → 100.00 em walletVersion 1', () => {
    const wallet = open('100.00');
    expect(wallet.version).toBe(1);
    const [entry] = wallet.pullLedgerEntries();
    expect(entry?.direction).toBe('CREDIT');
    expect(entry?.balanceBefore.toString()).toBe('0.00');
    expect(entry?.balanceAfter.toString()).toBe('100.00');
    expect(entry?.walletVersion).toBe(1);
    expect(entry?.transactionId).toBe('open-1');
    expect(wallet.pullLedgerEntries()).toEqual([]);
  });

  test('[UT-03] saldo inicial > 0 sem ids da OPENING é erro de chamada', () => {
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at })).toThrow(PreconditionError);
  });

  test('[UT-03] débito e crédito movem saldo, geram 1 lançamento cada e sobem a versão em 1', () => {
    const wallet = open('100.00');
    wallet.pullLedgerEntries();
    const d = wallet.debit(brl('30.00'), nextMovementIds());
    expect([wallet.balance.toString(), wallet.version]).toEqual(['70.00', 2]);
    expect([d.balanceBefore.toString(), d.balanceAfter.toString(), d.walletVersion]).toEqual(['100.00', '70.00', 2]);
    const credit = wallet.credit(brl('5.50'), nextMovementIds());
    expect([wallet.balance.toString(), wallet.version, credit.walletVersion]).toEqual(['75.50', 3, 3]);
    wallet.debit(brl('75.50'), nextMovementIds());
    expect([wallet.balance.toString(), wallet.version]).toEqual(['0.00', 4]);
    expect(wallet.pullLedgerEntries().map((e) => e.walletVersion)).toEqual([2, 3, 4]);
  });

  test('[UT-03] débito acima do saldo é rejeitado sem alterar estado', () => {
    const wallet = open('10.00');
    expect(() => wallet.debit(brl('10.01'), nextMovementIds())).toThrow(InsufficientFundsError);
    expect([wallet.balance.toString(), wallet.version, wallet.peekLedgerEntries().length]).toEqual(['10.00', 1, 1]);
  });

  test('[UT-03] crédito acima do máximo é rejeitado sem alterar estado', () => {
    const wallet = open('999999999999999.00');
    wallet.credit(brl('0.99'), nextMovementIds());
    expect(wallet.balance.toString()).toBe('999999999999999.99');
    expect(() => wallet.credit(brl('0.01'), nextMovementIds())).toThrow(BalanceLimitExceededError);
    expect(wallet.version).toBe(2);
  });

  test('[UT-03] moeda divergente e valor zero', () => {
    const wallet = open('10.00');
    expect(() => wallet.debit(Money.from({ amount: '1.00', currency: 'USD' }), nextMovementIds())).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit(brl('0.00'), nextMovementIds())).toThrow(PreconditionError);
  });

  test('[UT-03] cenário do §8 em memória: 100.00 e duas apostas de 80.00 → 1 débito, saldo 20.00', () => {
    const wallet = open('100.00');
    wallet.pullLedgerEntries();
    const outcomes = [brl('80.00'), brl('80.00')].map((stake) => {
      if (!wallet.canDebit(stake)) return 'REJECTED';
      wallet.debit(stake, nextMovementIds());
      return 'PROCESSED';
    });
    expect(outcomes).toEqual(['PROCESSED', 'REJECTED']);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.pullLedgerEntries()).toHaveLength(1);
  });

  test('[UT-03] rehydrate não revalida e preserva versão e saldo', () => {
    const wallet = Wallet.rehydrate({
      id: 'w9',
      playerId: 'p9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect([wallet.balance.toString(), wallet.version]).toEqual(['42.00', 7]);
    wallet.credit(brl('1.00'), nextMovementIds());
    expect(wallet.version).toBe(8);
  });
});
