import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';
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
 * IT-07b: atomicidade no caminho HTTP de submissão. A falha é injetada DEPOIS da última gravação
 * (transação, wallet, lançamento e outbox) e antes do COMMIT (uow.beforeCommit). Worker e SQS são
 * IT-07c/d (F4/F5).
 */
let fixture: Fixture;
let normal: Instance;
let wallet: TestWallet;

beforeAll(async () => {
  fixture = await createFixture('it07b');
  normal = startInstance({ id: 'it07b-ok', env: fixture.env() });
  await waitReady(normal);
  wallet = await openWallet(normal.baseUrl, '100.00');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const untouched = { balance: '100.00', version: '1', entries: '1', debits: '0', transactions: '0', outbox: '2' };

function faultyEnv(action: 'fail' | 'kill'): Record<string, string> {
  return fixture.env({
    FAULT_INJECTION: 'enabled',
    FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action }]),
  });
}

describe('[IT-07b] atomicidade no caminho POST /wagering/transactions', () => {
  test('[IT-07b] falha antes do COMMIT → 500 e nenhuma linha (transação, saldo, ledger, outbox)', async () => {
    const app = startInstance({ id: 'it07b-fail', env: faultyEnv('fail') });
    await waitReady(app);
    const response = await send(app.baseUrl, submission(wallet, { amount: '30.00' }));
    expect([response.status, field(response.body, 'code')]).toEqual([500, 'INTERNAL_ERROR']);
    expect(app.logs.find('fault.injected')?.['point']).toBe('uow.beforeCommit');
    expect(await walletState(fixture.database, wallet.walletId)).toEqual(untouched);
  });

  test('[IT-07b] SIGKILL dentro da transação → nenhuma linha; depois a mesma key é processada uma vez', async () => {
    const app = startInstance({ id: 'it07b-kill', env: faultyEnv('kill') });
    await waitReady(app);
    const body = submission(wallet, { amount: '30.00' });
    const request = await send(app.baseUrl, body).then(
      () => 'respondeu',
      () => 'conexão interrompida',
    );
    const exit = await app.exited;
    const marker = app.logs.find('fault.injected');
    const backends = await eventually(
      async () => {
        const count = await withClient(
          ownerUrl(fixture.database),
          async (client) =>
            (
              await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = 'app:it07b-kill'`,
              )
            ).rows[0]?.n,
        );
        return count === '0' ? count : undefined;
      },
      { timeoutMs: 15_000, intervalMs: 250, describe: 'backends da instância morta encerrados' },
    );
    const stateAfterKill = await walletState(fixture.database, wallet.walletId);
    writeEvidence('IT-07b-kill', { request, exit, marker, killLog: app.killLog, backends, stateAfterKill });
    expect(request).toBe('conexão interrompida');
    expect(marker?.['point']).toBe('uow.beforeCommit');
    expect([exit.signalCode, exit.exitCode]).toEqual(['SIGKILL', null]);
    expect(app.killLog).toEqual([]);
    expect(stateAfterKill).toEqual(untouched);

    // O provedor reenvia com a mesma key: nada ficou preso nem gravado pela metade.
    const retry = await send(normal.baseUrl, body);
    expect([retry.status, field(retry.body, 'idempotentReplay'), field(retry.body, 'balance')]).toEqual([
      200,
      false,
      { amount: '70.00', currency: 'BRL' },
    ]);
    expect(keyOf(body)).toContain(body.externalTransactionId);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '70.00', debits: '1' });
  });
});
