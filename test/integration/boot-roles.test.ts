import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { M0001_FINANCIAL_SCHEMA } from '../../src/platform/persistence/migrations/0001-financial-schema.ts';
import { M0002_REVERSALS_AND_PENDING_REFERENCES } from '../../src/platform/persistence/migrations/0002-reversals-and-pending-references.ts';
import { runMigrations } from '../../src/platform/persistence/migrator.ts';
import { ensureDatabase } from '../../src/platform/persistence/pg-admin.ts';
import { appUrl, dropTestDatabase, ownerUrl, withAdmin } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, stringField } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { consumerEnv, inboxRows, sendMessage, wagerMessage } from '../support/messaging.ts';
import { waitResolved } from '../support/pending.ts';
import { testDbName } from '../support/run-context.ts';
import { startTcpProxy } from '../support/tcp-proxy.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * IT-29: boot por papel (D01), recusa com migration pendente (D20), contexto de log (ALS) no
 * consumidor e no worker (§12) e partida sem crash loop com PostgreSQL ou SQS ausentes (D44).
 */
let fixture: Fixture;
const extraDatabases: string[] = [];

beforeAll(async () => {
  fixture = await createFixture('boot');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  for (const database of extraDatabases) await dropTestDatabase(database);
  await fixture.dispose();
});

async function stop(instance: Instance): Promise<void> {
  signal(instance, 'SIGTERM');
  await instance.exited;
}

describe('[IT-29] boot por papel e partida resiliente', () => {
  test('[IT-29] papel consumer: só health e métricas no HTTP; consumidor ligado, publicador e worker não', async () => {
    const instance = startInstance({ id: 'boot-consumer', env: fixture.env({ APP_ROLES: 'consumer' }) });
    await waitReady(instance);
    const post = await api(instance.baseUrl, 'POST', '/wallets', {
      json: { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '1.00', currency: 'BRL' } },
    });
    expect(post.status).toBe(404);
    const events = instance.logs.events();
    expect(events).toContain('consumer.started');
    expect(events).not.toContain('outbox_publisher.started');
    expect(events).not.toContain('pending_reference_worker.started');
    await stop(instance);

    const publisher = startInstance({ id: 'boot-publisher', env: fixture.env({ APP_ROLES: 'outbox-publisher' }) });
    await waitReady(publisher);
    expect(publisher.logs.events()).toContain('outbox_publisher.started');
    expect(publisher.logs.events()).not.toContain('consumer.started');
    await stop(publisher);
  });

  test('[IT-29] migration pendente: a app recusa subir (exit 1) e diz quais faltam', async () => {
    const database = testDbName('boot_pending');
    extraDatabases.push(database);
    await withAdmin((admin) => ensureDatabase(admin, database));
    await runMigrations(ownerUrl(database), 'up', [M0001_FINANCIAL_SCHEMA, M0002_REVERSALS_AND_PENDING_REFERENCES]);
    const instance = startInstance({ id: 'boot-pending', env: fixture.env({ DATABASE_URL: appUrl(database) }) });
    expect(await instance.exited).toEqual({ exitCode: 1, signalCode: null });
    // Até a 0002 o role da app não lê a lista de migrations: a 0003 (que concede a leitura) é a pendente.
    expect(instance.logs.find('boot.pending_migrations')).toMatchObject({
      pending: ['Migration0003InboxAndDeadLetter', 'Migration0004RetentionAndProjection'],
      listReadable: false,
    });
  });

  test('[IT-29] contexto de log: consumidor (messageId, correlationId, transactionId) e worker (walletId)', async () => {
    const instance = startInstance({
      id: 'boot-als',
      env: consumerEnv(fixture, { APP_ROLES: 'api,consumer,pending-reference-worker' }),
    });
    await waitReady(instance);
    const wallet = await openWallet(instance.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    await sendMessage(fixture, message);
    await eventually(async () => (await inboxRows(fixture.database, message.messageId))[0], {
      timeoutMs: 15_000,
      describe: 'mensagem processada',
    });
    const processed = await instance.logs.waitFor('consumer.processed', 5000);
    expect(processed).toMatchObject({ messageId: message.messageId, correlationId: message.messageId });
    expect(typeof processed['transactionId']).toBe('string');

    const pending = await send(
      instance.baseUrl,
      submission(wallet, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'nunca-chega' }),
    );
    expect(pending.status).toBe(202);
    const pendingId = stringField(pending.body, 'transactionId');
    await waitResolved(fixture.database, [pendingId], 20_000);
    const resolved = await instance.logs.waitFor('pending_reference.resolved', 5000);
    expect(resolved).toMatchObject({
      walletId: wallet.walletId,
      correlationId: `pending-reference-worker:${wallet.walletId}`,
    });
    await stop(instance);
  });

  test('[IT-29] PostgreSQL ausente no boot: o processo espera (sem crash loop) e fica pronto quando o banco volta', async () => {
    const target = new URL(fixture.databaseUrl);
    const proxy = startTcpProxy({ hostname: target.hostname, port: Number.parseInt(target.port || '5432', 10) });
    try {
      proxy.mode('blackhole');
      const viaProxy = new URL(fixture.databaseUrl);
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.port);
      const instance = startInstance({
        id: 'boot-nopg',
        env: fixture.env({ DATABASE_URL: viaProxy.toString(), DB_CONNECT_TIMEOUT_MS: '500' }),
      });
      await instance.logs.waitFor('boot.waiting_dependency', 15_000);
      await Bun.sleep(1500);
      const stillAlive = await Promise.race([instance.exited.then(() => false), Promise.resolve(true)]);
      expect(stillAlive).toBe(true);
      proxy.mode('pass');
      await waitReady(instance, 30_000);
      expect(instance.logs.find('boot.dependency_ready')).toMatchObject({ dependency: 'postgres' });
      await stop(instance);
    } finally {
      proxy.stop();
    }
  });

  test('[IT-29] SQS ausente no boot: a app sobe com ready 503 e fica pronta quando o SQS volta', async () => {
    const target = new URL(process.env['SQS_ENDPOINT'] ?? '');
    const proxy = startTcpProxy({ hostname: target.hostname, port: Number.parseInt(target.port || '80', 10) });
    try {
      proxy.mode('blackhole');
      const viaProxy = new URL(target.toString());
      viaProxy.hostname = '127.0.0.1';
      viaProxy.port = String(proxy.port);
      const instance = startInstance({
        id: 'boot-nosqs',
        env: consumerEnv(fixture, { SQS_ENDPOINT: viaProxy.toString() }),
      });
      const notReady = await eventually(
        async () => {
          const response = await fetch(`${instance.baseUrl}/health/ready`, { signal: AbortSignal.timeout(3000) }).catch(
            () => undefined,
          );
          return response?.status === 503 ? response.status : undefined;
        },
        { timeoutMs: 20_000, describe: 'ready 503 com o SQS fora' },
      );
      expect(notReady).toBe(503);
      proxy.mode('pass');
      await waitReady(instance, 30_000);
      await stop(instance);
    } finally {
      proxy.stop();
    }
  });
});
