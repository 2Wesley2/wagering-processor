import { afterAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { M0001_FINANCIAL_SCHEMA } from '../../src/platform/persistence/migrations/0001-financial-schema.ts';
import { M0002_REVERSALS_AND_PENDING_REFERENCES } from '../../src/platform/persistence/migrations/0002-reversals-and-pending-references.ts';
import { M0003_INBOX_AND_DEAD_LETTER } from '../../src/platform/persistence/migrations/0003-inbox-and-dead-letter.ts';
import {
  MigrationChecksumError,
  runMigrations,
  UnknownAppliedMigrationError,
} from '../../src/platform/persistence/migrator.ts';
import { APP_ROLE, ensureDatabase, withCredentials } from '../../src/platform/persistence/pg-admin.ts';
import { adminUrl, dropTestDatabase, ownerUrl, passwords, withAdmin } from '../support/db.ts';
import { rejectionOf } from '../support/eventually.ts';
import { field } from '../support/http.ts';
import { LogBook } from '../support/logbook.ts';
import { requiredEnv, testDbName, testQueueName } from '../support/run-context.ts';
import { deleteTestQueue, testSqsClient } from '../support/sqs.ts';
import { withClient } from '../support/sql-fixtures.ts';

const created: string[] = [];
const sqs = testSqsClient();
const queues = {
  SQS_INBOUND_QUEUE: testQueueName('it01b-in'),
  SQS_DLQ: testQueueName('it01b-dlq'),
  SQS_EVENTS_QUEUE: testQueueName('it01b-ev'),
};

async function emptyDatabase(suffix: string): Promise<string> {
  const name = testDbName(suffix);
  created.push(name);
  await withAdmin((admin) => ensureDatabase(admin, name));
  return name;
}

/** Retrato do catálogo criado pelas migrations (sem as tabelas de controle do migrator). */
async function catalog(database: string): Promise<string[]> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ item: string }>(
      `SELECT 'rel:' || relname || ':' || relkind::text AS item FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname NOT LIKE 'mikro_orm_migrations%' AND relname NOT LIKE 'wagering_migration_checksums%'
       UNION ALL SELECT 'con:' || conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND contype NOT IN ('n')
         AND conrelid NOT IN (SELECT oid FROM pg_class WHERE relname IN ('mikro_orm_migrations', 'wagering_migration_checksums'))
       UNION ALL SELECT 'trg:' || tgname FROM pg_trigger WHERE NOT tgisinternal
       UNION ALL SELECT 'fn:' || proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       UNION ALL SELECT 'typ:' || typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'd'
       ORDER BY 1`,
    );
    return result.rows.map((row) => row.item);
  });
}

async function runCli(
  commandArguments: string[],
  env: Record<string, string>,
): Promise<{ code: number; logs: LogBook; stderr: string }> {
  const proc = Bun.spawn(['bun', ...commandArguments], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const logs = new LogBook();
  for (const line of stdout.split('\n')) logs.push(line);
  return { code: await proc.exited, logs, stderr };
}

afterAll(async () => {
  for (const database of created) await dropTestDatabase(database);
  for (const name of Object.values(queues)) {
    const url = await sqs
      .send(new GetQueueUrlCommand({ QueueName: name }))
      .then((result) => result.QueueUrl)
      .catch(() => undefined);
    if (url !== undefined) await deleteTestQueue(sqs, { name, url });
  }
  sqs.destroy();
});

describe('[IT-02] migrations reversíveis e serializadas', () => {
  test('[IT-02] up → down → up reproduz exatamente o mesmo catálogo, uma migration por vez', async () => {
    const database = await emptyDatabase('it02a');
    const first = await runMigrations(ownerUrl(database), 'up');
    expect(first.executed).toEqual([
      'Migration0001FinancialSchema',
      'Migration0002ReversalsAndPendingReferences',
      'Migration0003InboxAndDeadLetter',
      'Migration0004RetentionAndProjection',
    ]);
    const afterUp = await catalog(database);
    expect(afterUp).toContain('rel:wallets:r');
    expect(afterUp).toContain('rel:wager_reversals:r');
    expect(afterUp).toContain('typ:money_amount');
    expect(afterUp).toContain('rel:inbox_messages:r');
    expect(afterUp).toContain('rel:dead_letter_messages:r');

    // down desfaz uma migration por vez: a 0004 volta ao catálogo da 0001..0003.
    const downFourth = await runMigrations(ownerUrl(database), 'down');
    expect(downFourth.executed).toEqual(['Migration0004RetentionAndProjection']);
    const after0003 = await catalog(database);
    expect(after0003).not.toContain('rel:wallet_events_projection:r');
    expect(after0003).not.toContain('fn:wagering_purge_retention');
    const only0003 = await emptyDatabase('it02a3');
    await runMigrations(ownerUrl(only0003), 'up', [
      M0001_FINANCIAL_SCHEMA,
      M0002_REVERSALS_AND_PENDING_REFERENCES,
      M0003_INBOX_AND_DEAD_LETTER,
    ]);
    expect(after0003).toEqual(await catalog(only0003));
    const inboxGuard = async (name: string) =>
      withClient(ownerUrl(name), async (client) => {
        const result = await client.query<{ src: string }>(
          "SELECT prosrc AS src FROM pg_proc WHERE proname = 'inbox_guard'",
        );
        return result.rows[0]?.src;
      });
    expect(await inboxGuard(database)).toBe(await inboxGuard(only0003));

    // depois a 0003: volta ao catálogo da 0001 + 0002.
    const downThird = await runMigrations(ownerUrl(database), 'down');
    expect(downThird.executed).toEqual(['Migration0003InboxAndDeadLetter']);
    const after0002 = await catalog(database);
    expect(after0002).not.toContain('rel:inbox_messages:r');
    expect(after0002).not.toContain('rel:dead_letter_messages:r');
    const only0002 = await emptyDatabase('it02a2');
    await runMigrations(ownerUrl(only0002), 'up', [M0001_FINANCIAL_SCHEMA, M0002_REVERSALS_AND_PENDING_REFERENCES]);
    expect(after0002).toEqual(await catalog(only0002));

    // depois a 0002; o catálogo volta exatamente ao da 0001.
    const downLast = await runMigrations(ownerUrl(database), 'down');
    expect(downLast.executed).toEqual(['Migration0002ReversalsAndPendingReferences']);
    const after0001 = await catalog(database);
    expect(after0001).not.toContain('rel:wager_reversals:r');
    expect(after0001).not.toContain('rel:pending_reference_checks:r');
    expect(after0001).toContain('rel:wager_transactions:r');
    const only0001 = await emptyDatabase('it02a1');
    await runMigrations(ownerUrl(only0001), 'up', [M0001_FINANCIAL_SCHEMA]);
    expect(after0001).toEqual(await catalog(only0001));

    const downFirst = await runMigrations(ownerUrl(database), 'down');
    expect(downFirst.executed).toEqual(['Migration0001FinancialSchema']);
    expect(await catalog(database)).toEqual([]);

    const again = await runMigrations(ownerUrl(database), 'up');
    expect(again.executed).toEqual([
      'Migration0001FinancialSchema',
      'Migration0002ReversalsAndPendingReferences',
      'Migration0003InboxAndDeadLetter',
      'Migration0004RetentionAndProjection',
    ]);
    expect(await catalog(database)).toEqual(afterUp);
    expect((await runMigrations(ownerUrl(database), 'up')).executed).toEqual([]);
  });

  test('[IT-02] dois jobs simultâneos: a migration roda uma única vez', async () => {
    const database = await emptyDatabase('it02b');
    const [a, b] = await Promise.all([
      runMigrations(ownerUrl(database), 'up'),
      runMigrations(ownerUrl(database), 'up'),
    ]);
    expect([...a.executed, ...b.executed]).toEqual([
      'Migration0001FinancialSchema',
      'Migration0002ReversalsAndPendingReferences',
      'Migration0003InboxAndDeadLetter',
      'Migration0004RetentionAndProjection',
    ]);
    expect([...a.pending, ...b.pending]).toEqual([]);
  });
});

describe('[IT-01b] checksum de migration e convergência de senha e RedrivePolicy', () => {
  test('[IT-01b] migration aplicada e depois alterada faz o job falhar; migration desconhecida também', async () => {
    const database = await emptyDatabase('it01b');
    await runMigrations(ownerUrl(database), 'up');
    const tampered = { ...M0001_FINANCIAL_SCHEMA, checksum: `v1:${'f'.repeat(64)}` };
    expect(await rejectionOf(runMigrations(ownerUrl(database), 'up', [tampered]))).toBeInstanceOf(
      MigrationChecksumError,
    );
    expect(await rejectionOf(runMigrations(ownerUrl(database), 'up', []))).toBeInstanceOf(UnknownAppliedMigrationError);
  });

  test('[IT-01b] a senha do role da app converge no job migrate (e é restaurada)', async () => {
    const database = await emptyDatabase('it01bpw');
    const rolePasswords = passwords();
    const base = {
      PG_ADMIN_URL: requiredEnv('PG_ADMIN_URL'),
      APP_DB_NAME: database,
      OWNER_DB_PASSWORD: rolePasswords.ownerPassword,
    };
    const canConnect = (password: string) =>
      withClient(withCredentials(adminUrl(), APP_ROLE, password, database), (client) => client.query('SELECT 1')).then(
        () => true,
        () => false,
      );
    const rotatedPassword = `rotated-${crypto.randomUUID()}`;
    try {
      const rotated = await runCli(['src/cli/migrate.ts', 'up'], { ...base, APP_DB_PASSWORD: rotatedPassword });
      expect(rotated.code).toBe(0);
      expect(await canConnect(rotatedPassword)).toBe(true);
      expect(await canConnect(rolePasswords.appPassword)).toBe(false);
    } finally {
      const restored = await runCli(['src/cli/migrate.ts', 'up'], {
        ...base,
        APP_DB_PASSWORD: rolePasswords.appPassword,
      });
      expect(restored.code).toBe(0);
    }
    expect(await canConnect(rolePasswords.appPassword)).toBe(true);
  });

  test('[IT-01b] RedrivePolicy converge quando o maxReceiveCount muda', async () => {
    const env = (max: string) => ({
      SQS_ENDPOINT: requiredEnv('SQS_ENDPOINT'),
      SQS_VISIBILITY_TIMEOUT_S: '3',
      SQS_WAIT_TIME_S: '1',
      SQS_MAX_RECEIVE_COUNT: max,
      ...queues,
    });
    expect((await runCli(['src/cli/init-queues.ts'], env('5'))).code).toBe(0);
    const second = await runCli(['src/cli/init-queues.ts'], env('7'));
    expect(second.code).toBe(0);
    const inbound = second.logs.entries.find(
      (entry) => entry.event === 'init_queues.queue' && entry['name'] === queues.SQS_INBOUND_QUEUE,
    );
    expect(inbound?.['action']).toBe('updated');
    expect(inbound?.['changed']).toEqual(['RedrivePolicy']);
    const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: queues.SQS_INBOUND_QUEUE }))).QueueUrl;
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['RedrivePolicy'] }),
    );
    const redrivePolicy: unknown = JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}');
    expect(Number(field(redrivePolicy, 'maxReceiveCount'))).toBe(7);
  });
});
