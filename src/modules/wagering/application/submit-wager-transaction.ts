import { DomainError } from '../../../shared/errors.ts';
import { Money } from '../../../shared/money.ts';
import type { Clock, DatabaseTransaction, IdGenerator, UnitOfWork } from '../../../shared/ports.ts';
import type { WalletRepository } from '../../wallet/application/ports.ts';
import { WalletNotFoundError } from '../../wallet/application/wallet-service.ts';
import type { SubmitTransactionCommand } from '../contracts/submit-transaction.ts';
import { commandHash } from '../domain/command-hash.ts';
import { EMPTY_REVERSAL_VIEW, type SettlementDecision, type SettlementPolicy } from '../domain/settlement-policy.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';
import { type OriginalResponse, originalResponseOf, rehydrateTransaction } from './original-response.ts';
import type { SettlementRecorder } from './settlement-recorder.ts';
import type {
  InboxDelivery,
  InboxOutcome,
  InboxStore,
  ProviderIdentity,
  SubmissionObserver,
  TransactionQueries,
  TransactionRow,
  TransactionStore,
} from './ports.ts';

export class IdempotencyKeyReusedError extends DomainError {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key já usada com outro payload; não é replay');
  }
}

export class ExternalTransactionIdConflictError extends DomainError {
  constructor() {
    super('EXTERNAL_TRANSACTION_ID_CONFLICT', '(providerId, externalTransactionId) já usado com outra Idempotency-Key');
  }
}

export class WalletPlayerMismatchError extends DomainError {
  constructor() {
    super('WALLET_PLAYER_MISMATCH', 'a wallet não pertence ao playerId informado');
  }
}

export class WalletCurrencyMismatchError extends DomainError {
  constructor() {
    super('CURRENCY_MISMATCH', 'a moeda da operação difere da moeda da wallet');
  }
}

export class ProviderNotRecognizedError extends DomainError {
  constructor() {
    super('PROVIDER_NOT_RECOGNIZED', 'providerId não reconhecido');
  }
}

/**
 * Outra entrega do mesmo messageId comitou primeiro (inbox): nada desta tentativa é gravado; o
 * consumidor confere o hash do envelope (duplicata → ack; outro conteúdo → dead-letter).
 */
export class DuplicateDeliveryError extends Error {
  constructor(readonly messageId: string) {
    super(`mensagem ${messageId} já processada por outra entrega`);
    this.name = 'DuplicateDeliveryError';
  }
}

export interface SubmissionRequest {
  readonly command: SubmitTransactionCommand;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** Só pela fila: a inbox entra na mesma transação SQL da decisão (D26). */
  readonly inbox?: InboxDelivery;
}

export interface SubmissionResult {
  readonly response: OriginalResponse;
  readonly idempotentReplay: boolean;
}

/** Constraints únicas cuja violação significa "outra requisição gravou primeiro" (D26). */
export const IDEMPOTENCY_CONSTRAINTS = ['wtx_idempotency_key_uq', 'wtx_provider_external_uq'] as const;

/** Detecta violação de unicidade por nome de constraint (implementado na infraestrutura). */
export type UniqueViolationOf = (error: unknown) => string | undefined;

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly wallets: WalletRepository;
  readonly transactions: TransactionStore;
  readonly inbox: InboxStore;
  readonly queries: TransactionQueries;
  readonly recorder: SettlementRecorder;
  readonly policy: SettlementPolicy;
  /** TTL de uma pendência de referência (D40). */
  readonly pendingTtlMs: number;
  readonly providers: ProviderIdentity;
  readonly observer: SubmissionObserver;
  readonly uniqueViolationOf: UniqueViolationOf;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

/**
 * HTTP e SQS usam o mesmo caso de uso. Pela fila, a inbox e a decisão são gravadas na mesma
 * transação SQL.
 */
export class SubmitWagerTransaction {
  constructor(private readonly dependencies: SubmitWagerTransactionDependencies) {}

  async execute(request: SubmissionRequest): Promise<SubmissionResult> {
    const startedAt = performance.now();
    let outcome: 'ok' | 'error' = 'error';
    try {
      const result = await this.submit(request);
      outcome = 'ok';
      return result;
    } finally {
      this.dependencies.observer.completed((performance.now() - startedAt) / 1000, outcome);
    }
  }

  private async submit(request: SubmissionRequest): Promise<SubmissionResult> {
    const { command } = request;
    const money = Money.from(command.money);
    const payloadHash = commandHash(command);
    // Valida as regras do tipo da transação antes de consultar o banco.
    this.newTransaction(request, money, payloadHash, this.dependencies.idGenerator.next());
    this.dependencies.providers.assertMaySubmit(command.providerId);

    const fastPath = await this.resolveExisting(request, payloadHash);
    if (fastPath !== undefined) return this.withReplayDelivery(request, fastPath);

    try {
      return await this.dependencies.unitOfWork.run((databaseTransaction) =>
        this.decideUnderLock(databaseTransaction, request, money, payloadHash),
      );
    } catch (error) {
      const constraint = this.dependencies.uniqueViolationOf(error);
      if (constraint === undefined) throw error;
      // Outra requisição gravou primeiro (wallets diferentes não se encontram no lock).
      this.dependencies.observer.uniqueRace(constraint);
      const settled = await this.resolveExisting(request, payloadHash);
      if (settled === undefined) throw error;
      return this.withReplayDelivery(request, settled);
    }
  }

  /**
   * Replay pela key achado fora do lock: pela fila, a entrega nova (messageId novo) ainda precisa
   * ficar na inbox com outcome REPLAY, numa transação própria, antes do ack (D35).
   */
  private async withReplayDelivery(request: SubmissionRequest, result: SubmissionResult): Promise<SubmissionResult> {
    const delivery = request.inbox;
    if (delivery === undefined) return result;
    await this.dependencies.unitOfWork.run((databaseTransaction) =>
      this.recordDelivery(databaseTransaction, delivery, 'REPLAY', result.response.transactionId),
    );
    return result;
  }

  private async recordDelivery(
    databaseTransaction: DatabaseTransaction,
    delivery: InboxDelivery,
    outcome: InboxOutcome,
    transactionId: string,
  ): Promise<void> {
    const recorded = await this.dependencies.inbox.record(databaseTransaction, delivery, outcome, transactionId);
    if (!recorded) throw new DuplicateDeliveryError(delivery.messageId);
  }

  private async decideUnderLock(
    databaseTransaction: DatabaseTransaction,
    request: SubmissionRequest,
    money: Money,
    payloadHash: string,
  ): Promise<SubmissionResult> {
    const { command } = request;
    const { wallets, transactions, policy, clock, idGenerator } = this.dependencies;

    const wallet = await wallets.lockForUpdate(databaseTransaction, command.walletId);
    if (wallet === undefined) throw new WalletNotFoundError(command.walletId);
    if (wallet.playerId !== command.playerId) throw new WalletPlayerMismatchError();
    if (wallet.currency !== money.currency) throw new WalletCurrencyMismatchError();

    // Sob o lock, uma duplicata da mesma wallet já comitou: vira replay ou conflito.
    const settled = await this.classifyExisting(
      request,
      payloadHash,
      await transactions.findByIdempotencyKey(databaseTransaction, request.idempotencyKey),
      () =>
        transactions.findByProviderAndExternalId(
          databaseTransaction,
          command.providerId,
          command.externalTransactionId,
        ),
    );
    if (settled !== undefined) {
      if (request.inbox !== undefined) {
        await this.recordDelivery(databaseTransaction, request.inbox, 'REPLAY', settled.response.transactionId);
      }
      return settled;
    }

    // Uma transação nova por tentativa da UnitOfWork (o retry recomeça do zero).
    const transaction = this.newTransaction(request, money, payloadHash, idGenerator.next());
    const reference = await this.loadReference(databaseTransaction, transaction);
    const view =
      reference?.status === 'PROCESSED'
        ? await transactions.reversalView(databaseTransaction, reference.id, transaction.requiresReference())
        : EMPTY_REVERSAL_VIEW;
    const decision = policy.decide(transaction, { wallet, reference, view });
    const snapshot = await this.dependencies.recorder.record(databaseTransaction, {
      transaction,
      wallet,
      decision,
      reference,
      correlationId: request.correlationId,
      causationId: request.idempotencyKey,
      at: clock.now(),
      mode: { kind: 'arrival', pendingTtlMs: this.dependencies.pendingTtlMs },
    });
    if (request.inbox !== undefined) {
      const outcome: InboxOutcome =
        transaction.status === 'PENDING_REFERENCE' ? 'PENDING_REFERENCE' : this.terminalStatus(transaction);
      await this.recordDelivery(databaseTransaction, request.inbox, outcome, transaction.id);
    }

    this.dependencies.observer.decided({
      transactionId: transaction.id,
      walletId: transaction.walletId,
      providerId: transaction.providerId,
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
    });
    return {
      response: {
        transactionId: transaction.id,
        status: transaction.status === 'PENDING_REFERENCE' ? 'PENDING_REFERENCE' : this.terminalStatus(transaction),
        balance: snapshot.balance.toJSON(),
        failureCode: transaction.status === 'REJECTED' ? decisionCode(decision) : undefined,
        correlationId: request.correlationId,
      },
      idempotentReplay: false,
    };
  }

  private async loadReference(
    databaseTransaction: DatabaseTransaction,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    const referenceExternalId = transaction.referenceExternalTransactionId;
    if (referenceExternalId === undefined) return undefined;
    // §7 regra 2: a referência é resolvida por (providerId, referenceExternalTransactionId).
    const row = await this.dependencies.transactions.findByProviderAndExternalId(
      databaseTransaction,
      transaction.providerId,
      referenceExternalId,
    );
    return row === undefined ? undefined : rehydrateTransaction(row);
  }

  /** Caminho rápido (sem lock) e releitura depois de uma corrida de unicidade. */
  private async resolveExisting(
    request: SubmissionRequest,
    payloadHash: string,
  ): Promise<SubmissionResult | undefined> {
    const { queries } = this.dependencies;
    const { command } = request;
    return this.classifyExisting(request, payloadHash, await queries.findByIdempotencyKey(request.idempotencyKey), () =>
      queries.findByProviderAndExternalId(command.providerId, command.externalTransactionId),
    );
  }

  /**
   * Classifica o que já está gravado: pela key (replay ou conflito de payload) ou, se a key não
   * existe, pelo (providerId, externalTransactionId). Uma linha achada pelo externalId com a MESMA
   * key é a mesma operação, que comitou entre as duas leituras: replay ou conflito pela key, nunca
   * EXTERNAL_TRANSACTION_ID_CONFLICT.
   */
  private async classifyExisting(
    request: SubmissionRequest,
    payloadHash: string,
    byKey: TransactionRow | undefined,
    findByExternalId: () => Promise<TransactionRow | undefined>,
  ): Promise<SubmissionResult | undefined> {
    const providerId = request.command.providerId;
    if (byKey !== undefined) return this.resultForExisting(byKey, payloadHash, providerId);
    const byExternalId = await findByExternalId();
    if (byExternalId === undefined) return undefined;
    if (byExternalId.idempotencyKey === request.idempotencyKey) {
      return this.resultForExisting(byExternalId, payloadHash, providerId);
    }
    this.dependencies.observer.conflict('EXTERNAL_TRANSACTION_ID_CONFLICT', providerId);
    throw new ExternalTransactionIdConflictError();
  }

  /** Mesma key: replay se o payload é o mesmo; conflito (sem dados da transação existente) se não. */
  private resultForExisting(
    row: TransactionRow | undefined,
    payloadHash: string,
    providerId: string,
  ): SubmissionResult | undefined {
    if (row === undefined) return undefined;
    if (row.payloadHash !== payloadHash) {
      this.dependencies.observer.conflict('IDEMPOTENCY_KEY_REUSED', providerId);
      throw new IdempotencyKeyReusedError();
    }
    const response = originalResponseOf(row);
    this.dependencies.observer.replayed({
      transactionId: response.transactionId,
      providerId: row.providerId,
      status: response.status,
    });
    return { response, idempotentReplay: true };
  }

  private newTransaction(
    request: SubmissionRequest,
    money: Money,
    payloadHash: string,
    transactionId: string,
  ): WagerTransaction {
    const { command } = request;
    return WagerTransaction.create({
      id: transactionId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: request.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.dependencies.clock.now(),
    });
  }

  private terminalStatus(transaction: WagerTransaction): 'PROCESSED' | 'REJECTED' {
    if (transaction.status === 'PROCESSED' || transaction.status === 'REJECTED') return transaction.status;
    throw new Error(`desfecho inesperado na chegada: ${transaction.status}`);
  }
}

function decisionCode(decision: SettlementDecision) {
  if (decision.type !== 'REJECT') throw new Error('código de rejeição sem decisão REJECT');
  return decision.code;
}
