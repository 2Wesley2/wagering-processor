import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../../src/platform/config/config.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field } from '../support/http.ts';
import { startInstance, waitReady } from '../support/instances.ts';
import { openWallet, send, submission } from '../support/wagering.ts';

/**
 * IT-18: health público e ponto de extensão de autenticação (§2). Com o adaptador no-op tudo
 * passa; com uma porta que recusa (`deny-all`, só em teste) as rotas de negócio respondem 401 e o
 * health continua aberto.
 */
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture('it18');
});
afterAll(async () => {
  await fixture.dispose();
});

describe('[IT-18] health e autenticação no-op', () => {
  test('[IT-18] adaptador no-op: health e rotas de negócio respondem', async () => {
    const app = startInstance({ id: 'it18-noop', env: fixture.env() });
    await waitReady(app);
    expect((await api(app.baseUrl, 'GET', '/health/live')).status).toBe(200);
    expect((await api(app.baseUrl, 'GET', '/health/ready')).status).toBe(200);
    const wallet = await openWallet(app.baseUrl, '10.00');
    expect((await send(app.baseUrl, submission(wallet, { amount: '1.00' }))).status).toBe(200);
  });

  test('[IT-18] porta que recusa: 401 AUTHENTICATION_REQUIRED nas rotas de negócio; health segue público', async () => {
    const app = startInstance({ id: 'it18-deny', env: fixture.env({ AUTHENTICATION_ADAPTER: 'deny-all' }) });
    await waitReady(app);
    expect((await api(app.baseUrl, 'GET', '/health/live')).status).toBe(200);
    expect((await api(app.baseUrl, 'GET', '/health/ready')).status).toBe(200);
    const responses = [
      await api(app.baseUrl, 'POST', '/wagering/transactions', { json: {}, headers: { 'idempotency-key': 'k-1' } }),
      await api(app.baseUrl, 'GET', `/wagering/transactions/${Bun.randomUUIDv7()}`),
      await api(app.baseUrl, 'GET', `/wallets/${Bun.randomUUIDv7()}`),
      await api(app.baseUrl, 'POST', '/wallets', { json: {} }),
    ];
    for (const response of responses) {
      expect([response.status, field(response.body, 'code')]).toEqual([401, 'AUTHENTICATION_REQUIRED']);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  test('[IT-18] o adaptador deny-all é recusado fora de NODE_ENV=test', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
      SQS_ENDPOINT: 'http://127.0.0.1:1',
      AUTHENTICATION_ADAPTER: 'deny-all',
    };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});
