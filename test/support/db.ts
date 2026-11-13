import pg from 'pg';
import {
  APP_ROLE,
  connect,
  ensureDatabase,
  OWNER_ROLE,
  type RolePasswords,
  withCredentials,
} from '../../src/platform/persistence/pg-admin.ts';
import { assertTestDbName, requiredEnv, testDbName } from './run-context.ts';

export function adminUrl(): string {
  return requiredEnv('PG_ADMIN_URL');
}

export function passwords(): RolePasswords {
  return {
    ownerPassword: requiredEnv('OWNER_DB_PASSWORD'),
    appPassword: requiredEnv('APP_DB_PASSWORD'),
  };
}

export function appUrl(database: string): string {
  return withCredentials(adminUrl(), APP_ROLE, passwords().appPassword, database);
}

export function ownerUrl(database: string): string {
  return withCredentials(adminUrl(), OWNER_ROLE, passwords().ownerPassword, database);
}

export async function withAdmin<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await connect(adminUrl(), 'wagering:test-admin');
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** Banco isolado do teste, clonado do template migrado no preflight (D45). */
export async function createTestDatabase(suffix: string): Promise<string> {
  const name = testDbName(suffix);
  const template = requiredEnv('TEST_TEMPLATE_DB');
  await withAdmin((admin) => ensureDatabase(admin, name, template));
  return name;
}

export async function dropTestDatabase(name: string): Promise<void> {
  assertTestDbName(name);
  await withAdmin(async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
  });
}

export async function queryAs<T extends pg.QueryResultRow>(
  url: string,
  sql: string,
  parameters: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await connect(url, 'wagering:test-query');
  try {
    return await client.query<T>(sql, parameters);
  } finally {
    await client.end();
  }
}
