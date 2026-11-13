import pg from 'pg';

export const OWNER_ROLE = 'wagering_owner';
export const APP_ROLE = 'wagering_app';

/** Chaves fixas de advisory lock (só para bootstrap e migração; nunca no caminho financeiro). */
export const BOOTSTRAP_LOCK_KEY = 'wagering:bootstrap';
export const MIGRATE_LOCK_KEY = 'wagering:migrate';

export interface RolePasswords {
  readonly ownerPassword: string;
  readonly appPassword: string;
}

export async function connect(url: string, applicationName: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    application_name: applicationName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

export async function waitForPostgres(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'desconhecido';
  while (Date.now() < deadline) {
    try {
      const client = await connect(url, 'wagering:wait');
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await Bun.sleep(500);
    }
  }
  throw new Error(`PostgreSQL não respondeu em ${timeoutMs} ms: ${lastError}`);
}

/** Troca usuário, senha e banco de uma URL postgres:// mantendo host e porta. */
export function withCredentials(url: string, user: string, password: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Cria os roles de forma idempotente e converge as senhas (D20).
 * O role da app não é dono de nada: recebe só os GRANTs das migrations.
 */
export async function ensureRoles(admin: pg.Client, passwords: RolePasswords): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}') THEN
        CREATE ROLE ${OWNER_ROLE} LOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN;
      END IF;
    END
    $$;`);
  await admin.query(
    `ALTER ROLE ${OWNER_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(passwords.ownerPassword)}`,
  );
  await admin.query(
    `ALTER ROLE ${APP_ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(passwords.appPassword)}`,
  );
}

export async function databaseExists(admin: pg.Client, name: string): Promise<boolean> {
  const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Garante o banco com dono wagering_owner e conexão restrita aos roles do sistema.
 * Desde o PG 15 só o dono do banco cria objetos no schema public; por isso o
 * banco criado pelo POSTGRES_DB (dono postgres) é transferido.
 */
export async function ensureDatabase(
  admin: pg.Client,
  name: string,
  template?: string,
): Promise<'created' | 'existing'> {
  const ident = admin.escapeIdentifier(name);
  let action: 'created' | 'existing' = 'existing';
  if (!(await databaseExists(admin, name))) {
    const templateClause = template === undefined ? '' : ` TEMPLATE ${admin.escapeIdentifier(template)}`;
    await admin.query(`CREATE DATABASE ${ident}${templateClause} OWNER ${OWNER_ROLE}`);
    action = 'created';
  }
  await admin.query(`ALTER DATABASE ${ident} OWNER TO ${OWNER_ROLE}`);
  await admin.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${ident} TO ${APP_ROLE}`);
  return action;
}

/** Bootstrap completo, serializado por advisory lock no banco de administração. */
export async function bootstrapDatabase(
  adminUrl: string,
  database: string,
  passwords: RolePasswords,
): Promise<{ database: string; action: 'created' | 'existing' }> {
  const admin = await connect(adminUrl, 'wagering:bootstrap');
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);
    try {
      await ensureRoles(admin, passwords);
      const action = await ensureDatabase(admin, database);
      return { database, action };
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);
    }
  } finally {
    await admin.end();
  }
}
