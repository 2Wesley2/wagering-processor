import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * CT-09: hot wallet até zero. 200 apostas de 1.00 sobre 100.00, 40 em voo por vez, em 3
 * instâncias: exatamente 100 aplicadas, 100 rejeitadas por saldo, saldo 0.00, versões contíguas.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct09');
  cluster = await startCluster(fixture, 'ct09');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[CT-09] hot wallet até zero', () => {
  test('[CT-09] 100 PROCESSED, 100 INSUFFICIENT_FUNDS, saldo 0.00, 100 débitos e versão 101', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const responses = await inParallel(
      Array.from(
        { length: 200 },
        (_, index) => () => send(cluster.at(index).baseUrl, submission(wallet, { amount: '1.00' })),
      ),
      40,
    );
    const processed = responses.filter((response) => response.status === 200).length;
    const rejected = responses.filter(
      (response) => response.status === 422 && field(response.body, 'code') === 'INSUFFICIENT_FUNDS',
    ).length;
    const state = await walletState(fixture.database, wallet.walletId);
    writeEvidence('CT-09', { processed, rejected, state });
    expect([processed, rejected]).toEqual([100, 100]);
    expect(state).toMatchObject({ balance: '0.00', version: '101', debits: '100', transactions: '200' });
  });
});
