import { PurgeQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appUrl, ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import {
  consumerEnv,
  copiesIn,
  effectsOfExternal,
  inboxRows,
  runCli,
  sendMessage,
  wagerMessage,
} from '../support/messaging.ts';
import { assertTestQueueName } from '../support/run-context.ts';
import { failureOf, withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission, type TestWallet } from '../support/wagering.ts';

/**
 * IT-27b: perda do broker contra o MiniStack de TESTE (isolado do emulador da aplicação), com
 * PurgeQueue liberado só para filas de teste. A prova é a projeção que CONSOME a fila de eventos
 * (`events-projection`), não o sucesso do SendMessage.
 *
 * (a) Regra do DedupId: reenviar com DedupId = eventId dentro da janela de 5 min é engolido pelo
 *     FIFO; o `outbox:republish` (DedupId `rp:<eventId>:<runId>`) chega e a projeção aplica 1×.
 * (b) Perda de eventos publicados: purge da fila de eventos → `outbox:republish --since` → a
 *     projeção recebe e aplica cada evento uma vez.
 * (c) Entradas perdidas antes do consumo: nenhuma transação é criada; o reenvio é do produtor.
 * Retenção: só a outbox publicada há mais de 7 dias e a inbox com mais de 30 dias saem; o que sai
 * da outbox não pode mais ser republicado.
 */
let fixture: Fixture;
let api: Instance;
let publisher: Instance | undefined;
let projection: Instance | undefined;

beforeAll(async () => {
  fixture = await createFixture('brkloss');
  api = startInstance({ id: 'brk-api', env: fixture.env() });
  await waitReady(api);
});
afterAll(async () => {
  for (const instance of [publisher, projection]) if (instance !== undefined) await stop(instance);
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function stop(instance: Instance): Promise<void> {
  signal(instance, 'SIGTERM');
  await instance.exited;
}

async function startRole(id: string, role: string): Promise<Instance> {
  const instance = startInstance({ id, env: fixture.env({ APP_ROLES: role }) });
  await waitReady(instance);
  return instance;
}

const sql = <T extends Record<string, unknown>>(text: string, parameters: unknown[] = []) =>
  withClient(ownerUrl(fixture.database), async (client) => (await client.query<T>(text, parameters)).rows);

async function eventsOf(walletId: string): Promise<{ id: string; type: string; payload: string }[]> {
  return sql<{ id: string; type: string; payload: string }>(
    `SELECT id::text AS id, event_type AS type, payload::text AS payload FROM outbox_messages
      WHERE aggregate_id = $1::uuid ORDER BY seq`,
    [walletId],
  );
}

async function waitPublished(walletId: string): Promise<void> {
  await eventually(
    async () => {
      const [row] = await sql<{ n: string }>(
        'SELECT count(*)::text AS n FROM outbox_messages WHERE aggregate_id = $1::uuid AND published_at IS NULL',
        [walletId],
      );
      return row?.n === '0' ? true : undefined;
    },
    { timeoutMs: 15_000, describe: 'eventos da wallet publicados' },
  );
}

async function purge(url: string, name: string): Promise<void> {
  assertTestQueueName(name);
  await fixture.sqs.send(new PurgeQueueCommand({ QueueUrl: url }));
  await eventually(async () => ((await copiesIn(fixture.sqs, url)) === 0 ? true : undefined), {
    timeoutMs: 10_000,
    describe: `fila ${name} vazia depois do purge`,
  });
}

function projectionLog(event: string, eventId: string): number {
  return (projection?.logs.entries ?? []).filter((entry) => entry.event === event && entry['eventId'] === eventId)
    .length;
}

async function walletWithBets(bets: number): Promise<TestWallet> {
  const wallet = await openWallet(api.baseUrl, '100.00');
  for (let index = 0; index < bets; index++) await send(api.baseUrl, submission(wallet, { amount: '10.00' }));
  return wallet;
}

describe('[IT-27b] perda do broker e republicação intencional', () => {
  test('[IT-27b] (b) eventos publicados e perdidos (purge): outbox:republish --since → a projeção recebe e aplica cada um 1×', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    publisher = await startRole('brk-pub', 'outbox-publisher');
    const wallet = await walletWithBets(2);
    await waitPublished(wallet.walletId);
    await purge(fixture.events.url, fixture.events.name);
    const events = await eventsOf(wallet.walletId);
    expect(events).toHaveLength(6);

    const run = await runCli(fixture, 'outbox-republish', ['--since', since, '--aggregate', wallet.walletId]);
    expect(run.exitCode).toBe(0);
    const report = run.logs.find('outbox.republished');
    expect(report).toMatchObject({ selected: 6, republished: 6, failed: 0 });

    projection = await startRole('brk-proj', 'events-projection');
    await eventually(
      () => (events.every((event) => projectionLog('projection.applied', event.id) === 1) ? true : undefined),
      { timeoutMs: 20_000, describe: 'projeção aplicou os 6 eventos republicados' },
    );
    const [projected] = await sql<{ balance: string; version: string }>(
      'SELECT balance::text AS balance, wallet_version::text AS version FROM wallet_events_projection WHERE wallet_id = $1::uuid',
      [wallet.walletId],
    );
    writeEvidence('IT-27b-b', {
      report,
      received: events.map((event) => projectionLog('projection.received', event.id)),
      projected,
    });
    expect(projected).toEqual({ balance: '80.00', version: '3' });
  });

  test('[IT-27b] (a) DedupId = eventId dentro de 5 min é engolido; rp:<eventId>:<runId> chega 2×, aplicado 1×; tentativas da mesma execução repetem o id', async () => {
    if (projection !== undefined) await stop(projection);
    projection = undefined;
    const wallet = await walletWithBets(1);
    await waitPublished(wallet.walletId);
    const events = await eventsOf(wallet.walletId);
    const target = events.at(-1);
    if (target === undefined) throw new Error('sem eventos');
    // Configuração proibida, usada só aqui: DedupId = eventId (mesmo da publicação original).
    await fixture.sqs.send(
      new SendMessageCommand({
        QueueUrl: fixture.events.url,
        MessageBody: target.payload,
        MessageGroupId: wallet.walletId,
        MessageDeduplicationId: target.id,
      }),
    );
    // Republicação correta, com a 1ª tentativa falhando de propósito (failOnce).
    const run = await runCli(fixture, 'outbox-republish', ['--since', '2000-01-01T00:00:00Z', '--event', target.id], {
      FAULT_INJECTION: 'enabled',
      FAULT_PLAN: JSON.stringify([
        { point: 'republish.beforeSend', action: 'failOnce', match: { eventId: target.id } },
      ]),
    });
    expect(run.exitCode).toBe(0);
    const attempts = run.logs.entries
      .filter((entry) => entry.event === 'outbox.republish_attempt')
      .map((entry) => ({ attempt: entry['attempt'], accepted: entry['accepted'], id: entry['deduplicationId'] }));
    expect(attempts.map((item) => [item.attempt, item.accepted])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(attempts[0]?.id).toBe(attempts[1]?.id);
    expect(String(attempts[0]?.id)).toMatch(new RegExp(`^rp:${target.id}:[0-9a-f-]{36}$`));
    const second = await runCli(fixture, 'outbox-republish', ['--since', '2000-01-01T00:00:00Z', '--event', target.id]);
    const secondId = second.logs.find('outbox.republish_attempt')?.['deduplicationId'];
    expect(secondId).not.toBe(attempts[0]?.id);

    projection = await startRole('brk-proj2', 'events-projection');
    await eventually(() => (projectionLog('projection.received', target.id) >= 3 ? true : undefined), {
      timeoutMs: 20_000,
      describe: 'projeção recebeu o evento original e as duas republicações',
    });
    await Bun.sleep(2000);
    const counts = {
      received: projectionLog('projection.received', target.id),
      applied: projectionLog('projection.applied', target.id),
      duplicate: projectionLog('projection.duplicate', target.id),
    };
    writeEvidence('IT-27b-a', { target: target.id, attempts, secondId, counts });
    // Original + 2 execuções do republish; a cópia com DedupId = eventId não chegou.
    expect(counts).toEqual({ received: 3, applied: 1, duplicate: 2 });
  });

  test('[IT-27b] (c) entradas perdidas antes do consumo: nenhuma transação; o que já comitou fica intacto', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const lost = [
      wagerMessage(submission(wallet, { amount: '10.00' })),
      wagerMessage(submission(wallet, { amount: '20.00' })),
    ];
    for (const message of lost) await sendMessage(fixture, message);
    await purge(fixture.inbound.url, fixture.inbound.name);
    const consumer = startInstance({ id: 'brk-consumer', env: consumerEnv(fixture) });
    await waitReady(consumer);
    await Bun.sleep(3000);
    await stop(consumer);
    for (const message of lost) {
      expect(await inboxRows(fixture.database, message.messageId)).toEqual([]);
      expect(
        (await effectsOfExternal(fixture.database, String(message.data['externalTransactionId']))).transactions,
      ).toBe(0);
    }
    writeEvidence('IT-27b-c', { lost: lost.length, created: 0 });
  });

  test('[IT-27b] retenção: sai só a outbox publicada há > 7 dias e a inbox com > 30 dias; o resto (e o financeiro) fica', async () => {
    if (publisher !== undefined) await stop(publisher);
    publisher = undefined;
    const wallet = await openWallet(api.baseUrl, '100.00');
    const financialBefore = await sql<Record<string, string>>(
      `SELECT (SELECT count(*) FROM wallets)::text AS wallets, (SELECT count(*) FROM wager_transactions)::text AS transactions,
              (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger`,
    );
    const ids = { old: Bun.randomUUIDv7(), recent: Bun.randomUUIDv7(), unpublished: Bun.randomUUIDv7() };
    const insertEvent = (id: string, createdDaysAgo: number, publishedDaysAgo: number | null) =>
      sql(
        `INSERT INTO outbox_messages (id, aggregate_id, message_group_id, event_type, event_version, payload, created_at, published_at)
         VALUES ($1::uuid, $2::uuid, $2::text, 'RetentionProbe', 1, jsonb_build_object('eventId', $1::text, 'eventType', 'RetentionProbe'),
                 now() - make_interval(days => $3), CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END)`,
        [id, wallet.walletId, createdDaysAgo, publishedDaysAgo],
      );
    await insertEvent(ids.old, 9, 8);
    await insertEvent(ids.recent, 2, 1);
    await insertEvent(ids.unpublished, 9, null);
    const inbox = { old: `ret-old-${Bun.randomUUIDv7()}`, recent: `ret-new-${Bun.randomUUIDv7()}` };
    const insertInbox = (messageId: string, daysAgo: number) =>
      sql(
        `INSERT INTO inbox_messages (consumer_name, message_id, envelope_hash, outcome, transaction_id, processed_at)
         VALUES ('wager-transactions', $1, $2, 'PROCESSED', NULL, now() - make_interval(days => $3))`,
        [messageId, `v1:${'a'.repeat(64)}`, daysAgo],
      );
    await insertInbox(inbox.old, 31);
    await insertInbox(inbox.recent, 29);

    // O banco recusa prazo abaixo do mínimo, mesmo pedido pelo role da app.
    const tooShort = await failureOf(() =>
      withClient(appUrl(fixture.database), (client) =>
        client.query('SELECT * FROM wagering_purge_retention(6, 7, 100)'),
      ),
    );
    expect(tooShort).toMatchObject({ code: '22023' });

    const run = await runCli(fixture, 'retention-purge');
    expect(run.exitCode).toBe(0);
    const purged = run.logs.find('retention.purged');
    const remaining = await sql<{ id: string }>(
      'SELECT id::text AS id FROM outbox_messages WHERE id = ANY($1::uuid[])',
      [[ids.old, ids.recent, ids.unpublished]],
    );
    const inboxLeft = await sql<{ id: string }>(
      'SELECT message_id AS id FROM inbox_messages WHERE message_id = ANY($1::text[])',
      [[inbox.old, inbox.recent]],
    );
    const financialAfter = await sql<Record<string, string>>(
      `SELECT (SELECT count(*) FROM wallets)::text AS wallets, (SELECT count(*) FROM wager_transactions)::text AS transactions,
              (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger`,
    );
    const republish = await runCli(fixture, 'outbox-republish', [
      '--since',
      '2000-01-01T00:00:00Z',
      '--event',
      ids.old,
    ]);
    writeEvidence('IT-27b-retention', { purged, remaining, inboxLeft, financialBefore, financialAfter });
    expect(purged).toMatchObject({ inboxDeleted: 1, outboxDeleted: 1 });
    expect(remaining.map((row) => row.id).toSorted((left, right) => left.localeCompare(right))).toEqual(
      [ids.recent, ids.unpublished].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(inboxLeft.map((row) => row.id)).toEqual([inbox.recent]);
    expect(financialAfter).toEqual(financialBefore);
    // O que a retenção apagou não pode mais ser republicado.
    expect(republish.logs.find('outbox.republished')).toMatchObject({ selected: 0, republished: 0 });
  });
});
