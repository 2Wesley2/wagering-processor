import { afterAll, describe, expect, test } from 'bun:test';
import { GetQueueUrlCommand, ReceiveMessageCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { APP_ROLE, OWNER_ROLE } from '../../src/platform/persistence/pg-admin.ts';
import { dropTestDatabase, passwords, withAdmin } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';
import { LogBook } from '../support/logbook.ts';
import { requiredEnv, testDbName, testQueueName } from '../support/run-context.ts';
import { deleteTestQueue, testSqsClient } from '../support/sqs.ts';

const database = testDbName('it01a');
const queues = {
  SQS_INBOUND_QUEUE: testQueueName('it01a-in'),
  SQS_DLQ: testQueueName('it01a-dlq'),
  SQS_EVENTS_QUEUE: testQueueName('it01a-ev'),
};
const sqs = testSqsClient();

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
  const code = await proc.exited;
  const logs = new LogBook();
  for (const line of stdout.split('\n')) logs.push(line);
  return { code, logs, stderr };
}

async function queueUrl(name: string): Promise<string> {
  const out = await sqs.send(new GetQueueUrlCommand({ QueueName: name }));
  if (out.QueueUrl === undefined) throw new Error(`fila sem URL: ${name}`);
  return out.QueueUrl;
}

function migrateEnv(): Record<string, string> {
  const rolePasswords = passwords();
  return {
    PG_ADMIN_URL: requiredEnv('PG_ADMIN_URL'),
    APP_DB_NAME: database,
    OWNER_DB_PASSWORD: rolePasswords.ownerPassword,
    APP_DB_PASSWORD: rolePasswords.appPassword,
  };
}

function queueEnv(): Record<string, string> {
  return {
    SQS_ENDPOINT: requiredEnv('SQS_ENDPOINT'),
    SQS_VISIBILITY_TIMEOUT_S: '3',
    SQS_WAIT_TIME_S: '1',
    SQS_MAX_RECEIVE_COUNT: '5',
    ...queues,
  };
}

afterAll(async () => {
  await dropTestDatabase(database);
  for (const name of Object.values(queues)) {
    const url = await queueUrl(name).catch(() => undefined);
    if (url !== undefined) await deleteTestQueue(sqs, { name, url });
  }
  sqs.destroy();
});

describe('[IT-01a] bootstrap idempotente', () => {
  test('[IT-01a] migrate: 1ª execução cria o banco com dono e privilégios; 2ª é no-op', async () => {
    const first = await runCli(['src/cli/migrate.ts', 'up'], migrateEnv());
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
    expect(first.logs.find('migrate.bootstrap')?.['action']).toBe('created');

    const second = await runCli(['src/cli/migrate.ts', 'up'], migrateEnv());
    expect(second.code).toBe(0);
    expect(second.logs.find('migrate.bootstrap')?.['action']).toBe('existing');
    expect(second.logs.find('migrate.done')?.['executed']).toEqual([]);

    const catalog = await withAdmin(async (admin) => {
      const roles = await admin.query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean }>(
        'SELECT rolname, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
        [[OWNER_ROLE, APP_ROLE]],
      );
      const db = await admin.query<{ owner: string; public_connect: boolean; app_connect: boolean }>(
        `SELECT pg_get_userbyid(datdba) AS owner,
                has_database_privilege('public', datname, 'CONNECT') AS public_connect,
                has_database_privilege($2, datname, 'CONNECT') AS app_connect
           FROM pg_database WHERE datname = $1`,
        [database, APP_ROLE],
      );
      return { roles: roles.rows, db: db.rows[0] };
    });
    writeEvidence('IT-01a-migrate', { first: first.logs.entries, second: second.logs.entries, catalog });
    expect(catalog.roles).toEqual([
      { rolname: APP_ROLE, rolsuper: false, rolcreatedb: false },
      { rolname: OWNER_ROLE, rolsuper: false, rolcreatedb: false },
    ]);
    expect(catalog.db).toEqual({ owner: OWNER_ROLE, public_connect: false, app_connect: true });
  });

  test('[IT-01a] migrate: dois jobs simultâneos terminam sem erro (advisory lock)', async () => {
    const [a, b] = await Promise.all([
      runCli(['src/cli/migrate.ts', 'up'], migrateEnv()),
      runCli(['src/cli/migrate.ts', 'up'], migrateEnv()),
    ]);
    expect([a.code, b.code]).toEqual([0, 0]);
  });

  test('[IT-01a] init-queues: 2ª execução não recria nem apaga mensagens', async () => {
    const first = await runCli(['src/cli/init-queues.ts'], queueEnv());
    expect({ code: first.code, stderr: first.stderr }).toEqual({ code: 0, stderr: '' });
    const actions1 = first.logs.entries
      .filter((entry) => entry.event === 'init_queues.queue')
      .map((entry) => entry['action']);
    expect(actions1).toEqual(['created', 'created', 'created']);

    const inboundUrl = await queueUrl(queues.SQS_INBOUND_QUEUE);
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: inboundUrl,
        MessageBody: 'keep-me',
        MessageGroupId: 'g',
        MessageDeduplicationId: 'keep-1',
      }),
    );

    const second = await runCli(['src/cli/init-queues.ts'], queueEnv());
    expect(second.code).toBe(0);
    const actions2 = second.logs.entries
      .filter((entry) => entry.event === 'init_queues.queue')
      .map((entry) => entry['action']);
    expect(actions2).toEqual(['unchanged', 'unchanged', 'unchanged']);

    const got = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: inboundUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }),
    );
    writeEvidence('IT-01a-queues', { first: first.logs.entries, second: second.logs.entries });
    expect(got.Messages?.map((m) => m.Body)).toEqual(['keep-me']);
  });
});
