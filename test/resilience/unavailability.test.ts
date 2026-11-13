import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import {
  consumeMessages,
  consumerEnv,
  effectsOfExternal,
  eventIdOf,
  inboxRows,
  sendMessage,
  wagerMessage,
} from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * IT-24: PostgreSQL e SQS indisponíveis, simulados por proxies TCP (D46). Com o banco fora: 503
 * retentável no HTTP, ready 503 e o breaker do consumidor pausa a recepção sem ack; ao voltar, tudo
 * é processado uma vez. Com o SQS fora: o caminho financeiro segue (o HTTP não depende da fila),
 * ready 503 e a outbox acumula; ao voltar, a outbox drena.
 */
let fixture: Fixture;
let pgProxy: TcpProxy;
let sqsProxy: TcpProxy;
let instance: Instance;

function viaProxy(url: string, proxy: TcpProxy): string {
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(proxy.port);
  return parsed.toString();
}

beforeAll(async () => {
  fixture = await createFixture('unavail');
  const pg = new URL(fixture.databaseUrl);
  pgProxy = startTcpProxy({ hostname: pg.hostname, port: Number.parseInt(pg.port || '5432', 10) });
  const sqs = new URL(process.env['SQS_ENDPOINT'] ?? '');
  sqsProxy = startTcpProxy({ hostname: sqs.hostname, port: Number.parseInt(sqs.port || '80', 10) });
  instance = startInstance({
    id: 'unavail-1',
    env: consumerEnv(fixture, {
      APP_ROLES: 'api,consumer,outbox-publisher',
      DATABASE_URL: viaProxy(fixture.databaseUrl, pgProxy),
      SQS_ENDPOINT: viaProxy(process.env['SQS_ENDPOINT'] ?? '', sqsProxy).replace(/\/$/, ''),
      DB_LOCK_TIMEOUT_MS: '500',
      DB_STATEMENT_TIMEOUT_MS: '1000',
      DB_QUERY_TIMEOUT_MS: '1500',
      DB_CONNECT_TIMEOUT_MS: '500',
      CONSUMER_BREAKER_OPEN_MS: '1000',
    }),
  });
  await waitReady(instance);
});
afterAll(async () => {
  signal(instance, 'SIGTERM');
  await instance.exited;
  pgProxy.stop();
  sqsProxy.stop();
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function readyStatus(): Promise<number> {
  const response = await fetch(`${instance.baseUrl}/health/ready`, { signal: AbortSignal.timeout(5000) });
  return response.status;
}

const unpublished = () =>
  withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ id: string }>(
      'SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL',
    );
    return result.rows.map((row) => row.id);
  });

describe('[IT-24] PostgreSQL e SQS indisponíveis', () => {
  test('[IT-24] PostgreSQL fora: HTTP 503 retentável, ready 503, breaker sem ack; ao voltar, processamento único', async () => {
    const wallet = await openWallet(instance.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(submission(wallet, { amount: '5.00' }));
    pgProxy.mode('blackhole');
    try {
      const response = await send(instance.baseUrl, bet);
      expect([response.status, field(response.body, 'code'), field(response.body, 'retryable')]).toEqual([
        503,
        'DATABASE_UNAVAILABLE',
        true,
      ]);
      expect(response.headers.get('retry-after')).not.toBeNull();
      expect(await readyStatus()).toBe(503);
      await sendMessage(fixture, message);
      const breaker = await instance.logs.waitFor('consumer.breaker_open', 30_000);
      expect(breaker['openMs']).toBe(1000);
    } finally {
      pgProxy.mode('pass');
    }
    await eventually(async () => ((await readyStatus()) === 200 ? true : undefined), {
      timeoutMs: 20_000,
      describe: 'ready 200 com o banco de volta',
    });
    await eventually(async () => (await inboxRows(fixture.database, message.messageId))[0], {
      timeoutMs: 30_000,
      describe: 'mensagem processada depois da volta do banco',
    });
    const retry = await send(instance.baseUrl, bet);
    expect(retry.status).toBe(200);
    await instance.logs.waitFor('consumer.breaker_closed', 10_000);
    const effects = {
      http: await effectsOfExternal(fixture.database, bet.externalTransactionId),
      sqs: await effectsOfExternal(fixture.database, String(message.data['externalTransactionId'])),
      inbox: (await inboxRows(fixture.database, message.messageId)).length,
    };
    writeEvidence('IT-24-postgres', effects);
    expect(effects).toEqual({
      http: { transactions: 1, entries: 1, statuses: ['PROCESSED'] },
      sqs: { transactions: 1, entries: 1, statuses: ['PROCESSED'] },
      inbox: 1,
    });
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('85.00');
  });

  test('[IT-24] SQS fora: o HTTP segue, ready 503 e a outbox acumula; ao voltar, a outbox drena e os eventos chegam', async () => {
    await eventually(async () => ((await unpublished()).length === 0 ? true : undefined), {
      timeoutMs: 20_000,
      describe: 'outbox vazia antes do teste',
    });
    await consumeMessages(fixture.sqs, fixture.events.url, Number.MAX_SAFE_INTEGER, 2000);
    sqsProxy.mode('blackhole');
    let accumulated: string[];
    try {
      const wallet = await openWallet(instance.baseUrl, '100.00');
      expect((await send(instance.baseUrl, submission(wallet, { amount: '10.00' }))).status).toBe(200);
      expect(await readyStatus()).toBe(503);
      await Bun.sleep(3000);
      accumulated = await unpublished();
      expect(accumulated.length).toBeGreaterThanOrEqual(4);
    } finally {
      sqsProxy.mode('pass');
    }
    await eventually(async () => ((await unpublished()).length === 0 ? true : undefined), {
      timeoutMs: 60_000,
      describe: 'outbox drenada depois da volta do SQS',
    });
    const received = (await consumeMessages(fixture.sqs, fixture.events.url, accumulated.length, 20_000)).map(
      eventIdOf,
    );
    writeEvidence('IT-24-sqs', { accumulated: accumulated.length, received: received.length });
    for (const eventId of accumulated) expect(received).toContain(eventId);
    await eventually(async () => ((await readyStatus()) === 200 ? true : undefined), {
      timeoutMs: 20_000,
      describe: 'ready 200 com o SQS de volta',
    });
  });
});
