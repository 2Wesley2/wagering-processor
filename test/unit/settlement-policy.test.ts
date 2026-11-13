import { describe, expect, test } from 'bun:test';
import { PreconditionError } from '../../src/shared/errors.ts';
import {
  EMPTY_REVERSAL_VIEW,
  ReversalRuleUndecidedError,
  type SettlementDecision,
  SettlementPolicy,
  UNDECIDED_REVERSAL_RULE,
} from '../../src/modules/wagering/domain/settlement-policy.ts';
import type { WagerKind, WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.ts';
import { pending, stored, wallet } from '../support/factories.ts';

/**
 * Oráculos fixos (D58): os desfechos esperados foram escritos à mão a partir do
 * §7 e da tabela de precedência do plano; nenhum é calculado com código de src/.
 */
const policy = new SettlementPolicy();

function decide(transaction: WagerTransaction, balance: string, reference?: WagerTransaction): SettlementDecision {
  return policy.decide(transaction, { wallet: wallet(balance), reference, view: EMPTY_REVERSAL_VIEW });
}

const bet = (amount = '10.00', options = {}) =>
  stored('BET', amount, 'PROCESSED', { externalId: 'b1', id: 'id-b1', ...options });

describe('[UT-05a] SettlementPolicy: linhas comuns a todas as opções de P1/P2', () => {
  test('[UT-05a] linha 5: referência ausente ou pendente → AWAIT_REFERENCE', () => {
    expect(decide(pending('REFUND', '10.00', { referenceExternalId: 'b1' }), '90.00')).toEqual({
      type: 'AWAIT_REFERENCE',
    });
    const pendingRef = stored('REFUND', '10.00', 'PENDING_REFERENCE', { externalId: 'r0', referenceExternalId: 'b0' });
    expect(decide(pending('ROLLBACK', '10.00', { referenceExternalId: 'r0' }), '90.00', pendingRef)).toEqual({
      type: 'AWAIT_REFERENCE',
    });
    expect(decide(pending('WIN', '30.00', { referenceExternalId: 'b1' }), '90.00')).toEqual({
      type: 'AWAIT_REFERENCE',
    });
  });

  test('[UT-05a] linha 6: escopo divergente (provider, player, wallet, moeda, rodada) → REFERENCE_SCOPE_MISMATCH', () => {
    const refund = pending('REFUND', '10.00', { referenceExternalId: 'b1' });
    for (const options of [
      { roundId: 'round-2' },
      { providerId: 'provider-b' },
      { playerId: 'p2' },
      { walletId: 'w2' },
    ]) {
      expect(decide(refund, '90.00', bet('10.00', options))).toEqual({
        type: 'REJECT',
        code: 'REFERENCE_SCOPE_MISMATCH',
      });
    }
    expect(decide(refund, '90.00', bet('10.00', { currency: 'USD' }))).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_SCOPE_MISMATCH',
    });
  });

  test('[UT-05a] linha 7: kind incompatível → INVALID_REFERENCE_KIND', () => {
    const win = stored('WIN', '10.00', 'PROCESSED', { externalId: 'w1x' });
    expect(decide(pending('REFUND', '10.00', { referenceExternalId: 'w1x' }), '90.00', win)).toEqual({
      type: 'REJECT',
      code: 'INVALID_REFERENCE_KIND',
    });
    expect(decide(pending('WIN', '10.00', { referenceExternalId: 'w1x' }), '90.00', win)).toEqual({
      type: 'REJECT',
      code: 'INVALID_REFERENCE_KIND',
    });
  });

  test('[UT-05a] linha 8: referência REJECTED ou FAILED → REFERENCE_NOT_PROCESSED', () => {
    for (const status of ['REJECTED', 'FAILED'] as const) {
      const reference = stored('BET', '10.00', status, { externalId: 'b1' });
      expect(decide(pending('REFUND', '10.00', { referenceExternalId: 'b1' }), '100.00', reference)).toEqual({
        type: 'REJECT',
        code: 'REFERENCE_NOT_PROCESSED',
      });
    }
  });

  test('[UT-05a] linha 9: valor diferente da referência → REFERENCE_AMOUNT_MISMATCH', () => {
    expect(decide(pending('REFUND', '9.99', { referenceExternalId: 'b1' }), '90.00', bet())).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
    expect(decide(pending('ROLLBACK', '10.01', { referenceExternalId: 'b1' }), '90.00', bet())).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
  });

  test('[UT-05a] linha 11: BET sem saldo → INSUFFICIENT_FUNDS; saldo exato é aceito', () => {
    expect(decide(pending('BET', '100.01'), '100.00')).toEqual({ type: 'REJECT', code: 'INSUFFICIENT_FUNDS' });
    expect(decide(pending('BET', '100.00'), '100.00')).toEqual({
      type: 'APPLY',
      direction: 'DEBIT',
      referenceTransactionId: undefined,
    });
  });

  test('[UT-05a] linha 12: ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS (código distinto)', () => {
    const win = stored('WIN', '30.00', 'PROCESSED', { externalId: 'win1', id: 'id-win1' });
    expect(decide(pending('ROLLBACK', '30.00', { referenceExternalId: 'win1' }), '20.00', win)).toEqual({
      type: 'REJECT',
      code: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(decide(pending('ROLLBACK', '30.00', { referenceExternalId: 'win1' }), '30.00', win)).toEqual({
      type: 'APPLY',
      direction: 'DEBIT',
      referenceTransactionId: 'id-win1',
    });
  });

  test('[UT-05a] linha 13: crédito acima do máximo → BALANCE_LIMIT_EXCEEDED', () => {
    expect(decide(pending('WIN', '0.02'), '999999999999999.98')).toEqual({
      type: 'REJECT',
      code: 'BALANCE_LIMIT_EXCEEDED',
    });
    expect(decide(pending('WIN', '0.01'), '999999999999999.98')).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: undefined,
    });
  });

  test('[UT-05a] linha 14: aplicação por kind; LOSS sem lançamento', () => {
    expect(decide(pending('LOSS', '0.00', { referenceExternalId: 'b1' }), '90.00', bet())).toEqual({
      type: 'APPLY',
      direction: null,
      referenceTransactionId: 'id-b1',
    });
    expect(decide(pending('WIN', '30.00'), '90.00')).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: undefined,
    });
    expect(decide(pending('WIN', '30.00', { referenceExternalId: 'b1' }), '90.00', bet())).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: 'id-b1',
    });
  });

  test('[UT-05a] precedência: escopo antes de kind; valor antes de saldo', () => {
    const otherRoundWin = stored('WIN', '10.00', 'PROCESSED', { externalId: 'w9', roundId: 'round-9' });
    expect(decide(pending('REFUND', '10.00', { referenceExternalId: 'w9' }), '0.00', otherRoundWin)).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_SCOPE_MISMATCH',
    });
    const win = stored('WIN', '30.00', 'PROCESSED', { externalId: 'w8' });
    expect(decide(pending('ROLLBACK', '31.00', { referenceExternalId: 'w8' }), '0.00', win)).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
  });

  test('[UT-05a] as linhas de P1/P2 ficam numa regra plugável; sem regra decidida, o caso falha alto', () => {
    const view = { reversals: [{ kind: 'REFUND' as const, undone: false }], settledByWin: false };
    expect(() =>
      new SettlementPolicy(UNDECIDED_REVERSAL_RULE).decide(
        pending('ROLLBACK', '10.00', { referenceExternalId: 'b1' }),
        {
          wallet: wallet('100.00'),
          reference: bet(),
          view,
        },
      ),
    ).toThrow(ReversalRuleUndecidedError);
  });

  test('[UT-05a] wallet, player ou moeda divergentes são pré-condição (barrados antes, sem persistir)', () => {
    expect(() => decide(pending('BET', '1.00', { walletId: 'w2' }), '10.00')).toThrow(PreconditionError);
    expect(() => decide(pending('BET', '1.00', { playerId: 'p2' }), '10.00')).toThrow(PreconditionError);
    expect(() => decide(pending('BET', '1.00', { currency: 'USD' }), '10.00')).toThrow(PreconditionError);
  });
});

describe('[RV-UT-02a] reversões: matriz comum a todas as opções (regra 3, valor, escopo, regra 9)', () => {
  // Esperado escrito à mão a partir do §7 regra 3: REFUND → BET; ROLLBACK → BET, WIN, REFUND.
  const matrix: [WagerKind, WagerKind, 'CREDIT' | 'DEBIT' | 'INVALID_REFERENCE_KIND'][] = [
    ['REFUND', 'BET', 'CREDIT'],
    ['REFUND', 'WIN', 'INVALID_REFERENCE_KIND'],
    ['REFUND', 'LOSS', 'INVALID_REFERENCE_KIND'],
    ['REFUND', 'REFUND', 'INVALID_REFERENCE_KIND'],
    ['REFUND', 'ROLLBACK', 'INVALID_REFERENCE_KIND'],
    ['REFUND', 'OPENING', 'INVALID_REFERENCE_KIND'],
    ['ROLLBACK', 'BET', 'CREDIT'],
    ['ROLLBACK', 'WIN', 'DEBIT'],
    ['ROLLBACK', 'REFUND', 'DEBIT'],
    ['ROLLBACK', 'LOSS', 'INVALID_REFERENCE_KIND'],
    ['ROLLBACK', 'ROLLBACK', 'INVALID_REFERENCE_KIND'],
    ['ROLLBACK', 'OPENING', 'INVALID_REFERENCE_KIND'],
  ];

  test('[RV-UT-02a] primeira reversão por (kind da reversão × kind do alvo)', () => {
    for (const [reversal, target, expected] of matrix) {
      const reference = stored(target, '10.00', 'PROCESSED', {
        externalId: 't1',
        id: 'id-t1',
        referenceExternalId: target === 'REFUND' || target === 'ROLLBACK' ? 'b0' : undefined,
      });
      const outcome = decide(pending(reversal, '10.00', { referenceExternalId: 't1' }), '50.00', reference);
      const got = describeOutcome(outcome);
      expect({ reversal, target, got }).toEqual({ reversal, target, got: expected });
    }
  });

  test('[RV-UT-02a] valor igual é exigido em REFUND e ROLLBACK', () => {
    expect(decide(pending('REFUND', '10.00', { referenceExternalId: 'b1' }), '90.00', bet()).type).toBe('APPLY');
    expect(decide(pending('REFUND', '10.10', { referenceExternalId: 'b1' }), '90.00', bet())).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_AMOUNT_MISMATCH',
    });
  });

  test('[RV-UT-02a] escopo: reversão de outra rodada é rejeitada', () => {
    expect(
      decide(pending('ROLLBACK', '10.00', { referenceExternalId: 'b1', roundId: 'round-2' }), '90.00', bet()),
    ).toEqual({
      type: 'REJECT',
      code: 'REFERENCE_SCOPE_MISMATCH',
    });
  });

  test('[RV-UT-02a] regra 9: ROLLBACK de REFUND sem saldo → REVERSAL_INSUFFICIENT_FUNDS; BET sem saldo → INSUFFICIENT_FUNDS', () => {
    const refund = stored('REFUND', '10.00', 'PROCESSED', { externalId: 'r1', id: 'id-r1', referenceExternalId: 'b1' });
    expect(decide(pending('ROLLBACK', '10.00', { referenceExternalId: 'r1' }), '9.99', refund)).toEqual({
      type: 'REJECT',
      code: 'REVERSAL_INSUFFICIENT_FUNDS',
    });
    expect(decide(pending('BET', '10.00'), '9.99')).toEqual({ type: 'REJECT', code: 'INSUFFICIENT_FUNDS' });
  });
});

function describeOutcome(outcome: SettlementDecision): string | null {
  if (outcome.type === 'APPLY') return outcome.direction;
  if (outcome.type === 'REJECT') return outcome.code;
  return outcome.type;
}
