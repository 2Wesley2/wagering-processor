import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field } from '../support/http.ts';
import { startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';

/**
 * IT-07a: atomicidade do POST /wallets. A falha é injetada DEPOIS do último
 * INSERT e antes do COMMIT (uow.beforeCommit). Só o caminho de wallets é coberto
 * aqui; HTTP de transações, worker e SQS são IT-07b/c/d (F3/F4/F5).
 */
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture('it07a');
});
afterAll(async () => {
  await fixture.dispose();
});

async function rowsFor(playerId: string): Promise<{ wallets: string; tx: string; ledger: string; outbox: string }> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const response = await client.query<{ wallets: string; tx: string; ledger: string; outbox: string }>(
      `SELECT (SELECT count(*) FROM wallets WHERE player_id = $1::uuid)::text AS wallets,
              (SELECT count(*) FROM wager_transactions WHERE player_id = $1::uuid)::text AS tx,
              (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger,
              (SELECT count(*) FROM outbox_messages)::text AS outbox`,
      [playerId],
    );
    return response.rows[0] ?? { wallets: '?', tx: '?', ledger: '?', outbox: '?' };
  });
}

const body = (playerId: string) => ({ json: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } } });
const nothing = { wallets: '0', tx: '0', ledger: '0', outbox: '0' };

describe('[IT-07a] atomicidade no caminho POST /wallets', () => {
  test('[IT-07a] falha depois do último INSERT e antes do COMMIT → 500 e nenhuma linha', async () => {
    const app = startInstance({
      id: 'it07a-fail',
      env: fixture.env({
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'fail' }]),
      }),
    });
    await waitReady(app);
    const playerId = Bun.randomUUIDv7();
    const response = await api(app.baseUrl, 'POST', '/wallets', body(playerId));
    expect([response.status, field(response.body, 'code')]).toEqual([500, 'INTERNAL_ERROR']);
    expect(app.logs.find('fault.injected')?.['point']).toBe('uow.beforeCommit');
    expect(await rowsFor(playerId)).toEqual(nothing);
  });

  test('[IT-07a] processo morto (SIGKILL) dentro da transação → nenhuma linha e backend encerrado', async () => {
    const app = startInstance({
      id: 'it07a-kill',
      env: fixture.env({
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'kill' }]),
      }),
    });
    await waitReady(app);
    const playerId = Bun.randomUUIDv7();
    const request = await api(app.baseUrl, 'POST', '/wallets', body(playerId)).then(
      () => 'respondeu',
      () => 'conexão interrompida',
    );
    const exit = await app.exited;
    const marker = app.logs.find('fault.injected');
    const backends = await eventually(
      async () => {
        const n = await withClient(
          ownerUrl(fixture.database),
          async (client) =>
            (
              await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = 'app:it07a-kill'`,
              )
            ).rows[0]?.n,
        );
        return n === '0' ? n : undefined;
      },
      { timeoutMs: 15_000, intervalMs: 250, describe: 'backends da instância morta encerrados' },
    );
    const rows = await rowsFor(playerId);
    writeEvidence('IT-07a-kill', { request, exit, marker, killLog: app.killLog, backends, rows });
    expect(request).toBe('conexão interrompida');
    expect(marker?.['point']).toBe('uow.beforeCommit');
    expect([exit.signalCode, exit.exitCode]).toEqual(['SIGKILL', null]);
    expect(app.killLog).toEqual([]);
    expect(rows).toEqual(nothing);
  });

  test('[IT-07a] depois das falhas, uma instância normal cria a mesma wallet (nada ficou preso)', async () => {
    const app = startInstance({ id: 'it07a-ok', env: fixture.env() });
    await waitReady(app);
    const playerId = Bun.randomUUIDv7();
    expect((await api(app.baseUrl, 'POST', '/wallets', body(playerId))).status).toBe(201);
    expect(await rowsFor(playerId)).toEqual({ wallets: '1', tx: '1', ledger: '1', outbox: '2' });
  });
});
