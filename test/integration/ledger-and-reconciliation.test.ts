import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { appUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { adminDbUrl, api, field, stringField } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { movementSql, withClient } from '../support/sql-fixtures.ts';

/**
 * IT-16 e IT-17 pela API. Os lançamentos posteriores à OPENING são preparados
 * em SQL (movementSql), porque o caso de uso de submissão é da F3.
 */
let fixture: Fixture;
let app: Instance;

beforeAll(async () => {
  fixture = await createFixture('ledrec');
  app = startInstance({ id: 'ledrec-1', env: fixture.env() });
  await waitReady(app);
});
afterAll(async () => {
  await fixture.dispose();
});

async function openWallet(amount: string): Promise<string> {
  const response = await api(app.baseUrl, 'POST', '/wallets', {
    json: { playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: 'BRL' } },
  });
  expect(response.status).toBe(201);
  return stringField(response.body, 'id');
}

const bets = (walletId: string, n: number) =>
  withClient(appUrl(fixture.database), async (client) => {
    for (let i = 0; i < n; i++) await movementSql(client, walletId, { kind: 'BET', amount: '1.00' });
  });

const pageSchema = z.object({
  entries: z.array(z.object({ walletVersion: z.number(), balanceAfter: z.object({ amount: z.string() }) })),
  nextCursor: z.string().nullable(),
});

describe('[IT-16] paginação keyset do ledger', () => {
  test('[IT-16] páginas estáveis com inserções entre elas: sem buracos nem repetições', async () => {
    const walletId = await openWallet('100.00');
    await bets(walletId, 5);
    const firstPage = pageSchema.parse((await api(app.baseUrl, 'GET', `/wallets/${walletId}/ledger?limit=3`)).body);
    expect(firstPage.entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3]);
    expect(firstPage.nextCursor).not.toBeNull();
    await bets(walletId, 3);
    const secondPage = pageSchema.parse(
      (await api(app.baseUrl, 'GET', `/wallets/${walletId}/ledger?limit=3&cursor=${firstPage.nextCursor ?? ''}`)).body,
    );
    const thirdPage = pageSchema.parse(
      (await api(app.baseUrl, 'GET', `/wallets/${walletId}/ledger?limit=3&cursor=${secondPage.nextCursor ?? ''}`)).body,
    );
    expect(secondPage.entries.map((entry) => entry.walletVersion)).toEqual([4, 5, 6]);
    expect(thirdPage.entries.map((entry) => entry.walletVersion)).toEqual([7, 8, 9]);
    expect(thirdPage.nextCursor).toBeNull();
    expect(
      [...firstPage.entries, ...secondPage.entries, ...thirdPage.entries].map((entry) => entry.balanceAfter.amount),
    ).toEqual(['100.00', '99.00', '98.00', '97.00', '96.00', '95.00', '94.00', '93.00', '92.00']);
    const all = pageSchema.parse((await api(app.baseUrl, 'GET', `/wallets/${walletId}/ledger`)).body);
    expect([all.entries.length, all.nextCursor]).toEqual([9, null]);
  });

  test('[IT-16] cursor de outra wallet e limit fora da faixa → 400', async () => {
    const firstWalletId = await openWallet('10.00');
    const secondWalletId = await openWallet('10.00');
    await bets(firstWalletId, 2);
    const page = pageSchema.parse((await api(app.baseUrl, 'GET', `/wallets/${firstWalletId}/ledger?limit=1`)).body);
    const cross = await api(app.baseUrl, 'GET', `/wallets/${secondWalletId}/ledger?cursor=${page.nextCursor ?? ''}`);
    expect([cross.status, field(cross.body, 'code')]).toEqual([400, 'INVALID_CURSOR']);
    for (const limit of ['0', '201', 'abc']) {
      expect((await api(app.baseUrl, 'GET', `/wallets/${firstWalletId}/ledger?limit=${limit}`)).status).toBe(400);
    }
  });
});

describe('[IT-17] reconciliação', () => {
  test('[IT-17] wallet íntegra: saldo = Σ ledger, diferença 0.00', async () => {
    const walletId = await openWallet('1000.00');
    await withClient(appUrl(fixture.database), (client) =>
      movementSql(client, walletId, { kind: 'BET', amount: '25.00' }),
    );
    const response = await api(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
      issues: [],
    });
  });

  test('[IT-17] wallet aberta com 0.00 é consistente com zero lançamentos', async () => {
    const walletId = await openWallet('0.00');
    const response = await api(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(response.body).toMatchObject({
      consistent: true,
      checkedEntries: 0,
      difference: { amount: '0.00', currency: 'BRL' },
    });
  });

  test('[IT-17] divergência fabricada (triggers desligados pelo superusuário) é sinalizada, logada, contada e NÃO corrigida', async () => {
    const walletId = await openWallet('975.00');
    // Estado impossível pela app: só um superusuário com session_replication_role=replica consegue gravá-lo.
    await withClient(adminDbUrl(fixture.database), async (client) => {
      await client.query('SET session_replication_role = replica');
      await client.query('UPDATE wallets SET balance = balance + 1.00 WHERE id = $1::uuid', [walletId]);
    });
    const response = await api(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId,
      storedBalance: { amount: '976.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
      issues: ['BALANCE_MISMATCH', 'HEAD_MISMATCH'],
    });
    const after = await api(app.baseUrl, 'GET', `/wallets/${walletId}`);
    expect(field(after.body, 'balance')).toEqual({ amount: '976.00', currency: 'BRL' });
    const log = await app.logs.waitFor('reconciliation.divergence', 2000);
    expect(log['walletId']).toBe(walletId);
    const metrics = await (await fetch(`${app.baseUrl}/metrics`)).text();
    expect(metrics).toMatch(/wallet_reconciliation_divergence_total\{[^}]*issue="BALANCE_MISMATCH"[^}]*\} 1/);
  });

  test('[IT-17] execuções concorrentes com escrita em andamento continuam consistentes', async () => {
    const walletId = await openWallet('100.00');
    const writes = withClient(appUrl(fixture.database), async (client) => {
      for (let i = 0; i < 6; i++) await movementSql(client, walletId, { kind: 'BET', amount: '1.00' });
    });
    const checks = Promise.all(
      Array.from({ length: 8 }, () => api(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`)),
    );
    const [, results] = await Promise.all([writes, checks]);
    for (const response of results) expect(field(response.body, 'consistent')).toBe(true);
    const final = await api(app.baseUrl, 'POST', `/wallets/${walletId}/reconciliation`);
    expect(final.body).toMatchObject({
      consistent: true,
      checkedEntries: 7,
      storedBalance: { amount: '94.00', currency: 'BRL' },
    });
  });
});
