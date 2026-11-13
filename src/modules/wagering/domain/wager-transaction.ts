import { HASH_V1_RE } from '../../../shared/canonical-json.ts';
import { DomainError, PreconditionError } from '../../../shared/errors.ts';
import { type PermanentFailureCode, REJECTION_CODES, type RejectionCode } from '../../../shared/error-catalog.ts';
import type { Money } from '../../../shared/money.ts';
import type { LedgerDirection } from '../../wallet/domain/ledger-entry.ts';

export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];
/** Kinds aceitos por API e fila; OPENING é interno (§6.3). */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type SubmittableKind = (typeof SUBMITTABLE_KINDS)[number];

export function isSubmittableKind(value: unknown): value is SubmittableKind {
  return SUBMITTABLE_KINDS.some((kind) => kind === value);
}
export type ReversalKind = 'REFUND' | 'ROLLBACK';

export const WAGER_STATUSES = ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] as const;
export type WagerStatus = (typeof WAGER_STATUSES)[number];

export function isWagerKind(value: unknown): value is WagerKind {
  return WAGER_KINDS.some((kind) => kind === value);
}

export function isWagerStatus(value: unknown): value is WagerStatus {
  return WAGER_STATUSES.some((status) => status === value);
}

export const INTERNAL_PROVIDER_ID = '__internal__';

/** Kinds que cada reversão/liquidação pode referenciar (§7 regra 3; WIN/LOSS → BET). */
export const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerKind, readonly WagerKind[]>> = {
  OPENING: [],
  BET: [],
  WIN: ['BET'],
  LOSS: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

/** Código gravado em REJECTED (regra de negócio) ou FAILED (falha permanente). */
export type TransactionFailureCode = RejectionCode | PermanentFailureCode;

export function isRejectionCode(value: unknown): value is RejectionCode {
  return REJECTION_CODES.some((code) => code === value);
}

export function isTransactionFailureCode(value: unknown): value is TransactionFailureCode {
  return isRejectionCode(value) || value === 'PROCESSING_PERMANENT_FAILURE';
}

export class InvalidTransactionStateError extends Error {
  constructor(from: WagerStatus, transition: string) {
    super(`transição inválida: ${transition} a partir de ${from}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class TransactionContractError extends DomainError {}

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;
  readonly status: WagerStatus;
  readonly referenceTransactionId: string | undefined;
  readonly failureCode: TransactionFailureCode | undefined;
  readonly decidedAt: Date | undefined;
}

/** Campos que mudam nas transições; o restante do estado é imutável desde a criação. */
type MutableStateField = 'status' | 'referenceTransactionId' | 'failureCode' | 'decidedAt';
type WagerTransactionCoreState = Omit<WagerTransactionState, MutableStateField>;

export type CreateWagerTransactionProps = Omit<WagerTransactionState, MutableStateField | 'kind'> & {
  readonly kind: WagerKind;
};

/**
 * Transações de aposta (§6.3). Máquina de estados:
 *
 * | De \ evento        | markProcessed | markPendingReference | reject   | fail   |
 * | PENDING (memória)  | PROCESSED     | PENDING_REFERENCE    | REJECTED | FAILED |
 * | PENDING_REFERENCE  | PROCESSED     | no-op                | REJECTED | FAILED |
 * | terminais          | erro          | erro                 | erro     | erro   |
 *
 * Transição a partir de estado terminal é bug, não regra de negócio.
 */
export class WagerTransaction {
  private constructor(
    private readonly state: WagerTransactionCoreState,
    private _status: WagerStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: TransactionFailureCode | undefined,
    private _decidedAt: Date | undefined,
  ) {}

  /** Nasce em PENDING; valida as exigências do contrato por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money } = props;
    if (kind === 'OPENING' || props.providerId === INTERNAL_PROVIDER_ID) {
      throw new TransactionContractError('KIND_NOT_ALLOWED', 'OPENING é interno e não pode ser submetido');
    }
    const reference = props.referenceExternalTransactionId;
    if (kind === 'BET' && reference !== undefined) {
      throw new TransactionContractError('REFERENCE_NOT_ALLOWED', 'BET não referencia outra transação');
    }
    if ((kind === 'REFUND' || kind === 'ROLLBACK') && reference === undefined) {
      throw new TransactionContractError('REFERENCE_REQUIRED', `${kind} exige referenceExternalTransactionId`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new TransactionContractError('SELF_REFERENCE', 'a transação não pode referenciar a si mesma');
    }
    if (money.isNegative() || (kind !== 'LOSS' && money.isZero())) {
      throw new TransactionContractError(
        'INVALID_AMOUNT',
        kind === 'LOSS' ? 'LOSS exige valor ≥ 0' : `${kind} exige valor > 0`,
      );
    }
    if (!HASH_V1_RE.test(props.payloadHash)) throw new PreconditionError('payloadHash fora do formato v1');
    return new WagerTransaction(copyCore(props), 'PENDING', undefined, undefined, undefined);
  }

  /** OPENING interna: já nasce PROCESSED, na mesma transação SQL da wallet (D06). */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    createdAt: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) throw new PreconditionError('OPENING só existe para saldo inicial > 0');
    return new WagerTransaction(
      copyCore({
        id: props.id,
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: `opening:${props.walletId}`,
        idempotencyKey: `internal:opening:${props.walletId}`,
        payloadHash: props.payloadHash,
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: 'opening',
        gameId: 'internal',
        kind: 'OPENING',
        money: props.money,
        referenceExternalTransactionId: undefined,
        createdAt: props.createdAt,
      }),
      'PROCESSED',
      undefined,
      undefined,
      new Date(props.createdAt.getTime()),
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      copyCore(state),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.decidedAt === undefined ? undefined : new Date(state.decidedAt.getTime()),
    );
  }

  get id(): string {
    return this.state.id;
  }
  get providerId(): string {
    return this.state.providerId;
  }
  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }
  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }
  get payloadHash(): string {
    return this.state.payloadHash;
  }
  get walletId(): string {
    return this.state.walletId;
  }
  get playerId(): string {
    return this.state.playerId;
  }
  get roundId(): string {
    return this.state.roundId;
  }
  get gameId(): string {
    return this.state.gameId;
  }
  get kind(): WagerKind {
    return this.state.kind;
  }
  get money(): Money {
    return this.state.money;
  }
  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }
  get createdAt(): Date {
    return new Date(this.state.createdAt.getTime());
  }
  get status(): WagerStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): TransactionFailureCode | undefined {
    return this._failureCode;
  }
  get decidedAt(): Date | undefined {
    return this._decidedAt === undefined ? undefined : new Date(this._decidedAt.getTime());
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    if (this.requiresReference() && referenceTransactionId === undefined) {
      throw new PreconditionError(`${this.kind} PROCESSED exige a referência resolvida`);
    }
    this._status = 'PROCESSED';
    this._referenceTransactionId = referenceTransactionId;
    this._decidedAt = new Date(at.getTime());
  }

  markPendingReference(): void {
    if (this._status === 'PENDING_REFERENCE') return;
    this.assertNotTerminal('markPendingReference');
    if (this.state.referenceExternalTransactionId === undefined) {
      throw new PreconditionError('PENDING_REFERENCE exige referenceExternalTransactionId');
    }
    this._status = 'PENDING_REFERENCE';
  }

  reject(code: RejectionCode, at: Date): void {
    this.assertNotTerminal('reject');
    this._status = 'REJECTED';
    this._failureCode = code;
    this._decidedAt = new Date(at.getTime());
  }

  fail(code: PermanentFailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = 'FAILED';
    this._failureCode = code;
    this._decidedAt = new Date(at.getTime());
  }

  isTerminal(): boolean {
    return this._status === 'PROCESSED' || this._status === 'REJECTED' || this._status === 'FAILED';
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return this.kind === 'REFUND' || this.kind === 'ROLLBACK';
  }

  matchesPayload(payloadHash: string): boolean {
    return this.state.payloadHash === payloadHash;
  }

  /**
   * Direção no ledger: BET → DEBIT; WIN, REFUND e OPENING → CREDIT; ROLLBACK →
   * inverso da referência; LOSS → null (sem lançamento).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.kind) {
      case 'BET':
        return 'DEBIT';
      case 'WIN':
      case 'REFUND':
      case 'OPENING':
        return 'CREDIT';
      case 'LOSS':
        return null;
      case 'ROLLBACK': {
        if (reference === undefined) throw new PreconditionError('ROLLBACK precisa da referência para ter direção');
        const target = reference.ledgerDirectionFor();
        if (target === null) throw new PreconditionError('ROLLBACK de transação sem efeito no saldo');
        return target === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      }
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) throw new InvalidTransactionStateError(this._status, transition);
  }
}

function copyCore(state: WagerTransactionCoreState): WagerTransactionCoreState {
  return Object.freeze({
    id: state.id,
    providerId: state.providerId,
    externalTransactionId: state.externalTransactionId,
    idempotencyKey: state.idempotencyKey,
    payloadHash: state.payloadHash,
    walletId: state.walletId,
    playerId: state.playerId,
    roundId: state.roundId,
    gameId: state.gameId,
    kind: state.kind,
    money: state.money,
    referenceExternalTransactionId: state.referenceExternalTransactionId,
    createdAt: new Date(state.createdAt.getTime()),
  });
}
