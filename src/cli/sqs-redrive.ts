import { DeadLetterStore } from '../modules/messaging/infrastructure/dead-letter-store.ts';
import { Redriver } from '../modules/messaging/infrastructure/redriver.ts';
import { ConfigError, loadConfig } from '../platform/config/config.ts';
import { createFaultInjector } from '../platform/lifecycle/fault-injection.ts';
import { createLogger, writeFatalLine } from '../platform/observability/logger.ts';
import { AutocommitSql, createOrm } from '../platform/persistence/unit-of-work.ts';
import { QueueDirectory } from '../platform/sqs/queue-directory.ts';
import { createSqsClient } from '../platform/sqs/sqs-client.ts';

/**
 * `bun run sqs:redrive [--idle-rounds N]`: devolve à fila de origem as cópias da DLQ (D36). Usa a
 * mesma configuração da app (DATABASE_URL, filas, CONSUMER_NAME). Rodar de novo é seguro.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idleArgument = argv.includes('--idle-rounds') ? argv[argv.indexOf('--idle-rounds') + 1] : undefined;
  const idleRounds = idleArgument === undefined ? 2 : Number.parseInt(idleArgument, 10);
  if (!Number.isSafeInteger(idleRounds) || idleRounds < 1) throw new Error(`--idle-rounds inválido: ${idleArgument}`);

  const config = loadConfig(process.env);
  const logger = createLogger({
    level: config.logLevel,
    instanceId: config.instanceId,
    roles: ['sqs-redrive'],
    sync: true,
  });
  const orm = await createOrm({
    databaseUrl: config.databaseUrl,
    poolMax: 2,
    applicationName: `redrive:${config.instanceId}`,
    queryTimeoutMs: config.database.queryTimeoutMs,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  const sqs = createSqsClient({ endpoint: config.sqs.endpoint, region: config.sqs.region, requestTimeoutMs: 10_000 });
  try {
    const redriver = new Redriver(
      sqs,
      new QueueDirectory(sqs, undefined),
      new DeadLetterStore(new AutocommitSql(orm)),
      createFaultInjector(config),
      logger,
      {
        sourceQueue: config.sqs.inboundQueue,
        dlq: config.sqs.dlq,
        consumerName: config.consumer.name,
        visibilityTimeoutS: config.sqs.redriveVisibilityTimeoutS,
        idleRounds,
      },
    );
    await redriver.run();
  } finally {
    sqs.destroy();
    await orm.close(true);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const code = error instanceof ConfigError ? error.code : 'redrive.failed';
    writeFatalLine(code, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
