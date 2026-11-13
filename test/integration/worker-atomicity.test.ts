import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { stringField } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { setDeadline, storedTransaction, waitResolved, workerEnv } from '../support/pending.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission, type TestWallet, walletState } from '../support/wagering.ts';

/**
 * IT-07c: atomicidade no caminho do worker. A falha é injetada depois da última gravação da
 * resolução (transação, saldo, lançamento, reversão, agenda, outbox) e antes do COMMIT
 * (uow.beforeCommit, numa instância só de worker): nada fica gravado pela metade e um worker normal
 * resolve a pendência exatamente uma vez depois.
 */
let fixture: Fixture;
let apiInstance: Instance;
let wallet: TestWallet;
let pendingId: string;

beforeAll(async () => {
  fixture = await createFixture('it07c');
  apiInstance = startInstance({ id: 'it07c-api', env: fixture.env() });
  await waitReady(apiInstance);
  wallet = await openWallet(apiInstance.baseUrl, '100.00');
  const refund = await send(
    apiInstance.baseUrl,
    submission(wallet, {
      kind: 'REFUND',
      amount: '10.00',
      externalTransactionId: 'c-refund',
      referenceExternalTransactionId: 'c-bet',
    }),
  );
  pendingId = stringField(refund.body, 'transactionId');
  await setDeadline(
    fixture.database,
    pendingId,
    `(SELECT accepted_at FROM wager_transactions WHERE id = '${pendingId}'::uuid) + interval '1 hour'`,
  );
  await send(apiInstance.baseUrl, submission(wallet, { kind: 'BET', amount: '10.00', externalTransactionId: 'c-bet' }));
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const beforeResolution = { balance: '90.00', version: '2', entries: '2', debits: '1', transactions: '2', outbox: '5' };

async function agendaOf(transactionId: string): Promise<{ attempts: number } | undefined> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ attempts: number }>(
      'SELECT attempts FROM pending_reference_checks WHERE transaction_id = $1::uuid',
      [transactionId],
    );
    return result.rows[0];
  });
}

describe('[IT-07c] atomicidade no caminho do worker de pendências', () => {
  test('[IT-07c] falha antes do COMMIT da resolução → pendência intacta, nenhuma linha nova', async () => {
    const worker = startInstance({
      id: 'it07c-fail',
      env: workerEnv(fixture, {
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'fail' }]),
      }),
    });
    await waitReady(worker);
    await eventually(() => worker.logs.find('pending_reference_worker.wallet_failed'), {
      timeoutMs: 10_000,
      describe: 'resolução falhou com a falha injetada',
    });
    signal(worker, 'SIGTERM');
    await worker.exited;
    expect(worker.logs.find('fault.injected')?.['point']).toBe('uow.beforeCommit');
    expect((await storedTransaction(fixture.database, pendingId)).status).toBe('PENDING_REFERENCE');
    expect(await walletState(fixture.database, wallet.walletId)).toEqual(beforeResolution);
    expect(await agendaOf(pendingId)).toMatchObject({ attempts: 0 });
  });

  test('[IT-07c] SIGKILL dentro da transação da resolução → nada gravado; depois um worker normal resolve uma vez', async () => {
    const worker = startInstance({
      id: 'it07c-kill',
      env: workerEnv(fixture, {
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'uow.beforeCommit', action: 'kill' }]),
      }),
    });
    const exit = await worker.exited;
    const marker = worker.logs.find('fault.injected');
    const stateAfterKill = await walletState(fixture.database, wallet.walletId);
    const statusAfterKill = (await storedTransaction(fixture.database, pendingId)).status;
    writeEvidence('IT-07c-kill', { exit, marker, killLog: worker.killLog, stateAfterKill, statusAfterKill });
    expect(marker?.['point']).toBe('uow.beforeCommit');
    expect([exit.signalCode, exit.exitCode]).toEqual(['SIGKILL', null]);
    expect(worker.killLog).toEqual([]);
    expect(statusAfterKill).toBe('PENDING_REFERENCE');
    expect(stateAfterKill).toEqual(beforeResolution);

    const normal = startInstance({ id: 'it07c-ok', env: workerEnv(fixture) });
    await waitReady(normal);
    await waitResolved(fixture.database, [pendingId]);
    signal(normal, 'SIGTERM');
    await normal.exited;
    expect(await storedTransaction(fixture.database, pendingId)).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
      inAgenda: false,
    });
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({
      balance: '100.00',
      version: '3',
      entries: '3',
      outbox: '7',
    });
  });
});
