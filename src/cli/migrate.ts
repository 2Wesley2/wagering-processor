import { runMigrations } from '../platform/persistence/migrator.ts';
import { bootstrapDatabase, OWNER_ROLE, waitForPostgres, withCredentials } from '../platform/persistence/pg-admin.ts';

function log(level: 'info' | 'fatal', event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), event, ...data })}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`variável obrigatória ausente: ${name}`);
  return value;
}

/**
 * Job one-shot e idempotente (D20): roles + dono do banco + migrations, sob
 * advisory lock. Reexecutar não apaga dados; nunca faz `down` automático.
 */
export async function migrateMain(direction: 'up' | 'down'): Promise<void> {
  const adminUrl = required('PG_ADMIN_URL');
  const database = process.env['APP_DB_NAME'] ?? 'wagering';
  const passwords = { ownerPassword: required('OWNER_DB_PASSWORD'), appPassword: required('APP_DB_PASSWORD') };

  await waitForPostgres(adminUrl, 60_000);
  const boot = await bootstrapDatabase(adminUrl, database, passwords);
  log('info', 'migrate.bootstrap', { database: boot.database, action: boot.action });

  const ownerUrl = withCredentials(adminUrl, OWNER_ROLE, passwords.ownerPassword, database);
  const report = await runMigrations(ownerUrl, direction);
  log('info', 'migrate.done', {
    direction: report.direction,
    executed: report.executed,
    alreadyApplied: report.alreadyApplied.length,
    pending: report.pending,
  });
}

if (import.meta.main) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  migrateMain(direction).then(
    () => process.exit(0),
    (error: unknown) => {
      log('fatal', 'migrate.failed', {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      process.exit(1);
    },
  );
}
