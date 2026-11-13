import { PreconditionError } from '../../../shared/errors.ts';
import type { RejectionCode } from '../../../shared/error-catalog.ts';
import type { LedgerDirection } from '../../wallet/domain/ledger-entry.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import { ALLOWED_REFERENCE_KINDS, type ReversalKind, type WagerTransaction } from './wager-transaction.ts';

export type SettlementDecision =
  | {
      readonly type: 'APPLY';
      readonly direction: LedgerDirection | null;
      readonly referenceTransactionId: string | undefined;
    }
  | { readonly type: 'REJECT'; readonly code: RejectionCode }
  | { readonly type: 'AWAIT_REFERENCE' };

/** Reversões já PROCESSED sobre o alvo (e se foram desfeitas), lidas sob o lock da wallet. */
export interface ReversalView {
  readonly reversals: readonly { readonly kind: ReversalKind; readonly undone: boolean }[];
  /** Existe WIN PROCESSED efetivo que referencia o alvo (relevante para P2). */
  readonly settledByWin: boolean;
}

export const EMPTY_REVERSAL_VIEW: ReversalView = Object.freeze({ reversals: [], settledByWin: false });

export interface WalletDecisionContext {
  readonly wallet: Wallet;
  readonly reference: WagerTransaction | undefined;
  readonly view: ReversalView;
}

/**
 * Linhas 10a–10c da precedência (seção 4.3 do plano), que dependem das decisões
 * P1 e P2 do usuário. Só é consultada quando o alvo já tem reversões ou WIN.
 */
export interface ReversalRule {
  evaluate(input: {
    transaction: WagerTransaction;
    reference: WagerTransaction;
    view: ReversalView;
  }): RejectionCode | null;
}

export class ReversalRuleUndecidedError extends Error {
  constructor() {
    super('regra de reversão (P1/P2) ainda não decidida: o caso exige a decisão antes da F4');
    this.name = 'ReversalRuleUndecidedError';
  }
}

/**
 * Até a decisão de P1/P2 nenhum desfecho é escolhido por conta própria: um caso
 * que dependa dela falha alto (erro de programação) em vez de decidir em silêncio.
 */
export const UNDECIDED_REVERSAL_RULE: ReversalRule = {
  evaluate() {
    throw new ReversalRuleUndecidedError();
  },
};

/**
 * Regra decidida pelo usuário em 2026-11-12 (ARCHITECTURE.md §1), linhas 10a–10c da precedência:
 *
 * - P1 = C, para REFUND/ROLLBACK:
 *   10a. o mesmo tipo já reverteu o alvo, mesmo que desfeito depois → REVERSAL_KIND_ALREADY_USED;
 *   10b. o alvo tem outra reversão em vigor (aplicada e não desfeita) → REFERENCE_ALREADY_REVERSED;
 * - P2 = (c):
 *   10c. REFUND/ROLLBACK de BET com WIN em vigor (não estornado) → BET_ALREADY_SETTLED;
 *        WIN/LOSS sobre BET com reversão em vigor → REFERENCED_BET_REVERSED. Uma reversão já
 *        desfeita, por si só, não impede WIN nem LOSS.
 */
export const DECIDED_REVERSAL_RULE: ReversalRule = {
  evaluate({ transaction, reference, view }) {
    const reversalInForce = view.reversals.some((reversal) => !reversal.undone);
    if (transaction.requiresReference()) {
      if (view.reversals.some((reversal) => reversal.kind === transaction.kind)) return 'REVERSAL_KIND_ALREADY_USED';
      if (reversalInForce) return 'REFERENCE_ALREADY_REVERSED';
      if (reference.kind === 'BET' && view.settledByWin) return 'BET_ALREADY_SETTLED';
      return null;
    }
    if ((transaction.kind === 'WIN' || transaction.kind === 'LOSS') && reversalInForce)
      return 'REFERENCED_BET_REVERSED';
    return null;
  },
};

function viewIsEmpty(view: ReversalView): boolean {
  return view.reversals.length === 0 && !view.settledByWin;
}

/**
 * Domain service puro (D09): decide o desfecho de uma transação PENDING sobre o
 * estado da wallet carregado sob lock. Linhas 1–4 (contrato, idempotência,
 * wallet inexistente, wallet/moeda divergentes) são da camada de aplicação e
 * chegam aqui como pré-condição.
 */
export class SettlementPolicy {
  constructor(private readonly reversalRule: ReversalRule = DECIDED_REVERSAL_RULE) {}

  decide(transaction: WagerTransaction, context: WalletDecisionContext): SettlementDecision {
    const { wallet, reference } = context;
    if (
      transaction.walletId !== wallet.id ||
      transaction.playerId !== wallet.playerId ||
      transaction.money.currency !== wallet.currency
    ) {
      throw new PreconditionError('wallet, player ou moeda divergentes devem ser barrados antes da política');
    }
    if (transaction.isTerminal()) throw new PreconditionError('transação já decidida');

    if (transaction.referenceExternalTransactionId !== undefined) {
      const referenceDecision = this.checkReference(transaction, reference, context.view);
      if (referenceDecision !== undefined) return referenceDecision;
    }
    return checkBalance(transaction, wallet, reference);
  }

  /** Linhas 5 a 10 da precedência: referência ausente, escopo, kind, status, valor e regras de P1/P2. */
  private checkReference(
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    view: ReversalView,
  ): SettlementDecision | undefined {
    // 5. Referência ausente ou ainda pendente.
    if (reference === undefined || reference.status === 'PENDING_REFERENCE' || reference.status === 'PENDING') {
      return { type: 'AWAIT_REFERENCE' };
    }
    // 6 e 7. Escopo e kind da referência.
    const relationCode = referenceRelationViolation(transaction, reference);
    if (relationCode !== undefined) return reject(relationCode);
    // 8. Referência precisa estar PROCESSED.
    if (reference.status !== 'PROCESSED') return reject('REFERENCE_NOT_PROCESSED');
    // 9. Reversão com o mesmo valor (§7 regra 5).
    if (transaction.requiresReference() && !transaction.money.equals(reference.money)) {
      return reject('REFERENCE_AMOUNT_MISMATCH');
    }
    // 10. Regras dependentes de P1/P2.
    if (viewIsEmpty(view)) return undefined;
    const code = this.reversalRule.evaluate({ transaction, reference, view });
    return code === null ? undefined : reject(code);
  }
}

export type ReferenceRelationCode = Extract<RejectionCode, 'REFERENCE_SCOPE_MISMATCH' | 'INVALID_REFERENCE_KIND'>;

/**
 * Linhas 6 e 7 da precedência: só dependem de atributos imutáveis da referência (escopo e kind),
 * nunca do status dela. Se uma delas falha, nenhum desfecho futuro da referência torna a
 * relação válida: o worker não espera por essa referência (D40).
 */
export function referenceRelationViolation(
  transaction: WagerTransaction,
  reference: WagerTransaction,
): ReferenceRelationCode | undefined {
  // 6. Mesmo provider, player, wallet, moeda e rodada (§7 regra 2). gameId não entra.
  if (!sameScope(transaction, reference)) return 'REFERENCE_SCOPE_MISMATCH';
  // 7. Kind compatível (§7 regra 3).
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind].includes(reference.kind)) return 'INVALID_REFERENCE_KIND';
  return undefined;
}

function sameScope(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId
  );
}

/** Linhas 11 a 14 da precedência: saldo, limite e aplicação. */
function checkBalance(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | undefined,
): SettlementDecision {
  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === 'DEBIT' && !wallet.canDebit(transaction.money)) {
    // 11/12. Código distinto para reversão sem saldo (§7 regra 9).
    return reject(transaction.kind === 'ROLLBACK' ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
  }
  if (direction === 'CREDIT' && !wallet.canCredit(transaction.money)) return reject('BALANCE_LIMIT_EXCEEDED');
  return { type: 'APPLY', direction, referenceTransactionId: reference?.id };
}

function reject(code: RejectionCode): SettlementDecision {
  return { type: 'REJECT', code };
}
