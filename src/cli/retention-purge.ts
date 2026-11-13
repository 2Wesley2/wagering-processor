import { RetentionPurger } from '../modules/messaging/infrastructure/retention-purger.ts';
import { ConfigError, loadConfig } from '../platform/config/config.ts';
import { createLogger, writeFatalLine } from '../platform/observability/logger.ts';
import { AutocommitSql, createOrm } from '../platform/persistence/unit-of-work.ts';

/**
 * `bun run retention:purge`: uma rodada da limpeza por retenção (a mesma que o papel
 * `outbox-publisher` roda a cada `RETENTION_INTERVAL_MS`). Inbox há mais de RETENTION_INBOX_DAYS
 * (≥ 30) e outbox publicada há mais de RETENTION_OUTBOX_DAYS (≥ 7); nada financeiro é apagado.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger({
    level: config.logLevel,
    instanceId: config.instanceId,
    roles: ['retention-purge'],
    sync: true,
  });
  const orm = await createOrm({
    databaseUrl: config.databaseUrl,
    poolMax: 1,
    applicationName: `retention:${config.instanceId}`,
    queryTimeoutMs: config.database.queryTimeoutMs,
    connectTimeoutMs: config.database.connectTimeoutMs,
  });
  try {
    await new RetentionPurger(new AutocommitSql(orm), logger, config.retention).purge();
  } finally {
    await orm.close(true);
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const code = error instanceof ConfigError ? error.code : 'retention.failed';
    writeFatalLine(code, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
