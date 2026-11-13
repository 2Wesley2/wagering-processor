import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { signal, startInstance, waitReady } from '../support/instances.ts';
import { consumeMessages, eventIdOf } from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * IT-25: dois publicadores sobre a mesma outbox (D38). Cada evento chega à fila de eventos, todo
 * `published_at` é preenchido e um claim vencido de um publicador "morto" é retomado sem erro.
 */
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture('obx');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const outbox = (sql: string, parameters: unknown[] = []) =>
  withClient(
    ownerUrl(fixture.database),
    async (client) => (await client.query<Record<string, unknown>>(sql, parameters)).rows,
  );

describe('[IT-25] publicadores concorrentes da outbox', () => {
  test('[IT-25] 2 publicadores: cada evento publicado; claims vencidos retomados; nenhum erro de rodada', async () => {
    const api = startInstance({ id: 'obx-api', env: fixture.env() });
    await waitReady(api);
    for (let index = 0; index < 8; index++) {
      const wallet = await openWallet(api.baseUrl, '100.00');
      for (let bet = 0; bet < 3; bet++) await send(api.baseUrl, submission(wallet, { amount: '1.00' }));
    }
    signal(api, 'SIGTERM');
    await api.exited;

    // Publicador "morto": dois eventos com claim de outro dono, um já vencido e outro vencendo em 2 s.
    const stale = await outbox(
      `UPDATE outbox_messages SET claim_token = gen_random_uuid(), claimed_until = clock_timestamp() - interval '1 second'
        WHERE id IN (SELECT id FROM outbox_messages ORDER BY seq LIMIT 1) RETURNING id::text AS id`,
    );
    const leased = await outbox(
      `UPDATE outbox_messages SET claim_token = gen_random_uuid(), claimed_until = clock_timestamp() + interval '2 seconds'
        WHERE id IN (SELECT id FROM outbox_messages ORDER BY seq DESC LIMIT 1) RETURNING id::text AS id`,
    );
    const expected = (await outbox('SELECT id::text AS id FROM outbox_messages')).map((row) => String(row['id']));
    expect(expected).toHaveLength(8 * 2 + 8 * 3 * 2);

    const publishers = ['obx-p1', 'obx-p2'].map((id) =>
      startInstance({ id, env: fixture.env({ APP_ROLES: 'outbox-publisher' }) }),
    );
    await Promise.all(publishers.map((publisher) => waitReady(publisher)));
    const bodies = await consumeMessages(fixture.sqs, fixture.events.url, expected.length, 30_000);
    const received = bodies.map(eventIdOf);
    const unpublished = await outbox('SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL');
    const failures = publishers.flatMap((publisher) =>
      publisher.logs.entries.filter((entry) => entry.event === 'outbox_publisher.tick_failed'),
    );
    const startedPublishers = publishers.map(
      (publisher) => publisher.logs.entries.filter((entry) => entry.event === 'outbox_publisher.started').length,
    );
    writeEvidence('IT-25', {
      expected: expected.length,
      received: received.length,
      distinct: new Set(received).size,
      unpublished: unpublished.length,
      failures: failures.length,
      startedPublishers,
    });
    expect(new Set(received)).toEqual(new Set(expected));
    expect(received).toHaveLength(expected.length);
    expect(unpublished).toEqual([]);
    expect(failures).toEqual([]);
    for (const row of [...stale, ...leased]) expect(received).toContain(String(row['id']));
    for (const publisher of publishers) signal(publisher, 'SIGTERM');
    const exits = await Promise.all(publishers.map((publisher) => publisher.exited));
    expect(exits).toEqual([
      { exitCode: 0, signalCode: null },
      { exitCode: 0, signalCode: null },
    ]);
  });
});
