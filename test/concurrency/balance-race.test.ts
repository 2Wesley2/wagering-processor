import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { lockWallet } from '../support/contention.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * CT-02h (cenário obrigatório do §8, via HTTP): saldo 100.00 BRL e duas apostas de 80.00 em
 * instâncias diferentes → exatamente uma PROCESSED, uma REJECTED INSUFFICIENT_FUNDS, saldo 20.00 e
 * um único débito. A primeira execução força e comprova a sobreposição (D47, D52); depois, 100
 * iterações sem o lock de teste.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct02');
  cluster = await startCluster(fixture, 'ct02');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const EXPECTED_STATE = { balance: '20.00', version: '2', debits: '1', transactions: '2' };

async function race(holdLock: boolean): Promise<{ statuses: number[]; codes: unknown[]; waiters: string[] }> {
  const wallet = await openWallet(cluster.next().baseUrl, '100.00');
  const lock = holdLock ? await lockWallet(fixture.database, wallet.walletId) : undefined;
  const pending = [0, 1].map((index) => send(cluster.at(index).baseUrl, submission(wallet, { amount: '80.00' })));
  const waiters = lock === undefined ? [] : await lock.waitForWaiters(2).finally(() => lock.release());
  const responses = await Promise.all(pending);
  const ordered = [...responses].sort((left, right) => left.status - right.status);
  expect(await walletState(fixture.database, wallet.walletId)).toMatchObject(EXPECTED_STATE);
  return {
    statuses: ordered.map((response) => response.status),
    codes: ordered.map((response) => field(response.body, 'code') ?? field(response.body, 'status')),
    waiters,
  };
}

describe('[CT-02h] duas apostas de 80.00 sobre 100.00 em instâncias diferentes', () => {
  test('[CT-02h] sobreposição comprovada: 1 PROCESSED, 1 INSUFFICIENT_FUNDS, saldo 20.00, 1 débito', async () => {
    const outcome = await race(true);
    writeEvidence('CT-02h-contention', outcome);
    expect(outcome.waiters).toEqual(['app:ct02-1', 'app:ct02-2']);
    expect(outcome.statuses).toEqual([200, 422]);
    expect(outcome.codes).toEqual(['PROCESSED', 'INSUFFICIENT_FUNDS']);
  });

  test('[CT-02h] 100 iterações: sempre o mesmo desfecho', async () => {
    const outcomes = await inParallel(
      Array.from({ length: 100 }, () => () => race(false)),
      10,
    );
    const distinct = new Set(outcomes.map((outcome) => JSON.stringify([outcome.statuses, outcome.codes])));
    writeEvidence('CT-02h-iterations', { iterations: outcomes.length, distinctOutcomes: [...distinct] });
    expect([...distinct]).toEqual([
      JSON.stringify([
        [200, 422],
        ['PROCESSED', 'INSUFFICIENT_FUNDS'],
      ]),
    ]);
  });
});
