import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lockWallet } from '../support/contention.ts';
import { adminUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import {
  invariantIssues,
  keyOf,
  openWallet,
  send,
  submission,
  type TestWallet,
  walletState,
} from '../support/wagering.ts';

/**
 * IT-13: falhas transitórias. (1) lock além do lock_timeout → 503 CONCURRENCY_CONFLICT;
 * (2) PostgreSQL congelado (proxy em blackhole) → 503 DATABASE_UNAVAILABLE dentro do timeout do
 * cliente; (3) commit ambíguo (o cliente desiste antes da resposta) → o reenvio vira replay.
 * Em todos: nada gravado pela metade e o reenvio com a mesma key aplica uma única vez.
 */
let fixture: Fixture;
let normal: Instance;
let proxy: TcpProxy | undefined;

beforeAll(async () => {
  fixture = await createFixture('it13');
  normal = startInstance({ id: 'it13-ok', env: fixture.env() });
  await waitReady(normal);
});
afterAll(async () => {
  proxy?.stop();
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[IT-13] falhas transitórias distinguíveis e seguras para reenvio', () => {
  test('[IT-13] lock da wallet além do lock_timeout → 503 CONCURRENCY_CONFLICT com Retry-After; reenvio aplica uma vez', async () => {
    const app = startInstance({ id: 'it13-lock', env: fixture.env({ DB_LOCK_TIMEOUT_MS: '300' }) });
    await waitReady(app);
    const wallet = await openWallet(normal.baseUrl, '100.00');
    const body = submission(wallet, { amount: '10.00' });
    const lock = await lockWallet(fixture.database, wallet.walletId);
    const response = await send(app.baseUrl, body).finally(() => lock.release());
    expect([response.status, field(response.body, 'code'), field(response.body, 'retryable')]).toEqual([
      503,
      'CONCURRENCY_CONFLICT',
      true,
    ]);
    expect(response.headers.get('retry-after')).toBe('1');
    expect((await walletState(fixture.database, wallet.walletId)).transactions).toBe('0');
    const retry = await send(app.baseUrl, body);
    expect([retry.status, field(retry.body, 'idempotentReplay'), field(retry.body, 'balance')]).toEqual([
      200,
      false,
      { amount: '90.00', currency: 'BRL' },
    ]);
  });

  test('[IT-13] PostgreSQL congelado (blackhole) → 503 DATABASE_UNAVAILABLE em ≤ timeout do cliente + δ; depois aplica uma vez', async () => {
    const pg = new URL(adminUrl());
    proxy = startTcpProxy({ hostname: pg.hostname, port: Number.parseInt(pg.port || '5432', 10) });
    const viaProxy = new URL(fixture.databaseUrl);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(proxy.port);
    const app = startInstance({
      id: 'it13-frozen',
      env: fixture.env({
        DATABASE_URL: viaProxy.toString(),
        DB_STATEMENT_TIMEOUT_MS: '1000',
        DB_QUERY_TIMEOUT_MS: '1500',
        DB_CONNECT_TIMEOUT_MS: '1500',
      }),
    });
    await waitReady(app);
    const wallet = await openWallet(app.baseUrl, '100.00');
    const body = submission(wallet, { amount: '20.00' });

    proxy.mode('blackhole');
    const startedAt = performance.now();
    const response = await send(app.baseUrl, body);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const ready = await fetch(`${app.baseUrl}/health/ready`).then((r) => r.status);
    proxy.mode('pass');

    writeEvidence('IT-13-frozen', { status: response.status, body: response.body, elapsedMs, ready });
    expect([response.status, field(response.body, 'code'), field(response.body, 'retryable')]).toEqual([
      503,
      'DATABASE_UNAVAILABLE',
      true,
    ]);
    expect(elapsedMs).toBeLessThan(1500 + 3000);
    expect(ready).toBe(503);
    expect((await walletState(fixture.database, wallet.walletId)).transactions).toBe('0');

    // O provedor reenvia com a mesma key até o banco voltar: um único efeito.
    const retry = await eventually(
      async () => {
        const attempt = await send(app.baseUrl, body);
        return attempt.status === 200 ? attempt : undefined;
      },
      { timeoutMs: 20_000, intervalMs: 300, describe: 'reenvio aceito depois de o banco voltar' },
    );
    expect([field(retry.body, 'idempotentReplay'), field(retry.body, 'balance')]).toEqual([
      false,
      { amount: '80.00', currency: 'BRL' },
    ]);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '80.00', debits: '1' });
  });

  test('[IT-13] commit ambíguo: o cliente desiste antes da resposta, a transação comita e o reenvio é replay', async () => {
    const paused = startInstance({
      id: 'it13-ambiguous',
      env: fixture.env({
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'pause' }]),
      }),
    });
    await waitReady(paused);
    const wallet: TestWallet = await openWallet(normal.baseUrl, '100.00');
    const body = submission(wallet, { amount: '40.00' });
    const abandoned = await fetch(`${paused.baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': keyOf(body) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1000),
    }).then(
      () => 'respondeu',
      () => 'cliente desistiu',
    );
    expect(abandoned).toBe('cliente desistiu');
    await paused.logs.waitFor('fault.injected', 5000);
    signal(paused, 'SIGUSR2');
    const replay = await eventually(
      async () => {
        const attempt = await send(normal.baseUrl, body);
        return attempt.status === 200 && field(attempt.body, 'idempotentReplay') === true ? attempt : undefined;
      },
      { timeoutMs: 15_000, intervalMs: 200, describe: 'reenvio vira replay depois do commit' },
    );
    expect(field(replay.body, 'balance')).toEqual({ amount: '60.00', currency: 'BRL' });
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '60.00', debits: '1' });
  });
});
