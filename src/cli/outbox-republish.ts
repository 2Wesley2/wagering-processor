import { OutboxRepublisher } from '../modules/messaging/infrastructure/outbox-republisher.ts';
import { ConfigError, loadConfig } from '../platform/config/config.ts';
import { createFaultInjector } from '../platform/lifecycle/fault-injection.ts';
import { createLogger, writeFatalLine } from '../platform/observability/logger.ts';
import { AutocommitSql, createOrm } from '../platform/persistence/unit-of-work.ts';
import { QueueDirectory } from '../platform/sqs/queue-directory.ts';
import { createSqsClient } from '../platform/sqs/sqs-client.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function argument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function dateArgument(argv: readonly string[], name: string): Date | undefined {
  const raw = argument(argv, name);
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} não é uma data ISO válida: ${raw}`);
  return date;
}

function uuidArgument(argv: readonly string[], name: string): string | undefined {
  const raw = argument(argv, name);
  if (raw !== undefined && !UUID_RE.test(raw)) throw new Error(`${name} precisa ser um UUID: ${raw}`);
  return raw?.toLowerCase();
}

/**
 * `bun run outbox:republish --since <ISO> [--until <ISO>] [--aggregate <walletId>] [--event <eventId>]`
 * Reenvia à fila de eventos os eventos JÁ PUBLICADOS que ainda estão na outbox (D38). Manual: um
 * operador decide quando rodar. Sai com 1 se algum evento não foi aceito pela fila.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const since = dateArgument(argv, '--since');
  if (since === undefined) throw new Error('--since é obrigatório (instante ISO)');
  const until = dateArgument(argv, '--until');
  const aggregateId = uuidArgument(argv, '--aggregate');
  const eventId = uuidArgument(argv, '--event');

  const config = loadConfig(process.env);
  const logger = createLogger({
    level: config.logLevel,
    instanceId: config.instanceId,
    roles: ['outbox-republish'],
    sync: true,
  });
  const orm = await createOrm({
    databaseUrl: config.databaseUrl,
    poolMax: 2,
    applicationName: `republish:${config.instanceId}`,
    queryTimeoutMs: config.database.queryTimeoutMs,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  const sqs = createSqsClient({ endpoint: config.sqs.endpoint, region: config.sqs.region, requestTimeoutMs: 10_000 });
  try {
    const report = await new OutboxRepublisher(
      new AutocommitSql(orm),
      sqs,
      new QueueDirectory(sqs, undefined),
      createFaultInjector(config),
      logger,
      config.sqs.eventsQueue,
    ).run({
      since,
      ...(until === undefined ? {} : { until }),
      ...(aggregateId === undefined ? {} : { aggregateId }),
      ...(eventId === undefined ? {} : { eventId }),
    });
    if (report.failed > 0) process.exitCode = 1;
  } finally {
    sqs.destroy();
    await orm.close(true);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    const code = error instanceof ConfigError ? error.code : 'republish.failed';
    writeFatalLine(code, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
