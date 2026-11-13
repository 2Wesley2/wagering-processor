import { DomainError, PreconditionError } from '../../../shared/errors.ts';
import { CurrencyMismatchError, Money } from '../../../shared/money.ts';
import { WalletLedgerEntry } from './ledger-entry.ts';

export class InsufficientFundsError extends DomainError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'saldo insuficiente');
  }
}

export class BalanceLimitExceededError extends DomainError {
  constructor() {
    super('BALANCE_LIMIT_EXCEEDED', 'o crédito ultrapassaria o saldo máximo');
  }
}

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Identificadores do lançamento que uma movimentação vai gerar (vêm da porta IdGenerator). */
export interface MovementIds {
  readonly transactionId: string;
  readonly entryId: string;
  readonly at: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly at: Date;
  /** Obrigatório quando initialBalance > 0: ids da OPENING e do lançamento v1. */
  readonly opening?: { readonly transactionId: string; readonly entryId: string };
}

/**
 * Aggregate root (§6.2). `debit`/`credit` são o único caminho de mutação do
 * saldo: cada um gera e retém exatamente um lançamento, e `version` sobe 1
 * somente quando o saldo muda.
 */
export class Wallet {
  private readonly uncommitted: WalletLedgerEntry[] = [];

  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abertura: saldo 0.00 → version 1, sem lançamento. Saldo > 0 → lançamento
   * CREDIT 0.00 → inicial com walletVersion 1 (a OPENING é criada pelo caso de uso).
   */
  static open(props: OpenWalletProps): Wallet {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) throw new PreconditionError('saldo inicial negativo');
    if (initialBalance.exceedsMax()) throw new BalanceLimitExceededError();
    const zero = Money.zero(initialBalance.currency);
    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      zero,
      1,
      new Date(at.getTime()),
      new Date(at.getTime()),
    );
    if (initialBalance.isPositive()) {
      if (props.opening === undefined) throw new PreconditionError('saldo inicial > 0 exige ids da OPENING');
      wallet._balance = initialBalance;
      wallet.uncommitted.push(
        WalletLedgerEntry.create({
          id: props.opening.entryId,
          walletId: props.id,
          transactionId: props.opening.transactionId,
          direction: 'CREDIT',
          money: initialBalance,
          balanceBefore: zero,
          balanceAfter: initialBalance,
          walletVersion: 1,
          createdAt: at,
        }),
      );
    }
    return wallet;
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  canCredit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.add(money).exceedsMax();
  }

  debit(money: Money, movementIds: MovementIds): WalletLedgerEntry {
    this.assertMovement(money);
    if (!this.canDebit(money)) throw new InsufficientFundsError();
    return this.apply('DEBIT', money, this._balance.subtract(money), movementIds);
  }

  credit(money: Money, movementIds: MovementIds): WalletLedgerEntry {
    this.assertMovement(money);
    if (!this.canCredit(money)) throw new BalanceLimitExceededError();
    return this.apply('CREDIT', money, this._balance.add(money), movementIds);
  }

  /** Lançamentos gerados desde a carga, na ordem; esvazia a lista (o repositório os persiste). */
  pullLedgerEntries(): WalletLedgerEntry[] {
    return this.uncommitted.splice(0, this.uncommitted.length);
  }

  peekLedgerEntries(): readonly WalletLedgerEntry[] {
    return [...this.uncommitted];
  }

  private apply(
    direction: 'DEBIT' | 'CREDIT',
    money: Money,
    after: Money,
    movementIds: MovementIds,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: movementIds.entryId,
      walletId: this.id,
      transactionId: movementIds.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: movementIds.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(movementIds.at.getTime());
    this.uncommitted.push(entry);
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new PreconditionError('movimentação precisa ser > 0');
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
