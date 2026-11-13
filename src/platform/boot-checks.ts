import { MIGRATIONS } from './persistence/migrations/index.ts';
import { connect } from './persistence/pg-admin.ts';
import type { AppLogger } from './observability/logger.ts';

export class PendingMigrationsError extends Error {
  constructor(
    readonly pending: readonly string[],
    /** Falso quando a lista de aplicadas não pôde ser lida (o role da app ainda não tem acesso). */
    readonly listReadable: boolean,
  ) {
    super(`migrations pendentes: ${pending.join(', ')}`);
    this.name = 'PendingMigrationsError';
  }
}

/** A partir desta migration o role da app lê a lista de migrations aplicadas. */
const FIRST_READABLE = 'Migration0003InboxAndDeadLetter';

/**
 * Espera o PostgreSQL responder, sem limite e sem derrubar o processo (D44: partida resiliente, sem
 * crash loop). Cada falha é logada; o intervalo cresce até 5 s.
 */
export async function waitForDatabase(databaseUrl: string, logger: AppLogger): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await connect(databaseUrl, 'wagering:boot');
      try {
        await client.query('SELECT 1');
      } finally {
        await client.end();
      }
      if (attempt > 1) logger.info({ event: 'boot.dependency_ready', dependency: 'postgres' }, 'boot.dependency_ready');
      return;
    } catch (error) {
      logger.warn(
        {
          event: 'boot.waiting_dependency',
          dependency: 'postgres',
          attempt,
          error: error instanceof Error ? error.message : String(error),
        },
        'boot.waiting_dependency',
      );
      await Bun.sleep(Math.min(5000, 250 * attempt));
    }
  }
}

/**
 * A app recusa subir com migration pendente (D20): o job `migrate` é quem aplica. Sem permissão de
 * leitura na lista (42501), a migration que concede a leitura ainda não foi aplicada: ela e as
 * seguintes estão pendentes, e as anteriores não podem ser conferidas (`listReadable: false`).
 */
export async function assertMigrationsApplied(databaseUrl: string): Promise<void> {
  const names = MIGRATIONS.map((migration) => migration.name);
  const client = await connect(databaseUrl, 'wagering:boot');
  try {
    const result = await client.query<{ name: string }>('SELECT name FROM mikro_orm_migrations');
    const applied = new Set(result.rows.map((row) => row.name));
    const pending = names.filter((name) => !applied.has(name));
    if (pending.length > 0) throw new PendingMigrationsError(pending, true);
  } catch (error) {
    if (error instanceof PendingMigrationsError) throw error;
    const sqlState = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (sqlState === '42501') throw new PendingMigrationsError(names.slice(names.indexOf(FIRST_READABLE)), false);
    if (sqlState === '42P01') throw new PendingMigrationsError(names, true);
    throw error;
  } finally {
    await client.end();
  }
}
