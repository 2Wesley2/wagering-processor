import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  type ReversalView,
  type SettlementDecision,
  SettlementPolicy,
} from '../../src/modules/wagering/domain/settlement-policy.ts';
import type { WagerKind, WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction.ts';
import type { RejectionCode } from '../../src/shared/error-catalog.ts';
import type { Wallet } from '../../src/modules/wallet/domain/wallet.ts';
import { AT, pending, stored, wallet } from '../support/factories.ts';
import { centsOf } from '../support/model.ts';

/**
 * P1 = C e P2 = (c) (ARCHITECTURE.md §1) na SettlementPolicy. Oráculos fixos (D58): os desfechos
 * e saldos esperados foram escritos à mão a partir das tabelas da decisão; o teste de propriedade
 * confere invariantes contando efeitos, sem reaproveitar a política.
 */
const policy = new SettlementPolicy();

const bet = (options = {}) => stored('BET', '10.00', 'PROCESSED', { externalId: 'b1', id: 'id-b1', ...options });
const view = (reversals: ReversalView['reversals'], settledByWin = false): ReversalView => ({
  reversals,
  settledByWin,
});

function decideWith(
  transaction: WagerTransaction,
  reference: WagerTransaction,
  reversalView: ReversalView,
  balance = '90.00',
) {
  return policy.decide(transaction, { wallet: wallet(balance), reference, view: reversalView });
}

const reject = (code: RejectionCode): SettlementDecision => ({ type: 'REJECT', code });

describe('[UT-05b] linhas 10a–10c da precedência (P1 = C, P2 = (c))', () => {
  const refundOfBet = () => pending('REFUND', '10.00', { referenceExternalId: 'b1' });
  const rollbackOfBet = () => pending('ROLLBACK', '10.00', { referenceExternalId: 'b1' });

  test('[UT-05b] 10a: o mesmo tipo já reverteu o alvo, mesmo desfeito → REVERSAL_KIND_ALREADY_USED', () => {
    expect(decideWith(refundOfBet(), bet(), view([{ kind: 'REFUND', undone: true }]))).toEqual(
      reject('REVERSAL_KIND_ALREADY_USED'),
    );
    expect(decideWith(rollbackOfBet(), bet(), view([{ kind: 'ROLLBACK', undone: false }]))).toEqual(
      reject('REVERSAL_KIND_ALREADY_USED'),
    );
  });

  test('[UT-05b] 10b: outra reversão em vigor → REFERENCE_ALREADY_REVERSED; desfeita → a reversão é aceita', () => {
    expect(decideWith(rollbackOfBet(), bet(), view([{ kind: 'REFUND', undone: false }]))).toEqual(
      reject('REFERENCE_ALREADY_REVERSED'),
    );
    expect(decideWith(rollbackOfBet(), bet(), view([{ kind: 'REFUND', undone: true }]))).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: 'id-b1',
    });
  });

  test('[UT-05b] 10c: REFUND ou ROLLBACK de BET com WIN em vigor → BET_ALREADY_SETTLED', () => {
    expect(decideWith(refundOfBet(), bet(), view([], true))).toEqual(reject('BET_ALREADY_SETTLED'));
    expect(decideWith(rollbackOfBet(), bet(), view([], true))).toEqual(reject('BET_ALREADY_SETTLED'));
  });

  test('[UT-05b] 10c: WIN ou LOSS sobre BET com reversão em vigor → REFERENCED_BET_REVERSED', () => {
    const win = pending('WIN', '30.00', { referenceExternalId: 'b1' });
    const loss = pending('LOSS', '0.00', { referenceExternalId: 'b1' });
    expect(decideWith(win, bet(), view([{ kind: 'REFUND', undone: false }]))).toEqual(
      reject('REFERENCED_BET_REVERSED'),
    );
    expect(decideWith(loss, bet(), view([{ kind: 'ROLLBACK', undone: false }]))).toEqual(
      reject('REFERENCED_BET_REVERSED'),
    );
  });

  test('[UT-05b] reembolso desfeito, por si só, não impede WIN nem LOSS; vários WIN por BET continuam permitidos', () => {
    const win = pending('WIN', '30.00', { referenceExternalId: 'b1' });
    expect(decideWith(win, bet(), view([{ kind: 'REFUND', undone: true }]))).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: 'id-b1',
    });
    expect(
      decideWith(
        pending('LOSS', '0.00', { referenceExternalId: 'b1' }),
        bet(),
        view([{ kind: 'REFUND', undone: true }]),
      ),
    ).toEqual({
      type: 'APPLY',
      direction: null,
      referenceTransactionId: 'id-b1',
    });
    expect(decideWith(win, bet(), view([], true))).toEqual({
      type: 'APPLY',
      direction: 'CREDIT',
      referenceTransactionId: 'id-b1',
    });
  });

  test('[UT-05b] ROLLBACK de REFUND ou de WIN já estornado → REVERSAL_KIND_ALREADY_USED', () => {
    const refund = stored('REFUND', '10.00', 'PROCESSED', { externalId: 'r1', id: 'id-r1', referenceExternalId: 'b1' });
    const win = stored('WIN', '30.00', 'PROCESSED', { externalId: 'w1', id: 'id-w1', referenceExternalId: 'b1' });
    expect(
      decideWith(
        pending('ROLLBACK', '10.00', { referenceExternalId: 'r1' }),
        refund,
        view([{ kind: 'ROLLBACK', undone: false }]),
        '100.00',
      ),
    ).toEqual(reject('REVERSAL_KIND_ALREADY_USED'));
    expect(
      decideWith(
        pending('ROLLBACK', '30.00', { referenceExternalId: 'w1' }),
        win,
        view([{ kind: 'ROLLBACK', undone: false }]),
        '100.00',
      ),
    ).toEqual(reject('REVERSAL_KIND_ALREADY_USED'));
  });
});

describe('[RV-UT-02b] precedência entre as linhas de P1/P2 e as linhas comuns', () => {
  test('[RV-UT-02b] 10a antes de 10b; 10b antes de 10c', () => {
    expect(
      decideWith(
        pending('REFUND', '10.00', { referenceExternalId: 'b1' }),
        bet(),
        view([{ kind: 'REFUND', undone: false }], true),
      ),
    ).toEqual(reject('REVERSAL_KIND_ALREADY_USED'));
    expect(
      decideWith(
        pending('ROLLBACK', '10.00', { referenceExternalId: 'b1' }),
        bet(),
        view([{ kind: 'REFUND', undone: false }], true),
      ),
    ).toEqual(reject('REFERENCE_ALREADY_REVERSED'));
  });

  test('[RV-UT-02b] valor (linha 9) antes de P1/P2; P1/P2 (linha 10) antes do saldo (linha 12)', () => {
    expect(
      decideWith(
        pending('REFUND', '9.00', { referenceExternalId: 'b1' }),
        bet(),
        view([{ kind: 'REFUND', undone: false }]),
      ),
    ).toEqual(reject('REFERENCE_AMOUNT_MISMATCH'));
    const refund = stored('REFUND', '10.00', 'PROCESSED', { externalId: 'r1', id: 'id-r1', referenceExternalId: 'b1' });
    expect(
      decideWith(
        pending('ROLLBACK', '10.00', { referenceExternalId: 'r1' }),
        refund,
        view([{ kind: 'ROLLBACK', undone: false }]),
        '0.00',
      ),
    ).toEqual(reject('REVERSAL_KIND_ALREADY_USED'));
  });

  test('[RV-UT-02b] escopo (linha 6) antes de P1/P2', () => {
    expect(
      decideWith(
        pending('REFUND', '10.00', { referenceExternalId: 'b1', roundId: 'round-2' }),
        bet(),
        view([{ kind: 'REFUND', undone: false }]),
      ),
    ).toEqual(reject('REFERENCE_SCOPE_MISMATCH'));
  });
});

/**
 * Motor mínimo de teste: aplica as decisões da política a uma Wallet e mantém, em memória, as
 * reversões aplicadas (como a tabela wager_reversals). Não calcula esperados: os testes comparam
 * com valores fixos ou com contagens independentes.
 */
class ScenarioEngine {
  readonly wallet: Wallet;
  readonly transactions = new Map<string, WagerTransaction>();
  readonly reversals: { id: string; kind: WagerKind; targetId: string; undoneBy: string | undefined }[] = [];
  readonly wins: { id: string; targetId: string }[] = [];
  private sequence = 0;

  constructor(balance: string) {
    this.wallet = wallet(balance);
  }

  submit(kind: WagerKind, amount: string, referenceExternalId?: string): SettlementDecision {
    this.sequence += 1;
    const externalId = `${kind.toLowerCase()}-${this.sequence}`;
    const transaction = pending(kind, amount, { externalId, id: `id-${externalId}`, referenceExternalId });
    const reference = referenceExternalId === undefined ? undefined : this.transactions.get(referenceExternalId);
    const reversalView =
      reference?.status === 'PROCESSED' ? this.viewOf(reference.id, transaction.requiresReference()) : view([]);
    const decision = policy.decide(transaction, { wallet: this.wallet, reference, view: reversalView });
    if (decision.type === 'APPLY') this.apply(decision, transaction, reference, externalId);
    this.transactions.set(externalId, transaction);
    return decision;
  }

  private apply(
    decision: Extract<SettlementDecision, { type: 'APPLY' }>,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    externalId: string,
  ): void {
    transaction.markProcessed(decision.referenceTransactionId, AT);
    const ids = { transactionId: transaction.id, entryId: `e-${externalId}`, at: AT };
    if (decision.direction === 'DEBIT') this.wallet.debit(transaction.money, ids);
    if (decision.direction === 'CREDIT') this.wallet.credit(transaction.money, ids);
    if (reference === undefined) return;
    const kind = transaction.kind;
    if (kind === 'REFUND' || kind === 'ROLLBACK') this.recordReversal(transaction.id, kind, reference.id);
    if (kind === 'WIN') this.wins.push({ id: transaction.id, targetId: reference.id });
  }

  private recordReversal(id: string, kind: 'REFUND' | 'ROLLBACK', targetId: string): void {
    this.reversals.push({ id, kind, targetId, undoneBy: undefined });
    const undone = this.reversals.find((reversal) => reversal.id === targetId && reversal.kind === 'REFUND');
    if (kind === 'ROLLBACK' && undone !== undefined) undone.undoneBy = id;
  }

  private viewOf(targetId: string, includeWinSettlement: boolean): ReversalView {
    const reversals = this.reversals
      .filter((reversal) => reversal.targetId === targetId)
      .map((reversal) => ({
        kind: reversal.kind === 'REFUND' ? ('REFUND' as const) : ('ROLLBACK' as const),
        undone: reversal.undoneBy !== undefined,
      }));
    const settledByWin =
      includeWinSettlement &&
      this.wins.some(
        (win) => win.targetId === targetId && !this.reversals.some((reversal) => reversal.targetId === win.id),
      );
    return view(reversals, settledByWin);
  }
}

describe('[RV-UT-01] cenários 1 e 2 da decisão P1 = C (saldos fixos)', () => {
  test('[RV-UT-01] cenário 1: REFUND em vigor, depois ROLLBACK da BET → rejeitado; saldo 100.00', () => {
    const engine = new ScenarioEngine('100.00');
    expect(engine.submit('BET', '10.00').type).toBe('APPLY');
    expect(engine.wallet.balance.toString()).toBe('90.00');
    expect(engine.submit('REFUND', '10.00', 'bet-1').type).toBe('APPLY');
    expect(engine.wallet.balance.toString()).toBe('100.00');
    expect(engine.submit('ROLLBACK', '10.00', 'bet-1')).toEqual(reject('REFERENCE_ALREADY_REVERSED'));
    expect([engine.wallet.balance.toString(), engine.wallet.version]).toEqual(['100.00', 3]);
  });

  test('[RV-UT-01] cenário 2: REFUND desfeito antes → ROLLBACK da BET aceito; saldo 100.00; novo REFUND rejeitado', () => {
    const engine = new ScenarioEngine('100.00');
    engine.submit('BET', '10.00');
    engine.submit('REFUND', '10.00', 'bet-1');
    expect(engine.submit('ROLLBACK', '10.00', 'refund-2')).toMatchObject({ type: 'APPLY', direction: 'DEBIT' });
    expect(engine.wallet.balance.toString()).toBe('90.00');
    expect(engine.submit('ROLLBACK', '10.00', 'bet-1')).toMatchObject({ type: 'APPLY', direction: 'CREDIT' });
    expect([engine.wallet.balance.toString(), engine.wallet.version]).toEqual(['100.00', 5]);
    expect(engine.submit('REFUND', '10.00', 'bet-1')).toEqual(reject('REVERSAL_KIND_ALREADY_USED'));
    expect(engine.wallet.balance.toString()).toBe('100.00');
  });
});

type Operation = 'REFUND_BET' | 'ROLLBACK_BET' | 'ROLLBACK_LAST_REFUND' | 'WIN_BET' | 'ROLLBACK_LAST_WIN' | 'LOSS_BET';

/** Contagem independente dos efeitos aplicados (centavos), sem consultar a política. */
class EffectTally {
  netOnBet = 0n;
  refundsUndone = 0n;
  winsInForce = 0;
  lastRefund: string | undefined;
  lastWin: string | undefined;

  submit(engine: ScenarioEngine, operation: Operation): SettlementDecision | undefined {
    switch (operation) {
      case 'REFUND_BET':
        return engine.submit('REFUND', '10.00', 'bet-1');
      case 'ROLLBACK_BET':
        return engine.submit('ROLLBACK', '10.00', 'bet-1');
      case 'WIN_BET':
        return engine.submit('WIN', '30.00', 'bet-1');
      case 'LOSS_BET':
        return engine.submit('LOSS', '0.00', 'bet-1');
      case 'ROLLBACK_LAST_REFUND':
        return this.lastRefund === undefined ? undefined : engine.submit('ROLLBACK', '10.00', this.lastRefund);
      case 'ROLLBACK_LAST_WIN':
        return this.lastWin === undefined ? undefined : engine.submit('ROLLBACK', '30.00', this.lastWin);
    }
  }

  record(operation: Operation, externalId: string): void {
    if (operation === 'REFUND_BET' || operation === 'ROLLBACK_BET') this.netOnBet += centsOf('10.00');
    if (operation === 'REFUND_BET') this.lastRefund = externalId;
    if (operation === 'ROLLBACK_LAST_REFUND') this.refundsUndone += centsOf('10.00');
    if (operation === 'WIN_BET') {
      this.winsInForce += 1;
      this.lastWin = externalId;
    }
    if (operation === 'ROLLBACK_LAST_WIN') this.winsInForce -= 1;
  }
}

describe('[RV-UT-03] propriedade: o stake volta no máximo uma vez e WIN/reversão não coexistem em vigor', () => {
  const OPERATIONS: readonly Operation[] = [
    'REFUND_BET',
    'ROLLBACK_BET',
    'ROLLBACK_LAST_REFUND',
    'WIN_BET',
    'ROLLBACK_LAST_WIN',
    'LOSS_BET',
  ];

  test('[RV-UT-03] qualquer sequência de reversões, prêmios e estornos sobre uma BET de 10.00 (seed fixa)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...OPERATIONS), { maxLength: 14 }), (operations) => {
        const engine = new ScenarioEngine('1000.00');
        engine.submit('BET', '10.00');
        const tally = new EffectTally();
        for (const operation of operations) {
          const position = engine.transactions.size;
          const decision = tally.submit(engine, operation);
          if (decision?.type !== 'APPLY') continue;
          tally.record(operation, [...engine.transactions.keys()][position] ?? '');
        }
        const credited = tally.netOnBet - tally.refundsUndone;
        expect([0n, centsOf('10.00')]).toContain(credited);
        // P2 = (c): stake devolvido e prêmio em vigor nunca ao mesmo tempo.
        expect(credited > 0n && tally.winsInForce > 0).toBe(false);
      }),
      { seed: 20261112, numRuns: 500 },
    );
  });
});
