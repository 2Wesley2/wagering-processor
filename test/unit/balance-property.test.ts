import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { BalanceLimitExceededError, InsufficientFundsError, Wallet } from '../../src/modules/wallet/domain/wallet.ts';
import { Money } from '../../src/shared/money.ts';
import { centsOf, ModelWallet, textOf } from '../support/model.ts';

const AT = new Date('2026-11-11T12:00:00.000Z');
const SEED = 20_261_111;

const opArb = fc.record({
  direction: fc.constantFrom('DEBIT' as const, 'CREDIT' as const),
  cents: fc.oneof(fc.bigInt({ min: 1n, max: 10_000n }), fc.bigInt({ min: 1n, max: 99_999_999_999_999_999n })),
});

describe('[UT-11] propriedade: saldo == Σ ledger e igual ao modelo de referência', () => {
  test('[UT-11] sequências aleatórias de débitos e créditos', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), fc.array(opArb, { maxLength: 60 }), (initialCents, ops) => {
        const model = new ModelWallet(initialCents);
        const wallet = Wallet.open({
          id: 'w',
          playerId: 'p',
          initialBalance: Money.fromMinor(initialCents, 'BRL'),
          at: AT,
          opening: { transactionId: 'open', entryId: 'le-open' },
        });
        let n = 0;
        for (const op of ops) {
          const money = Money.fromMinor(op.cents, 'BRL');
          const expected = model.apply(op.direction, op.cents);
          let applied = true;
          try {
            const movementIds = { transactionId: `tx-${n}`, entryId: `le-${n}`, at: AT };
            if (op.direction === 'DEBIT') wallet.debit(money, movementIds);
            else wallet.credit(money, movementIds);
          } catch (error) {
            if (!(error instanceof InsufficientFundsError || error instanceof BalanceLimitExceededError)) throw error;
            applied = false;
          }
          n += 1;
          expect(applied).toBe(expected);
        }
        const entries = wallet.pullLedgerEntries();
        expect(wallet.balance.toString()).toBe(textOf(model.balance));
        expect(wallet.version).toBe(model.version);
        // Σ ledger calculada a partir das strings serializadas, sem Money.
        let sum = 0n;
        for (const entry of entries)
          sum += entry.direction === 'CREDIT' ? centsOf(entry.money.toString()) : -centsOf(entry.money.toString());
        expect(textOf(sum)).toBe(textOf(model.ledgerSum()));
        expect(textOf(sum)).toBe(wallet.balance.toString());
        // Cadeia: versões contíguas e before(v) = after(v-1).
        entries.forEach((entry, i) => {
          expect(entry.walletVersion).toBe(model.entries[i]?.version ?? -1);
          if (i > 0)
            expect(entry.balanceBefore.toString()).toBe(entries[i - 1]?.balanceAfter.toString() ?? '<ausente>');
        });
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
