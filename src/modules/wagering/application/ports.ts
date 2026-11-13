import type { IntegrationEvent } from '../../../shared/integration-event.ts';
import type { Money } from '../../../shared/money.ts';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import type { ReversalView } from '../domain/settlement-policy.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';

/**
 * Linha de `wager_transactions` já validada quanto a formato (texto para dinheiro, inteiros para
 * versões). Enums continuam texto aqui: o mapeamento para o domínio confere cada um (§6.0).
 */
export interface TransactionRow {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly currency: string;
  readonly amount: string;
  readonly referenceExternalTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly initialStatus: string;
  readonly acceptedBalance: string;
  readonly acceptedWalletVersion: number;
  readonly acceptedAt: Date;
  readonly resultBalance: string | null;
  readonly resultWalletVersion: number | null;
  readonly decidedAt: Date | null;
  /** Instante lógico em que a decisão ficou disponível (D40); nulo enquanto pendente. */
  readonly availableAt: Date | null;
  /** Prazo da pendência (aceite + TTL, relógio do PostgreSQL); só quando o aceite foi PENDING_REFERENCE. */
  readonly pendingDeadlineAt: Date | null;
  readonly correlationId: string;
  readonly createdAt: Date;
}

/**
 * Instantes de uma transação usados pela regra de prazo (D40), em microssegundos desde a época
 * Unix, exatamente como o PostgreSQL os grava. `timestamptz` tem resolução de 1 µs e `Date` só de
 * 1 ms: arredondar faria uma referência aceita 0,4 ms depois do prazo parecer aceita a tempo.
 */
export interface TransactionInstants {
  readonly acceptedAt: bigint;
  readonly availableAt: bigint | null;
  readonly pendingDeadlineAt: bigint | null;
}

/** Linha de transação com os instantes exatos (worker de pendências). */
export interface TimedTransaction {
  readonly row: TransactionRow;
  readonly instants: TransactionInstants;
}

/** Saldo e versão da wallet observados no ponto da decisão ou do aceite (D17-d, D29). */
export interface DecisionSnapshot {
  readonly balance: Money;
  readonly walletVersion: number;
}

/** Escrita e leitura de transações DENTRO da UnitOfWork (SQL explícito, D19). */
export interface TransactionStore {
  insertDecided(
    databaseTransaction: DatabaseTransaction,
    transaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    correlationId: string,
  ): Promise<void>;
  /** PENDING_REFERENCE: aceite, prazo = aceite + TTL (relógio do PostgreSQL) e linha na agenda. */
  insertPending(
    databaseTransaction: DatabaseTransaction,
    transaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    correlationId: string,
    ttlMs: number,
  ): Promise<void>;
  /**
   * Resolve uma pendência (worker, D40): grava o desfecho, o snapshot do ponto da decisão,
   * `decided_at` (relógio do PostgreSQL) e `available_at`, e tira a linha da agenda.
   */
  resolvePending(
    databaseTransaction: DatabaseTransaction,
    transaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    availableAt: bigint,
  ): Promise<void>;
  findByIdempotencyKey(
    databaseTransaction: DatabaseTransaction,
    idempotencyKey: string,
  ): Promise<TransactionRow | undefined>;
  findByProviderAndExternalId(
    databaseTransaction: DatabaseTransaction,
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRow | undefined>;
  /** Mesma busca, com os instantes exatos usados pela regra de prazo (worker, D40). */
  findTimedByProviderAndExternalId(
    databaseTransaction: DatabaseTransaction,
    providerId: string,
    externalTransactionId: string,
  ): Promise<TimedTransaction | undefined>;
  /**
   * Reversões PROCESSED sobre o alvo (e se foram desfeitas). `includeWinSettlement` acrescenta se
   * há WIN efetivo apontando para o alvo; só interessa às reversões (P2, linha 10c).
   */
  reversalView(
    databaseTransaction: DatabaseTransaction,
    targetTransactionId: string,
    includeWinSettlement: boolean,
  ): Promise<ReversalView>;
  /** Registra uma reversão aplicada em `wager_reversals` (P1 = C). */
  recordReversal(databaseTransaction: DatabaseTransaction, reversal: ReversalRecord): Promise<void>;
  /** Marca um REFUND como desfeito pelo ROLLBACK que o reverteu (`undone_by`, só de NULL para valor). */
  markReversalUndone(databaseTransaction: DatabaseTransaction, refundId: string, rollbackId: string): Promise<void>;
  /** Antecipa a checagem das pendências da MESMA wallet que referenciam a transação decidida (D40). */
  nudgeDependents(
    databaseTransaction: DatabaseTransaction,
    walletId: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<void>;
  /** Uma pendência específica, se ainda estiver PENDING_REFERENCE (referência fora do lote do worker). */
  findPendingEntry(databaseTransaction: DatabaseTransaction, transactionId: string): Promise<PendingEntry | undefined>;
  /** Pendências da wallet, em ordem de aceite (`accept_seq`), com as tentativas da agenda. */
  pendingOfWallet(databaseTransaction: DatabaseTransaction, walletId: string, limit: number): Promise<PendingEntry[]>;
  /** Reagenda uma pendência que ainda não pode ser decidida (tentativas + 1, claim liberado). */
  reschedule(databaseTransaction: DatabaseTransaction, transactionId: string, nextCheckAt: bigint): Promise<void>;
  /** `clock_timestamp()` do PostgreSQL: o relógio único das regras de prazo. */
  databaseNow(databaseTransaction: DatabaseTransaction): Promise<bigint>;
}

export interface ReversalRecord {
  readonly reversalId: string;
  readonly reversalKind: 'REFUND' | 'ROLLBACK';
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly targetId: string;
  readonly targetKind: string;
  readonly targetDirection: 'DEBIT' | 'CREDIT';
  readonly walletId: string;
  readonly money: Money;
  readonly createdAt: Date;
}

export interface PendingEntry extends TimedTransaction {
  readonly attempts: number;
}

/** Leituras fora da transação financeira: caminho rápido de idempotência e GETs. */
export interface TransactionQueries {
  findById(transactionId: string): Promise<TransactionRow | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRow | undefined>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<TransactionRow | undefined>;
}

/** Outbox transacional (§11): grava eventos na mesma transação SQL; publicação na F5. */
export interface EventOutbox {
  append(databaseTransaction: DatabaseTransaction, events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

/**
 * Entrega pela fila (D26, D35): a inbox do consumidor é gravada na MESMA transação SQL da decisão.
 * Identidade (consumidor, messageId); o hash do envelope separa a reentrega de um messageId
 * reutilizado com outro conteúdo.
 */
export interface InboxDelivery {
  readonly consumerName: string;
  readonly messageId: string;
  readonly envelopeHash: string;
}

export type InboxOutcome = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'REPLAY';

export interface InboxStore {
  /** Grava a entrega processada; falso quando outra entrega do mesmo messageId já comitou. */
  record(
    databaseTransaction: DatabaseTransaction,
    delivery: InboxDelivery,
    outcome: InboxOutcome,
    transactionId: string,
  ): Promise<boolean>;
}

/** Registro de provedores reconhecidos (D33). Lança `ProviderNotRecognizedError`. */
export interface ProviderIdentity {
  assertMaySubmit(providerId: string): void;
}

export interface DecisionRecord {
  readonly transactionId: string;
  readonly walletId: string;
  readonly providerId: string;
  readonly kind: string;
  readonly status: string;
  readonly failureCode: string | undefined;
}

/** Observação do worker de pendências (logs e métricas ficam na infraestrutura). */
export interface PendingResolutionObserver {
  resolved(record: DecisionRecord, reason: 'REFERENCE' | 'DEADLINE'): void;
}

/** Observação do caso de uso (logs e métricas ficam na infraestrutura). */
export interface SubmissionObserver {
  decided(record: DecisionRecord): void;
  replayed(record: { readonly transactionId: string; readonly providerId: string; readonly status: string }): void;
  conflict(code: 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_CONFLICT', providerId: string): void;
  uniqueRace(constraint: string): void;
  /** Duração de uma submissão completa (decisão, replay ou erro), em segundos (D42). */
  completed(durationSeconds: number, outcome: 'ok' | 'error'): void;
}
