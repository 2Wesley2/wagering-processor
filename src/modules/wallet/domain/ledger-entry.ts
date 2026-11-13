import { DomainError } from '../../../shared/errors.ts';
import type { Money } from '../../../shared/money.ts';

export const LEDGER_DIRECTIONS = ['DEBIT', 'CREDIT'] as const;
export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super('INTERNAL_ERROR', `lançamento inválido: ${message}`);
  }
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Versão da wallet APÓS este lançamento; ordena o ledger (D14). */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

/**
 * Lançamento imutável (§6.4): sem setters e congelado. `create` valida a
 * aritmética; `rehydrate` confia na persistência (o banco tem os mesmos CHECKs).
 */
export class WalletLedgerEntry implements LedgerEntryState {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('moedas divergentes');
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError('valor precisa ser > 0');
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) throw new InvalidLedgerEntryError('saldo negativo');
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('walletVersion precisa ser inteiro ≥ 1');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError('balanceBefore ± money ≠ balanceAfter');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt.getTime()),
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === 'CREDIT' ? this.balanceBefore.add(this.money) : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
