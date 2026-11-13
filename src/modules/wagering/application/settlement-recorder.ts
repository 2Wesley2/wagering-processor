import type { EventContext } from '../../../shared/integration-event.ts';
import type { DatabaseTransaction, IdGenerator } from '../../../shared/ports.ts';
import type { WalletRepository } from '../../wallet/application/ports.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events.ts';
import type { SettlementDecision } from '../domain/settlement-policy.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { DecisionSnapshot, EventOutbox, TransactionStore } from './ports.ts';

/** Como gravar a decisão: nova transação (chegada) ou resolução de uma pendência (worker). */
export type RecordingMode =
  | { readonly kind: 'arrival'; readonly pendingTtlMs: number }
  | { readonly kind: 'resolution'; readonly availableAt: bigint };

export interface RecordingInput {
  readonly transaction: WagerTransaction;
  readonly wallet: Wallet;
  readonly decision: SettlementDecision;
  /** Referência resolvida (obrigatória para reversões aplicadas). */
  readonly reference: WagerTransaction | undefined;
  readonly correlationId: string;
  readonly causationId: string;
  readonly at: Date;
  readonly mode: RecordingMode;
}

/**
 * Caminhos de gravação do script único (D26), usados pela submissão e pelo worker:
 * - aplicada com efeito: transação → wallet (`UPDATE … WHERE version = esperada`) → lançamento →
 *   reversão (P1 = C) → outbox `WagerTransactionProcessed` + `WalletBalanceChanged`;
 * - LOSS: sem lançamento nem versão nova;
 * - REJECTED: código, sem lançamento, `WagerTransactionRejected`;
 * - PENDING_REFERENCE (só na chegada): aceite, prazo, agenda e `WagerTransactionPendingReference`.
 * Depois de um desfecho terminal, as pendências da mesma wallet que dependem desta transação são
 * antecipadas na agenda (sem cascata no commit, D40). Devolve o snapshot gravado.
 */
export class SettlementRecorder {
  constructor(
    private readonly dependencies: {
      readonly wallets: WalletRepository;
      readonly transactions: TransactionStore;
      readonly outbox: EventOutbox;
      readonly idGenerator: IdGenerator;
    },
  ) {}

  async record(databaseTransaction: DatabaseTransaction, input: RecordingInput): Promise<DecisionSnapshot> {
    const { transaction, wallet, decision, at } = input;
    const observed: DecisionSnapshot = { balance: wallet.balance, walletVersion: wallet.version };
    switch (decision.type) {
      case 'APPLY': {
        transaction.markProcessed(decision.referenceTransactionId, at);
        if (decision.direction === null) {
          await this.writeTransaction(databaseTransaction, input, observed);
          await this.dependencies.outbox.append(databaseTransaction, [
            WagerTransactionProcessed.from(transaction, wallet, this.eventContext(input)),
          ]);
          await this.nudge(databaseTransaction, transaction);
          return observed;
        }
        const expectedVersion = wallet.version;
        const movementIds = { transactionId: transaction.id, entryId: this.dependencies.idGenerator.next(), at };
        const entry =
          decision.direction === 'DEBIT'
            ? wallet.debit(transaction.money, movementIds)
            : wallet.credit(transaction.money, movementIds);
        const applied: DecisionSnapshot = { balance: wallet.balance, walletVersion: wallet.version };
        await this.writeTransaction(databaseTransaction, input, applied);
        await this.dependencies.wallets.saveBalance(databaseTransaction, wallet, expectedVersion);
        await this.dependencies.wallets.insertLedgerEntries(databaseTransaction, wallet.pullLedgerEntries());
        await this.recordReversal(databaseTransaction, input, decision.direction);
        await this.dependencies.outbox.append(databaseTransaction, [
          WagerTransactionProcessed.from(transaction, wallet, this.eventContext(input)),
          WalletBalanceChanged.from(wallet, entry, this.eventContext(input)),
        ]);
        await this.nudge(databaseTransaction, transaction);
        return applied;
      }
      case 'REJECT': {
        transaction.reject(decision.code, at);
        await this.writeTransaction(databaseTransaction, input, observed);
        await this.dependencies.outbox.append(databaseTransaction, [
          WagerTransactionRejected.from(transaction, wallet, this.eventContext(input)),
        ]);
        await this.nudge(databaseTransaction, transaction);
        return observed;
      }
      case 'AWAIT_REFERENCE': {
        if (input.mode.kind !== 'arrival') throw new Error('uma pendência só é aceita na chegada');
        transaction.markPendingReference();
        await this.dependencies.transactions.insertPending(
          databaseTransaction,
          transaction,
          observed,
          input.correlationId,
          input.mode.pendingTtlMs,
        );
        await this.dependencies.outbox.append(databaseTransaction, [
          WagerTransactionPendingReference.from(transaction, this.eventContext(input)),
        ]);
        return observed;
      }
    }
  }

  private async writeTransaction(
    databaseTransaction: DatabaseTransaction,
    input: RecordingInput,
    snapshot: DecisionSnapshot,
  ): Promise<void> {
    const { transactions } = this.dependencies;
    if (input.mode.kind === 'arrival') {
      await transactions.insertDecided(databaseTransaction, input.transaction, snapshot, input.correlationId);
    } else {
      await transactions.resolvePending(databaseTransaction, input.transaction, snapshot, input.mode.availableAt);
    }
  }

  /** P1 = C: toda reversão aplicada ganha sua linha; o ROLLBACK de um REFUND marca o REFUND como desfeito. */
  private async recordReversal(
    databaseTransaction: DatabaseTransaction,
    input: RecordingInput,
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<void> {
    const { transaction, reference } = input;
    if (transaction.kind !== 'REFUND' && transaction.kind !== 'ROLLBACK') return;
    if (reference === undefined) throw new Error('reversão aplicada sem referência');
    const targetDirection = reference.ledgerDirectionFor();
    if (targetDirection === null) throw new Error('referência de reversão sem efeito no saldo');
    await this.dependencies.transactions.recordReversal(databaseTransaction, {
      reversalId: transaction.id,
      reversalKind: transaction.kind,
      direction,
      targetId: reference.id,
      targetKind: reference.kind,
      targetDirection,
      walletId: transaction.walletId,
      money: transaction.money,
      createdAt: input.at,
    });
    if (transaction.kind === 'ROLLBACK' && reference.kind === 'REFUND') {
      await this.dependencies.transactions.markReversalUndone(databaseTransaction, reference.id, transaction.id);
    }
  }

  private async nudge(databaseTransaction: DatabaseTransaction, transaction: WagerTransaction): Promise<void> {
    await this.dependencies.transactions.nudgeDependents(
      databaseTransaction,
      transaction.walletId,
      transaction.providerId,
      transaction.externalTransactionId,
    );
  }

  private eventContext(input: RecordingInput): EventContext {
    return {
      eventId: this.dependencies.idGenerator.next(),
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: input.at,
    };
  }
}
