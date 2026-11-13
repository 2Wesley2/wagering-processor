import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field, stringField } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * IT-15 (consultas de transação, F3): os dois GETs do §9 mostram o estado atual e o saldo
 * histórico da decisão (D29), nunca o saldo atual da wallet. Valores fixos (D58).
 */
let fixture: Fixture;
let app: Instance;

beforeAll(async () => {
  fixture = await createFixture('it15t');
  app = startInstance({ id: 'it15t-1', env: fixture.env() });
  await waitReady(app);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[IT-15] GET /wagering/transactions/:id e GET /providers/:providerId/wagering/transactions/:externalId', () => {
  test('[IT-15] aplicada, rejeitada e pendente pelos dois caminhos; saldo da decisão, não o atual', async () => {
    const wallet = await openWallet(app.baseUrl, '1000.00');
    const bet = submission(wallet, { amount: '25.00', gameId: 'fortune-chimp', roundId: 'round-987' });
    const betId = stringField((await send(app.baseUrl, bet)).body, 'transactionId');
    await send(app.baseUrl, submission(wallet, { kind: 'WIN', amount: '100.00' }));

    const byId = await api(app.baseUrl, 'GET', `/wagering/transactions/${betId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      transactionId: betId,
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      walletId: wallet.walletId,
      playerId: wallet.playerId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      status: 'PROCESSED',
      failureCode: null,
      balance: { amount: '975.00', currency: 'BRL' },
      walletVersion: 2,
      decidedAt: field(byId.body, 'acceptedAt'),
      initialStatus: 'PROCESSED',
      acceptedBalance: { amount: '975.00', currency: 'BRL' },
      acceptedWalletVersion: 2,
      acceptedAt: field(byId.body, 'acceptedAt'),
      createdAt: field(byId.body, 'createdAt'),
    });
    const byProvider = await api(
      app.baseUrl,
      'GET',
      `/providers/provider-a/wagering/transactions/${encodeURIComponent(bet.externalTransactionId)}`,
    );
    expect([byProvider.status, byProvider.body]).toEqual([200, byId.body]);
    const currentWallet = await api(app.baseUrl, 'GET', `/wallets/${wallet.walletId}`);
    expect(field(currentWallet.body, 'balance')).toEqual({ amount: '1075.00', currency: 'BRL' });

    const rejected = await send(app.baseUrl, submission(wallet, { amount: '5000.00' }));
    const rejectedId = stringField(field(rejected.body, 'transaction'), 'transactionId');
    const rejectedView = await api(app.baseUrl, 'GET', `/wagering/transactions/${rejectedId}`);
    expect(rejectedView.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '1075.00', currency: 'BRL' },
      walletVersion: 3,
      initialStatus: 'REJECTED',
    });

    const pending = await send(
      app.baseUrl,
      submission(wallet, { kind: 'ROLLBACK', amount: '5.00', referenceExternalTransactionId: 'ainda-ausente' }),
    );
    const pendingView = await api(
      app.baseUrl,
      'GET',
      `/wagering/transactions/${stringField(pending.body, 'transactionId')}`,
    );
    expect(pendingView.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: null,
      walletVersion: null,
      decidedAt: null,
      failureCode: null,
      initialStatus: 'PENDING_REFERENCE',
      acceptedBalance: { amount: '1075.00', currency: 'BRL' },
      acceptedWalletVersion: 3,
    });
  });

  test('[IT-15] inexistente → 404 TRANSACTION_NOT_FOUND; formato inválido → 400', async () => {
    const missing = await api(app.baseUrl, 'GET', `/wagering/transactions/${Bun.randomUUIDv7()}`);
    expect([missing.status, field(missing.body, 'code')]).toEqual([404, 'TRANSACTION_NOT_FOUND']);
    const missingByProvider = await api(app.baseUrl, 'GET', '/providers/provider-a/wagering/transactions/nao-existe');
    expect([missingByProvider.status, field(missingByProvider.body, 'code')]).toEqual([404, 'TRANSACTION_NOT_FOUND']);
    const invalid = await api(app.baseUrl, 'GET', '/wagering/transactions/abc');
    expect([invalid.status, field(invalid.body, 'code')]).toEqual([400, 'VALIDATION_ERROR']);
    const invalidProvider = await api(app.baseUrl, 'GET', '/providers/__internal__/wagering/transactions/x');
    expect([invalidProvider.status, field(invalidProvider.body, 'code')]).toEqual([400, 'VALIDATION_ERROR']);
  });
});
