import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field, stringField } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';

/** IT-09, IT-15 e IT-19 pela API real, com 3 instâncias da app sobre o mesmo banco. */
let fixture: Fixture;
let apps: Instance[];
let rr = 0;
const base = () => apps[rr++ % apps.length]?.baseUrl ?? '';

beforeAll(async () => {
  fixture = await createFixture('wapi');
  apps = ['wapi-1', 'wapi-2', 'wapi-3'].map((id) => startInstance({ id, env: fixture.env() }));
  await Promise.all(apps.map((a) => waitReady(a)));
});
afterAll(async () => {
  await fixture.dispose();
});

const newPlayer = () => Bun.randomUUIDv7();
const open = (playerId: string, amount: string, currency = 'BRL') =>
  api(base(), 'POST', '/wallets', { json: { playerId, initialBalance: { amount, currency } } });

async function persisted(
  playerId: string,
): Promise<{ wallets: number; openings: number; entries: number; outbox: string[] }> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const response = await client.query<{ wallets: string; openings: string; entries: string; outbox: string[] }>(
      `SELECT (SELECT count(*) FROM wallets WHERE player_id = $1::uuid)::text AS wallets,
              (SELECT count(*) FROM wager_transactions WHERE player_id = $1::uuid AND kind = 'OPENING')::text AS openings,
              (SELECT count(*) FROM wallet_ledger_entries e JOIN wallets w ON w.id = e.wallet_id WHERE w.player_id = $1::uuid)::text AS entries,
              ARRAY(SELECT o.event_type FROM outbox_messages o JOIN wallets w ON w.id = o.aggregate_id
                     WHERE w.player_id = $1::uuid ORDER BY o.seq) AS outbox`,
      [playerId],
    );
    const row = response.rows[0];
    return {
      wallets: Number(row?.wallets),
      openings: Number(row?.openings),
      entries: Number(row?.entries),
      outbox: row?.outbox ?? [],
    };
  });
}

describe('[IT-09] POST /wallets', () => {
  test('[IT-09] saldo inicial > 0: 201, OPENING + CREDIT v1 + 2 eventos na outbox, na mesma transação', async () => {
    const playerId = newPlayer();
    const response = await open(playerId, '1000.00');
    expect(response.status).toBe(201);
    const id = stringField(response.body, 'id');
    expect(response.body).toEqual({ id, playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    expect(response.headers.get('location')).toBe(`/wallets/${id}`);
    expect(await persisted(playerId)).toEqual({
      wallets: 1,
      openings: 1,
      entries: 1,
      outbox: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    });
    const rows = await withClient(
      ownerUrl(fixture.database),
      async (client) =>
        (
          await client.query<Record<string, string | null>>(
            `SELECT t.status, t.provider_id, t.amount::text AS amount, t.accepted_balance::text AS accepted, t.accepted_wallet_version::text AS av,
                  e.direction, e.balance_before::text AS before, e.balance_after::text AS after, e.wallet_version::text AS v,
                  (SELECT count(*) FROM outbox_messages o WHERE o.aggregate_id = $1::uuid AND o.published_at IS NULL)::text AS unpublished
             FROM wager_transactions t JOIN wallet_ledger_entries e ON e.transaction_id = t.id WHERE t.wallet_id = $1::uuid`,
            [id],
          )
        ).rows,
    );
    expect(rows).toEqual([
      {
        status: 'PROCESSED',
        provider_id: '__internal__',
        amount: '1000.00',
        accepted: '1000.00',
        av: '1',
        direction: 'CREDIT',
        before: '0.00',
        after: '1000.00',
        v: '1',
        unpublished: '2',
      },
    ]);
  });

  test('[IT-09] saldo 0.00: version 1, sem OPENING, sem lançamento e sem evento', async () => {
    const playerId = newPlayer();
    const response = await open(playerId, '0.00');
    expect(response.status).toBe(201);
    expect(field(response.body, 'balance')).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(field(response.body, 'version')).toBe(1);
    expect(await persisted(playerId)).toEqual({ wallets: 1, openings: 0, entries: 0, outbox: [] });
  });

  test('[IT-09] duplicada (player, moeda) → 409 WALLET_ALREADY_EXISTS com o id existente; outra moeda é permitida', async () => {
    const playerId = newPlayer();
    const first = await open(playerId, '10.00');
    const dup = await open(playerId, '99.00');
    expect(dup.status).toBe(409);
    expect(field(dup.body, 'code')).toBe('WALLET_ALREADY_EXISTS');
    expect(field(dup.body, 'existingWalletId')).toBe(field(first.body, 'id'));
    expect((await open(playerId, '5.00', 'USD')).status).toBe(201);
    expect((await persisted(playerId)).wallets).toBe(2);
  });

  test('[IT-09] 10 criações paralelas do mesmo player em 3 instâncias → 1×201 e 9×409, um único efeito', async () => {
    const playerId = newPlayer();
    const results = await Promise.all(Array.from({ length: 10 }, () => open(playerId, '500.00')));
    const statuses = results.map((response) => response.status).sort((left, right) => left - right);
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    const created = results.find((response) => response.status === 201);
    for (const response of results.filter((x) => x.status === 409)) {
      expect(field(response.body, 'existingWalletId')).toBe(field(created?.body, 'id'));
    }
    expect(new Set(results.map((response) => response.headers.get('x-instance-id'))).size).toBe(3);
    expect(await persisted(playerId)).toEqual({
      wallets: 1,
      openings: 1,
      entries: 1,
      outbox: ['WagerTransactionProcessed', 'WalletBalanceChanged'],
    });
  });

  test('[IT-09] corpo inválido → 400 com código específico e nada persistido', async () => {
    const playerId = newPlayer();
    const bad: [unknown, string][] = [
      [{ playerId, initialBalance: { amount: '10.5', currency: 'BRL' } }, 'INVALID_AMOUNT'],
      [{ playerId, initialBalance: { amount: '-1.00', currency: 'BRL' } }, 'INVALID_AMOUNT'],
      [{ playerId, initialBalance: { amount: 10, currency: 'BRL' } }, 'INVALID_AMOUNT'],
      [{ playerId, initialBalance: { amount: '10.00', currency: 'EUR' } }, 'UNSUPPORTED_CURRENCY'],
      [{ playerId, initialBalance: { amount: '10.00', currency: 'BRL' }, extra: 1 }, 'VALIDATION_ERROR'],
      [{ playerId: 'not-a-uuid', initialBalance: { amount: '10.00', currency: 'BRL' } }, 'VALIDATION_ERROR'],
      [{ playerId }, 'VALIDATION_ERROR'],
    ];
    for (const [json, code] of bad) {
      const response = await api(base(), 'POST', '/wallets', { json });
      expect({ status: response.status, code: field(response.body, 'code') }).toEqual({ status: 400, code });
    }
    expect((await persisted(playerId)).wallets).toBe(0);
  });
});

describe('[IT-15] GET /wallets/:walletId', () => {
  test('[IT-15] devolve o estado atual; inexistente → 404; id inválido → 400', async () => {
    const playerId = newPlayer();
    const created = await open(playerId, '42.42');
    const id = stringField(created.body, 'id');
    const got = await api(base(), 'GET', `/wallets/${id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id, playerId, balance: { amount: '42.42', currency: 'BRL' }, version: 1 });
    expect(typeof field(got.body, 'createdAt')).toBe('string');
    const missing = await api(base(), 'GET', `/wallets/${Bun.randomUUIDv7()}`);
    expect([missing.status, field(missing.body, 'code')]).toEqual([404, 'WALLET_NOT_FOUND']);
    const invalid = await api(base(), 'GET', '/wallets/abc');
    expect([invalid.status, field(invalid.body, 'code')]).toEqual([400, 'VALIDATION_ERROR']);
  });
});

describe('[IT-19] problem+json nos endpoints existentes', () => {
  const problemShape = (
    response: { status: number; headers: Headers; body: unknown },
    status: number,
    code: string,
    retryable = false,
  ) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.body).toMatchObject({ type: `urn:wagering:error:${code}`, title: code, status, code, retryable });
    expect(typeof field(response.body, 'correlationId')).toBe('string');
    expect(response.headers.get('x-instance-id')).toMatch(/^wapi-\d$/);
  };

  test('[IT-19] JSON malformado, mídia errada, corpo grande e rota inexistente', async () => {
    problemShape(
      await api(base(), 'POST', '/wallets', { raw: '{"playerId": ', headers: { 'content-type': 'application/json' } }),
      400,
      'MALFORMED_JSON',
    );
    problemShape(
      await api(base(), 'POST', '/wallets', { raw: 'x', headers: { 'content-type': 'text/plain' } }),
      415,
      'UNSUPPORTED_MEDIA_TYPE',
    );
    problemShape(
      await api(base(), 'POST', '/wallets', {
        raw: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }),
        headers: { 'content-type': 'application/json' },
      }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    problemShape(await api(base(), 'GET', '/nao-existe'), 404, 'ROUTE_NOT_FOUND');
  });

  test('[IT-19] erros de wallet, ledger e reconciliação no mesmo formato; correlationId propagado', async () => {
    const missing = Bun.randomUUIDv7();
    problemShape(await api(base(), 'GET', `/wallets/${missing}/ledger`), 404, 'WALLET_NOT_FOUND');
    problemShape(await api(base(), 'POST', `/wallets/${missing}/reconciliation`), 404, 'WALLET_NOT_FOUND');
    const created = await open(newPlayer(), '1.00');
    problemShape(
      await api(base(), 'GET', `/wallets/${stringField(created.body, 'id')}/ledger?cursor=lixo!`),
      400,
      'INVALID_CURSOR',
    );
    const response = await api(base(), 'GET', `/wallets/${missing}`, {
      headers: { 'x-correlation-id': 'corr-it19-1' },
    });
    expect(field(response.body, 'correlationId')).toBe('corr-it19-1');
    expect(response.headers.get('x-correlation-id')).toBe('corr-it19-1');
  });
});
