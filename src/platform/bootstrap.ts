import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.ts';
import { PgProbe, SqsProbe } from '../modules/health/probes.ts';
import { type AppConfig, ConfigError, loadConfig } from './config/config.ts';
import { requestContextMiddleware } from './http/request-context.ts';
import { createFaultInjector } from './lifecycle/fault-injection.ts';
import { ReadinessState } from './lifecycle/readiness.ts';
import { ShutdownCoordinator } from './lifecycle/shutdown.ts';
import { type AppLogger, createLogger, PinoNestLogger, writeFatalLine } from './observability/logger.ts';
import { createMetricsRegistry } from './observability/metrics.ts';
import { composeServices } from './composition.ts';
import { createAuthentication } from './http/authentication.ts';
import { createOrm } from './persistence/unit-of-work.ts';
import { assertMigrationsApplied, PendingMigrationsError, waitForDatabase } from './boot-checks.ts';
import { httpMetricsMiddleware, registerOperationalGauges } from './observability/operational-metrics.ts';
import { QueueDirectory } from './sqs/queue-directory.ts';
import { QueueProvisioner, queueTopology } from './sqs/queue-provisioner.ts';
import { createSqsClient } from './sqs/sqs-client.ts';

export const APP_VERSION = '0.1.0';

function loadConfigOrExit(env: Readonly<Record<string, string | undefined>>): AppConfig {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      writeFatalLine(error.code, error.message);
      process.exit(1);
    }
    throw error;
  }
}

/** Reprovisiona as filas no boot sem bloquear a subida; um SQS ausente é tentado de novo. */
async function provisionWithRetry(provision: () => Promise<void>, logger: AppLogger): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt++) {
    try {
      await provision();
      return;
    } catch (error) {
      logger.warn(
        {
          event: 'boot.waiting_dependency',
          dependency: 'sqs',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
        'boot.waiting_dependency',
      );
      await Bun.sleep(Math.min(5000, 500 * attempt));
    }
  }
}

/** Sobe a aplicação. Configuração inválida → log fatal + exit 1, nunca um boot parcial. */
export async function bootstrap(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = loadConfigOrExit(env);
  const logger = createLogger({
    level: config.logLevel,
    instanceId: config.instanceId,
    roles: [...config.roles],
    sync: config.nodeEnv === 'test',
  });

  // Partida resiliente (D44): espera o PostgreSQL sem crash loop; recusa migration pendente (D20).
  await waitForDatabase(config.databaseUrl, logger);
  try {
    await assertMigrationsApplied(config.databaseUrl);
  } catch (error) {
    if (error instanceof PendingMigrationsError) {
      logger.fatal(
        { event: 'boot.pending_migrations', pending: error.pending, listReadable: error.listReadable },
        'boot.pending_migrations',
      );
      logger.flush();
      process.exit(1);
    }
    throw error;
  }

  const readiness = new ReadinessState();
  const sqsClient = createSqsClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    requestTimeoutMs: config.healthTimeoutMs,
    maxAttempts: 1,
  });
  const pgProbe = new PgProbe(config.databaseUrl, config.healthTimeoutMs, config.instanceId);
  const sqsProbe = new SqsProbe(sqsClient, config.sqs.inboundQueue, config.healthTimeoutMs);
  const faultInjector = createFaultInjector(config);
  const metrics = createMetricsRegistry(config.instanceId, APP_VERSION);
  const orm = await createOrm({
    databaseUrl: config.databaseUrl,
    poolMax: config.dbPoolMax,
    applicationName: `app:${config.instanceId}`,
    queryTimeoutMs: config.database.queryTimeoutMs,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  // Cliente da mensageria: o timeout cobre o long poll (WaitTimeSeconds) com folga.
  const messagingSqs = createSqsClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    requestTimeoutMs: config.sqs.waitTimeS * 1000 + 5000,
  });
  const provisionQueues = async (): Promise<void> => {
    const results = await new QueueProvisioner(messagingSqs).ensureAll(
      queueTopology({
        inboundQueue: config.sqs.inboundQueue,
        dlq: config.sqs.dlq,
        eventsQueue: config.sqs.eventsQueue,
        visibilityTimeoutS: config.sqs.visibilityTimeoutS,
        waitTimeS: config.sqs.waitTimeS,
        maxReceiveCount: config.sqs.maxReceiveCount,
      }),
    );
    logger.info(
      { event: 'sqs.provisioned', queues: results.map((result) => `${result.name}:${result.action}`) },
      'sqs.provisioned',
    );
  };
  const queues = new QueueDirectory(messagingSqs, config.sqs.provisionOnBoot ? provisionQueues : undefined);
  const {
    walletService,
    wageringService,
    pendingReferenceWorker,
    consumer,
    outboxPublisher,
    projection,
    retentionPurger,
    autocommit,
  } = composeServices({
    orm,
    config,
    logger,
    metrics,
    faults: faultInjector,
    sqs: messagingSqs,
    queues,
  });
  const authentication = createAuthentication(config.authenticationAdapter);

  // bodyParser desligado: o corpo é lido com limite em readJsonBody (413/415/400 como problem+json).
  const app = await NestFactory.create(
    AppModule.forRoot({
      config,
      logger,
      readiness,
      pgProbe,
      sqsProbe,
      faultInjector,
      metrics,
      walletService,
      wageringService,
      authentication,
    }),
    { logger: new PinoNestLogger(logger), abortOnError: false, bodyParser: false },
  );
  app.use(requestContextMiddleware(config.instanceId));
  app.use(httpMetricsMiddleware(metrics));
  registerOperationalGauges(metrics, {
    sql: autocommit,
    sqs: messagingSqs,
    queues,
    queueNames: [config.sqs.inboundQueue, config.sqs.dlq, config.sqs.eventsQueue],
    timeoutMs: config.healthTimeoutMs,
  });

  new ShutdownCoordinator({
    app,
    config,
    logger,
    readiness,
    drainers: [
      () => consumer.stop(config.shutdown.drainMs),
      () => outboxPublisher.stop(),
      () => retentionPurger.stop(),
      () => projection.stop(),
      () => pendingReferenceWorker.stop(),
    ],
    closers: [
      () => pgProbe.close(),
      () => orm.close(true),
      () => {
        sqsClient.destroy();
        messagingSqs.destroy();
        return Promise.resolve();
      },
    ],
  }).install();

  await app.listen(config.port, '0.0.0.0');
  if (config.sqs.provisionOnBoot) void provisionWithRetry(provisionQueues, logger);
  if (config.roles.has('pending-reference-worker')) pendingReferenceWorker.start();
  if (config.roles.has('outbox-publisher')) {
    outboxPublisher.start();
    retentionPurger.start();
  }
  if (config.roles.has('events-projection')) projection.start();
  if (config.roles.has('consumer')) consumer.start();
  logger.info(
    { event: 'app.ready', port: config.port, roles: [...config.roles], faultInjection: faultInjector.enabled },
    'app.ready',
  );
}
