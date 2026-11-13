import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Registry } from 'prom-client';
import { systemClock, uuidV7Generator } from '../shared/ports.ts';
import { DeadLetterStore } from '../modules/messaging/infrastructure/dead-letter-store.ts';
import { OutboxPublisher } from '../modules/messaging/infrastructure/outbox-publisher.ts';
import { RetentionPurger } from '../modules/messaging/infrastructure/retention-purger.ts';
import { WalletEventsProjection } from '../modules/messaging/infrastructure/wallet-events-projection.ts';
import { SqlInboxRepository } from '../modules/messaging/infrastructure/sql-inbox-repository.ts';
import { SqlOutboxRepository } from '../modules/messaging/infrastructure/sql-outbox-repository.ts';
import { WagerMessageConsumer } from '../modules/messaging/infrastructure/wager-message-consumer.ts';
import { ResolvePendingReferences } from '../modules/wagering/application/resolve-pending-references.ts';
import { SettlementRecorder } from '../modules/wagering/application/settlement-recorder.ts';
import { SubmitWagerTransaction } from '../modules/wagering/application/submit-wager-transaction.ts';
import { WageringService } from '../modules/wagering/application/wagering-service.ts';
import { SettlementPolicy } from '../modules/wagering/domain/settlement-policy.ts';
import { SqlOpeningRecorder } from '../modules/wagering/infrastructure/opening-recorder.ts';
import {
  exponentialBackoff,
  PendingReferenceWorker,
} from '../modules/wagering/infrastructure/pending-reference-worker.ts';
import { RegistryProviderIdentity } from '../modules/wagering/infrastructure/provider-registry.ts';
import { SqlTransactionRepository } from '../modules/wagering/infrastructure/sql-transaction-repository.ts';
import {
  idempotencyViolationOf,
  LoggingPendingResolutionObserver,
  LoggingSubmissionObserver,
} from '../modules/wagering/infrastructure/submission-observer.ts';
import { OrmTransactionQueries } from '../modules/wagering/infrastructure/transaction-read-model.ts';
import { WalletService } from '../modules/wallet/application/wallet-service.ts';
import { LoggingReconciliationObserver } from '../modules/wallet/infrastructure/reconciliation-observer.ts';
import { SqlReconciliationReader } from '../modules/wallet/infrastructure/sql-reconciliation-reader.ts';
import { SqlWalletRepository } from '../modules/wallet/infrastructure/sql-wallet-repository.ts';
import { OrmWalletQueries } from '../modules/wallet/infrastructure/wallet-read-model.ts';
import type { AppConfig } from './config/config.ts';
import type { FaultInjector } from './lifecycle/fault-injection.ts';
import type { AppLogger } from './observability/logger.ts';
import { unitOfWorkMetrics } from './observability/operational-metrics.ts';
import { AutocommitSql, MikroOrmUnitOfWork } from './persistence/unit-of-work.ts';
import type { QueueDirectory } from './sqs/queue-directory.ts';

export interface CompositionDependencies {
  readonly orm: MikroORM;
  readonly config: AppConfig;
  readonly logger: AppLogger;
  readonly metrics: Registry;
  readonly faults: FaultInjector;
  /** Cliente SQS do consumidor e do publicador (timeout maior que o long poll). */
  readonly sqs: SQSClient;
  readonly queues: QueueDirectory;
}

/**
 * Raiz de composição explícita: repositórios SQL, read models do ORM e casos de uso. Wallets (F2),
 * transações (F3), worker (F4) e mensageria (F5) compartilham a mesma UnitOfWork e os mesmos
 * repositórios: HTTP e SQS passam pelo MESMO caso de uso.
 */
export function composeServices(dependencies: CompositionDependencies): {
  walletService: WalletService;
  wageringService: WageringService;
  pendingReferenceWorker: PendingReferenceWorker;
  consumer: WagerMessageConsumer;
  outboxPublisher: OutboxPublisher;
  projection: WalletEventsProjection;
  retentionPurger: RetentionPurger;
  autocommit: AutocommitSql;
} {
  const { orm, config, logger, metrics, faults, sqs, queues } = dependencies;
  const unitOfWork = new MikroOrmUnitOfWork(
    orm,
    {
      lockTimeoutMs: config.database.lockTimeoutMs,
      statementTimeoutMs: config.database.statementTimeoutMs,
      idleInTransactionTimeoutMs: config.database.idleInTransactionTimeoutMs,
      maxAttempts: 3,
    },
    faults,
    unitOfWorkMetrics(metrics),
  );
  const wallets = new SqlWalletRepository();
  const transactions = new SqlTransactionRepository();
  const outbox = new SqlOutboxRepository();
  const transactionQueries = new OrmTransactionQueries(orm);

  const walletService = new WalletService({
    unitOfWork,
    wallets,
    openings: new SqlOpeningRecorder(transactions, outbox, uuidV7Generator),
    queries: new OrmWalletQueries(orm),
    reconciliation: new SqlReconciliationReader(orm),
    observer: new LoggingReconciliationObserver(logger, metrics),
    clock: systemClock,
    idGenerator: uuidV7Generator,
  });

  const recorder = new SettlementRecorder({ wallets, transactions, outbox, idGenerator: uuidV7Generator });
  const policy = new SettlementPolicy();
  const submission = new SubmitWagerTransaction({
    unitOfWork,
    wallets,
    transactions,
    inbox: new SqlInboxRepository(),
    queries: transactionQueries,
    recorder,
    policy,
    pendingTtlMs: config.pendingReferences.ttlMs,
    providers: new RegistryProviderIdentity(config.providers),
    observer: new LoggingSubmissionObserver(logger, metrics),
    uniqueViolationOf: idempotencyViolationOf,
    clock: systemClock,
    idGenerator: uuidV7Generator,
  });

  const resolver = new ResolvePendingReferences({
    unitOfWork,
    wallets,
    transactions,
    recorder,
    policy,
    observer: new LoggingPendingResolutionObserver(logger, metrics),
    clock: systemClock,
    batchSize: config.pendingReferences.batchSize,
    backoffMs: exponentialBackoff(config.pendingReferences.backoffBaseMs, config.pendingReferences.backoffMaxMs),
  });
  const autocommit = new AutocommitSql(orm);
  const pendingReferenceWorker = new PendingReferenceWorker(
    autocommit,
    resolver,
    {
      pollIntervalMs: config.pendingReferences.pollIntervalMs,
      batchSize: config.pendingReferences.batchSize,
      leaseMs: config.pendingReferences.leaseMs,
    },
    logger,
  );

  const consumer = new WagerMessageConsumer(
    {
      sqs,
      queues,
      sql: autocommit,
      deadLetters: new DeadLetterStore(autocommit),
      submission,
      faults,
      logger,
      metrics,
    },
    {
      consumerName: config.consumer.name,
      inboundQueue: config.sqs.inboundQueue,
      dlq: config.sqs.dlq,
      pollers: config.consumer.pollers,
      waitTimeS: config.sqs.waitTimeS,
      visibilityTimeoutS: config.sqs.visibilityTimeoutS,
      retryBaseS: config.consumer.retryBaseS,
      retryMaxS: config.consumer.retryMaxS,
      deadLetterStuckAfterMs: config.consumer.deadLetterStuckAfterMs,
      breakerOpenMs: config.consumer.breakerOpenMs,
    },
  );
  const outboxPublisher = new OutboxPublisher(
    { sql: autocommit, sqs, queues, faults, logger, metrics },
    {
      eventsQueue: config.sqs.eventsQueue,
      pollIntervalMs: config.outbox.pollIntervalMs,
      batchSize: config.outbox.batchSize,
      leaseMs: config.outbox.leaseMs,
      backoffMs: exponentialBackoff(config.outbox.backoffBaseMs, config.outbox.backoffMaxMs),
    },
  );

  return {
    walletService,
    wageringService: new WageringService(submission, transactionQueries),
    pendingReferenceWorker,
    consumer,
    outboxPublisher,
    projection: new WalletEventsProjection(sqs, queues, unitOfWork, logger, metrics, {
      eventsQueue: config.sqs.eventsQueue,
      waitTimeS: config.sqs.waitTimeS,
    }),
    retentionPurger: new RetentionPurger(autocommit, logger, config.retention),
    autocommit,
  };
}
