import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import type pg from 'pg';
import { MIGRATIONS } from './migrations/index.ts';
import type { RegisteredMigration } from './migrations/sql-migration.ts';
import { connect, MIGRATE_LOCK_KEY } from './pg-admin.ts';

const CHECKSUM_TABLE = 'wagering_migration_checksums';

export class MigrationChecksumError extends Error {
  constructor(readonly migration: string) {
    super(`migration já aplicada foi alterada: ${migration}`);
    this.name = 'MigrationChecksumError';
  }
}

export class UnknownAppliedMigrationError extends Error {
  constructor(readonly migration: string) {
    super(`migration aplicada no banco não existe no código: ${migration}`);
    this.name = 'UnknownAppliedMigrationError';
  }
}

export interface MigrationReport {
  readonly direction: 'up' | 'down';
  readonly executed: readonly string[];
  readonly alreadyApplied: readonly string[];
  readonly pending: readonly string[];
}

async function verifyChecksums(
  client: pg.Client,
  migrations: readonly RegisteredMigration[],
  applied: readonly string[],
): Promise<void> {
  const rows = await client.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM ${CHECKSUM_TABLE}`);
  const stored = new Map(rows.rows.map((row) => [row.name, row.checksum]));
  for (const name of applied) {
    const registered = migrations.find((migration) => migration.name === name);
    if (registered === undefined) throw new UnknownAppliedMigrationError(name);
    const checksum = stored.get(name);
    if (checksum === undefined) {
      await client.query(`INSERT INTO ${CHECKSUM_TABLE} (name, checksum) VALUES ($1, $2)`, [name, registered.checksum]);
    } else if (checksum !== registered.checksum) {
      throw new MigrationChecksumError(name);
    }
  }
}

/**
 * Executa migrations com o MikroORM (lista explícita, sem glob), serializadas por
 * advisory lock: dois jobs simultâneos não disputam o DDL (D20).
 */
export async function runMigrations(
  ownerUrl: string,
  direction: 'up' | 'down' = 'up',
  migrations: readonly RegisteredMigration[] = MIGRATIONS,
): Promise<MigrationReport> {
  const lock = await connect(ownerUrl, 'wagering:migrate');
  await lock.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATE_LOCK_KEY]);
  try {
    await lock.query(
      `CREATE TABLE IF NOT EXISTS ${CHECKSUM_TABLE} (
         name text PRIMARY KEY,
         checksum text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const orm = await MikroORM.init({
      clientUrl: ownerUrl,
      entities: [],
      discovery: { warnWhenNoEntities: false },
      extensions: [Migrator],
      allowGlobalContext: true,
      debug: false,
      migrations: {
        tableName: 'mikro_orm_migrations',
        transactional: true,
        allOrNothing: true,
        snapshot: false,
        silent: true,
        migrationsList: migrations.map((migration) => ({ name: migration.name, class: migration.migrationClass })),
      },
    });
    try {
      const migrator = orm.migrator;
      const applied = (await migrator.getExecuted()).map((migration) => migration.name);
      await verifyChecksums(lock, migrations, applied);

      if (direction === 'down') {
        const reverted = (await migrator.down()).map((migration) => migration.name);
        for (const name of reverted) await lock.query(`DELETE FROM ${CHECKSUM_TABLE} WHERE name = $1`, [name]);
        const pending = (await migrator.getPending()).map((migration) => migration.name);
        return { direction, executed: reverted, alreadyApplied: applied, pending };
      }

      const executed = (await migrator.up()).map((migration) => migration.name);
      for (const name of executed) {
        const registered = migrations.find((migration) => migration.name === name);
        if (registered !== undefined) {
          await lock.query(
            `INSERT INTO ${CHECKSUM_TABLE} (name, checksum) VALUES ($1, $2)
             ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
            [name, registered.checksum],
          );
        }
      }
      const pending = (await migrator.getPending()).map((migration) => migration.name);
      return { direction, executed, alreadyApplied: applied, pending };
    } finally {
      await orm.close(true);
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATE_LOCK_KEY]);
    await lock.end();
  }
}
