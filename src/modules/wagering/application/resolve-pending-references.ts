import type { RejectionCode } from '../../../shared/error-catalog.ts';
import type { Clock, DatabaseTransaction, UnitOfWork } from '../../../shared/ports.ts';
import type { WalletRepository } from '../../wallet/application/ports.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import {
  EMPTY_REVERSAL_VIEW,
  type ReferenceRelationCode,
  referenceRelationViolation,
  type SettlementDecision,
  type SettlementPolicy,
} from '../domain/settlement-policy.ts';
import { rehydrateTransaction } from './original-response.ts';
import type { PendingEntry, PendingResolutionObserver, TimedTransaction, TransactionStore } from './ports.ts';
import type { SettlementRecorder } from './settlement-recorder.ts';

const TERMINAL_STATUSES = new Set(['PROCESSED', 'REJECTED', 'FAILED']);

/** Profundidade máxima de uma cadeia de pendências (u1 → r1 → b1, §7 regra 3). */
const MAX_CHAIN_DEPTH = 3;

type Outcome =
  | {
      readonly type: 'DECIDE';
      readonly reference: TimedTransaction;
      readonly availableAt: bigint;
    }
  | {
      readonly type: 'EXPIRE';
      readonly code: Extract<RejectionCode, 'REFERENCE_NOT_FOUND' | 'REFERENCE_NOT_PROCESSED'> | ReferenceRelationCode;
      readonly reference: TimedTransaction | undefined;
      readonly availableAt: bigint;
    }
  | { readonly type: 'WAIT'; readonly effectiveDeadline: bigint }
  /**
   * A referência foi aceita até o prazo efetivo e ainda está pendente: o desfecho depende do dela.
   * Mesmo com o prazo vencido, a pendência não expira antes de a referência ser avaliada.
   */
  | { readonly type: 'AWAIT_DEPENDENCY'; readonly effectiveDeadline: bigint; readonly dependency: TimedTransaction };

export interface WalletResolution {
  readonly decided: number;
  readonly waiting: number;
}

export interface ResolvePendingReferencesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly wallets: WalletRepository;
  readonly transactions: TransactionStore;
  readonly recorder: SettlementRecorder;
  readonly policy: SettlementPolicy;
  readonly observer: PendingResolutionObserver;
  readonly clock: Clock;
  readonly batchSize: number;
  /** Atraso até a próxima checagem de uma pendência que ainda espera (backoff exponencial, D40). */
  readonly backoffMs: (attempts: number) => number;
}

// Instantes exatos do PostgreSQL (µs); nenhuma comparação passa por `Date`.
const latest = (left: bigint, right: bigint): bigint => (left >= right ? left : right);
const earliest = (left: bigint, right: bigint): bigint => (left <= right ? left : right);
const MICROSECONDS_PER_MILLISECOND = 1000n;

/** Linhas 6 e 7 da política entre a pendência e a referência (atributos imutáveis). */
const relationViolation = (pending: TimedTransaction, reference: TimedTransaction): ReferenceRelationCode | undefined =>
  referenceRelationViolation(rehydrateTransaction(pending.row), rehydrateTransaction(reference.row));

/** Estado de uma rodada do worker numa wallet, sob o lock dela. */
interface WalletPass {
  readonly databaseTransaction: DatabaseTransaction;
  readonly wallet: Wallet;
  readonly now: bigint;
  remaining: PendingEntry[];
  readonly waiting: Map<string, bigint>;
  decided: number;
  pulled: number;
}

/** Resolve pendências sob o lock da wallet, com prazos calculados a partir dos instantes do PostgreSQL (D40). */
export class ResolvePendingReferences {
  constructor(private readonly dependencies: ResolvePendingReferencesDependencies) {}

  async resolveWallet(walletId: string): Promise<WalletResolution> {
    return this.dependencies.unitOfWork.run(async (databaseTransaction) => {
      const { wallets, transactions } = this.dependencies;
      const wallet = await wallets.lockForUpdate(databaseTransaction, walletId);
      if (wallet === undefined) return { decided: 0, waiting: 0 };
      // Status relido sob o lock: uma pendência já resolvida por outra instância não aparece aqui.
      const batch = await transactions.pendingOfWallet(databaseTransaction, walletId, this.dependencies.batchSize);
      const pass: WalletPass = {
        databaseTransaction,
        wallet,
        now: await transactions.databaseNow(databaseTransaction),
        remaining: batch,
        waiting: new Map<string, bigint>(),
        decided: 0,
        pulled: 0,
      };
      while (await this.step(pass));
      for (const entry of pass.remaining) await this.reschedule(pass, entry);
      return { decided: pass.decided, waiting: pass.remaining.length };
    });
  }

  /**
   * Um passo de Kahn: decide a 1ª pendência (em ordem de aceite) que já pode ser decidida, ou traz
   * para o lote a referência pendente de que ela depende. Falso quando nada mais avança.
   */
  private async step(pass: WalletPass): Promise<boolean> {
    for (const entry of pass.remaining) {
      const outcome = await this.outcomeFor(pass.databaseTransaction, entry, pass.now, 0);
      if (outcome.type === 'WAIT' || outcome.type === 'AWAIT_DEPENDENCY') {
        pass.waiting.set(entry.row.id, outcome.effectiveDeadline);
        if (outcome.type === 'AWAIT_DEPENDENCY' && (await this.pullDependency(pass, outcome.dependency))) return true;
        continue;
      }
      await this.apply(pass.databaseTransaction, pass.wallet, entry, outcome);
      pass.decided += 1;
      pass.waiting.delete(entry.row.id);
      pass.remaining = pass.remaining.filter((other) => other.row.id !== entry.row.id);
      return true;
    }
    return false;
  }

  /** Acrescenta ao lote a referência pendente da mesma wallet que está fora dele. */
  private async pullDependency(pass: WalletPass, dependency: TimedTransaction): Promise<boolean> {
    if (pass.pulled >= Math.max(this.dependencies.batchSize, MAX_CHAIN_DEPTH)) return false;
    // Referência de outra wallet: não está sob este lock; a pendência espera o worker daquela wallet.
    if (dependency.row.walletId !== pass.wallet.id) return false;
    if (pass.remaining.some((entry) => entry.row.id === dependency.row.id)) return false;
    const entry = await this.dependencies.transactions.findPendingEntry(pass.databaseTransaction, dependency.row.id);
    if (entry === undefined) return false;
    pass.remaining = [...pass.remaining, entry];
    pass.pulled += 1;
    return true;
  }

  private async reschedule(pass: WalletPass, entry: PendingEntry): Promise<void> {
    const { now } = pass;
    const deadline = pass.waiting.get(entry.row.id) ?? now;
    const backoff = now + BigInt(this.dependencies.backoffMs(entry.attempts)) * MICROSECONDS_PER_MILLISECOND;
    // Nunca depois do prazo efetivo: a expiração é processada na hora certa.
    const nextCheckAt = deadline > now ? earliest(backoff, deadline) : backoff;
    await this.dependencies.transactions.reschedule(pass.databaseTransaction, entry.row.id, nextCheckAt);
  }

  private async outcomeFor(
    databaseTransaction: DatabaseTransaction,
    pending: TimedTransaction,
    now: bigint,
    depth: number,
  ): Promise<Outcome> {
    const reference = await this.referenceOf(databaseTransaction, pending);
    const effectiveDeadline = await this.effectiveDeadline(databaseTransaction, pending, reference, depth);
    if (
      reference !== undefined &&
      reference.row.status === 'PENDING_REFERENCE' &&
      reference.instants.acceptedAt <= effectiveDeadline
    ) {
      const relationCode = relationViolation(pending, reference);
      if (relationCode === undefined) return { type: 'AWAIT_DEPENDENCY', effectiveDeadline, dependency: reference };
      // Dependência inválida: nunca é esperada; a pendência é rejeitada no prazo.
      if (effectiveDeadline > now) return { type: 'WAIT', effectiveDeadline };
      return { type: 'EXPIRE', code: relationCode, reference, availableAt: effectiveDeadline };
    }
    // Uma referência disponível a tempo ainda deve ser avaliada se o worker rodar depois do prazo.
    const referenceAvailableAt = reference?.instants.availableAt ?? null;
    if (
      reference !== undefined &&
      TERMINAL_STATUSES.has(reference.row.status) &&
      referenceAvailableAt !== null &&
      referenceAvailableAt <= effectiveDeadline
    ) {
      return {
        type: 'DECIDE',
        reference,
        availableAt: latest(pending.instants.acceptedAt, referenceAvailableAt),
      };
    }
    if (effectiveDeadline <= now) {
      const acceptedInTime = reference !== undefined && reference.instants.acceptedAt <= effectiveDeadline;
      return {
        type: 'EXPIRE',
        code: acceptedInTime ? 'REFERENCE_NOT_PROCESSED' : 'REFERENCE_NOT_FOUND',
        reference,
        availableAt: effectiveDeadline,
      };
    }
    return { type: 'WAIT', effectiveDeadline };
  }

  /** Prazo efetivo de uma pendência (D40): estende-se pela cadeia de pendências aceitas a tempo. */
  private async effectiveDeadline(
    databaseTransaction: DatabaseTransaction,
    pending: TimedTransaction,
    reference: TimedTransaction | undefined,
    depth: number,
  ): Promise<bigint> {
    const deadline = pending.instants.pendingDeadlineAt;
    if (deadline === null) throw new Error(`pendência ${pending.row.id} sem prazo gravado`);
    if (
      depth >= MAX_CHAIN_DEPTH ||
      reference === undefined ||
      reference.row.initialStatus !== 'PENDING_REFERENCE' ||
      reference.instants.acceptedAt > deadline ||
      // Só uma dependência válida estende o prazo (impede ciclos e cadeias inválidas).
      relationViolation(pending, reference) !== undefined
    ) {
      return deadline;
    }
    const referenceOfReference = await this.referenceOf(databaseTransaction, reference);
    return latest(
      deadline,
      await this.effectiveDeadline(databaseTransaction, reference, referenceOfReference, depth + 1),
    );
  }

  private async referenceOf(
    databaseTransaction: DatabaseTransaction,
    pending: TimedTransaction,
  ): Promise<TimedTransaction | undefined> {
    if (pending.row.referenceExternalTransactionId === null) return undefined;
    return this.dependencies.transactions.findTimedByProviderAndExternalId(
      databaseTransaction,
      pending.row.providerId,
      pending.row.referenceExternalTransactionId,
    );
  }

  private async apply(
    databaseTransaction: DatabaseTransaction,
    wallet: Wallet,
    pendingEntry: TimedTransaction,
    outcome: Extract<Outcome, { type: 'DECIDE' | 'EXPIRE' }>,
  ): Promise<void> {
    const { transactions, policy, recorder, clock } = this.dependencies;
    const pendingRow = pendingEntry.row;
    const pending = rehydrateTransaction(pendingRow);
    const reference = outcome.reference === undefined ? undefined : rehydrateTransaction(outcome.reference.row);
    let decision: SettlementDecision;
    if (outcome.type === 'EXPIRE') {
      decision = { type: 'REJECT', code: outcome.code };
    } else {
      const view =
        reference?.status === 'PROCESSED'
          ? await transactions.reversalView(databaseTransaction, reference.id, pending.requiresReference())
          : EMPTY_REVERSAL_VIEW;
      decision = policy.decide(pending, { wallet, reference, view });
      if (decision.type === 'AWAIT_REFERENCE')
        throw new Error('referência terminal não pode deixar a pendência esperando');
    }
    await recorder.record(databaseTransaction, {
      transaction: pending,
      wallet,
      decision,
      reference,
      correlationId: pendingRow.correlationId,
      causationId: reference?.id ?? `pending-reference-deadline:${pending.id}`,
      at: clock.now(),
      mode: { kind: 'resolution', availableAt: outcome.availableAt },
    });
    this.dependencies.observer.resolved(
      {
        transactionId: pending.id,
        walletId: pending.walletId,
        providerId: pending.providerId,
        kind: pending.kind,
        status: pending.status,
        failureCode: pending.failureCode,
      },
      outcome.type === 'EXPIRE' ? 'DEADLINE' : 'REFERENCE',
    );
  }
}
