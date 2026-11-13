import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { eventually } from '../support/eventually.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { consumeMessages, eventIdOf, faultPlan } from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * CT-06: dois publicadores na mesma outbox, com queda depois de publicar e antes de marcar, e
 * depois do claim (D38, D47). Oráculo: o conjunto recebido é a outbox inteira; duplicatas só do
 * lote interrompido, cada evento no máximo 2×. Variante com lote de 1.
 */
let fixture: Fixture;
let api: Instance;

beforeAll(async () => {
  fixture = await createFixture('pcrash');
  api = startInstance({ id: 'pcrash-api', env: fixture.env() });
  await waitReady(api);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const rows = (sql: string, parameters: unknown[] = []) =>
  withClient(ownerUrl(fixture.database), async (client) => (await client.query<{ id: string }>(sql, parameters)).rows);

async function produceEvents(wallets: number): Promise<void> {
  for (let index = 0; index < wallets; index++) {
    const wallet = await openWallet(api.baseUrl, '100.00');
    await send(api.baseUrl, submission(wallet, { amount: '1.00' }));
  }
}

async function firstUnpublished(): Promise<string> {
  const found = await rows(
    'SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL ORDER BY seq LIMIT 1',
  );
  const id = found[0]?.id;
  if (id === undefined) throw new Error('outbox sem evento pendente');
  return id;
}

interface ScenarioResult {
  readonly name: string;
  readonly interrupted: string[];
}

/**
 * A vítima publica sozinha até cair no ponto escolhido; depois dois publicadores sobem juntos e
 * publicam tudo; o cenário termina com a outbox inteira publicada e os publicadores encerrados.
 */
async function scenario(name: string, point: string, batchSize: string): Promise<ScenarioResult> {
  await produceEvents(4);
  const target = await firstUnpublished();
  const env = { APP_ROLES: 'outbox-publisher', OUTBOX_BATCH_SIZE: batchSize };
  const victim = startInstance({
    id: `pcrash-${name}-a`,
    env: fixture.env({ ...env, ...faultPlan(point, 'kill', { eventId: target }) }),
  });
  const exit = await victim.exited;
  expect(exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' });
  expect(victim.killLog).toEqual([]);
  expect(victim.logs.find('fault.injected')).toMatchObject({ point, eventId: target });
  // Lote interrompido: o que a vítima reivindicou e não marcou.
  const interrupted = (
    await rows('SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL AND claimed_until IS NOT NULL')
  ).map((row) => row.id);
  expect(interrupted).toContain(target);

  const publishers = [1, 2].map((index) => startInstance({ id: `pcrash-${name}-${index}`, env: fixture.env(env) }));
  await Promise.all(publishers.map((publisher) => waitReady(publisher)));
  await eventually(
    async () =>
      (await rows('SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL')).length === 0
        ? true
        : undefined,
    { timeoutMs: 20_000, describe: `${name}: outbox inteira publicada` },
  );
  for (const publisher of publishers) {
    signal(publisher, 'SIGTERM');
    await publisher.exited;
  }
  return { name, interrupted };
}

describe('[CT-06] dois publicadores com quedas na mesma outbox', () => {
  test('[CT-06] queda depois de publicar e antes de marcar, e depois do claim (lote 10 e lote 1): nada se perde', async () => {
    const runs = [
      await scenario('publish10', 'outbox.afterPublishBeforeMark', '10'),
      await scenario('claim10', 'outbox.afterClaimBeforePublish', '10'),
      await scenario('publish1', 'outbox.afterPublishBeforeMark', '1'),
      await scenario('claim1', 'outbox.afterClaimBeforePublish', '1'),
    ];
    const all = (await rows('SELECT id::text AS id FROM outbox_messages')).map((row) => row.id);
    const bodies = await consumeMessages(fixture.sqs, fixture.events.url, all.length, 40_000);
    // Uma rodada extra curta: duplicatas que ainda estejam chegando entram na contagem.
    bodies.push(...(await consumeMessages(fixture.sqs, fixture.events.url, Number.MAX_SAFE_INTEGER, 3000)));
    const counts = new Map<string, number>();
    for (const eventId of bodies.map(eventIdOf)) counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
    const interrupted = new Set(runs.flatMap((run) => run.interrupted));
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([eventId]) => eventId);
    const unpublished = await rows('SELECT id::text AS id FROM outbox_messages WHERE published_at IS NULL');
    writeEvidence('CT-06', {
      outbox: all.length,
      received: bodies.length,
      distinct: counts.size,
      duplicated,
      interrupted: [...interrupted],
      unpublished: unpublished.length,
    });
    expect(new Set(counts.keys())).toEqual(new Set(all));
    expect(duplicated.every((eventId) => interrupted.has(eventId))).toBe(true);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
    expect(unpublished).toEqual([]);
  });
});
