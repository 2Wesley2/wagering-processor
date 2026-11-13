import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * CT-12: instância congelada (SIGSTOP) no meio de uma transação, segurando o lock da wallet. O
 * banco encerra a sessão ociosa (idle_in_transaction_session_timeout), a wallet é liberada para
 * as outras instâncias, nada da instância congelada é gravado e, ao descongelar, ela responde
 * falha transitória; o reenvio com a mesma key aplica uma única vez.
 */
let fixture: Fixture;
let normal: Instance;

beforeAll(async () => {
  fixture = await createFixture('ct12');
  normal = startInstance({ id: 'ct12-ok', env: fixture.env() });
  await waitReady(normal);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[CT-12] instância congelada segurando a wallet', () => {
  test('[CT-12] outra instância segue após o banco encerrar a sessão; a congelada não grava nada', async () => {
    const frozen = startInstance({
      id: 'ct12-frozen',
      env: fixture.env({
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '1500',
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'pause' }]),
      }),
    });
    await waitReady(frozen);
    const wallet = await openWallet(normal.baseUrl, '100.00');
    const frozenBody = submission(wallet, { amount: '30.00' });
    const frozenRequest = send(frozen.baseUrl, frozenBody);
    await frozen.logs.waitFor('fault.injected', 10_000);
    signal(frozen, 'SIGSTOP');

    const startedAt = performance.now();
    const other = await send(normal.baseUrl, submission(wallet, { amount: '20.00' }));
    const waitedMs = Math.round(performance.now() - startedAt);
    const stateWhileFrozen = await walletState(fixture.database, wallet.walletId);

    signal(frozen, 'SIGCONT');
    signal(frozen, 'SIGUSR2');
    const frozenResponse = await frozenRequest;
    const retry = await send(normal.baseUrl, frozenBody);
    const finalState = await walletState(fixture.database, wallet.walletId);
    writeEvidence('CT-12', {
      waitedMs,
      other: { status: other.status, body: other.body },
      stateWhileFrozen,
      frozenResponse: { status: frozenResponse.status, body: frozenResponse.body },
      retry: { status: retry.status, body: retry.body },
      finalState,
      killLog: frozen.killLog,
      frozenErrors: frozen.logs.entries.filter((entry) => entry.level === 'error' || entry.level === 'warn').slice(-5),
    });

    expect([other.status, field(other.body, 'balance')]).toEqual([200, { amount: '80.00', currency: 'BRL' }]);
    expect(stateWhileFrozen).toMatchObject({ balance: '80.00', debits: '1', transactions: '1' });
    expect([frozenResponse.status, field(frozenResponse.body, 'code')]).toEqual([503, 'DATABASE_UNAVAILABLE']);
    expect([retry.status, field(retry.body, 'idempotentReplay'), field(retry.body, 'balance')]).toEqual([
      200,
      false,
      { amount: '50.00', currency: 'BRL' },
    ]);
    expect(finalState).toMatchObject({ balance: '50.00', debits: '2', transactions: '2' });
  });
});
