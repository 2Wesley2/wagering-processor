import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, startCluster } from '../support/cluster.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, send, submission, walletState, withoutReplayFlag } from '../support/wagering.ts';

/**
 * CT-01h (§13 concorrência item 1, via HTTP): a mesma aposta 50 vezes em paralelo, distribuída
 * entre 3 instâncias, produz um único débito; todas as respostas trazem o mesmo desfecho.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct01');
  cluster = await startCluster(fixture, 'ct01');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[CT-01h] 50 envios idênticos em paralelo em 3 instâncias', () => {
  test('[CT-01h] 1 débito, 1 resposta original e 49 replays com o mesmo corpo', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '1000.00');
    const bet = submission(wallet, { amount: '10.00' });
    const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => send(cluster.at(index).baseUrl, bet)));
    const statuses = new Set(responses.map((response) => response.status));
    const originals = responses.filter((response) => field(response.body, 'idempotentReplay') === false);
    const bodies = new Set(responses.map((response) => JSON.stringify(withoutReplayFlag(response.body))));
    const instances = new Set(responses.map((response) => response.headers.get('x-instance-id')));
    const state = await walletState(fixture.database, wallet.walletId);
    writeEvidence('CT-01h', {
      statuses: [...statuses],
      originals: originals.length,
      distinctBodies: bodies.size,
      instances: [...instances],
      state,
    });
    expect([...statuses]).toEqual([200]);
    expect(originals).toHaveLength(1);
    expect(bodies.size).toBe(1);
    expect(instances.size).toBe(3);
    expect(field(originals[0]?.body, 'balance')).toEqual({ amount: '990.00', currency: 'BRL' });
    expect(state).toMatchObject({ balance: '990.00', debits: '1', transactions: '1', version: '2' });
  });

  test('[CT-01h] dois payloads × 25 duplicatas cada, intercalados → 2 débitos, sem 409/500', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '1000.00');
    const first = submission(wallet, { amount: '10.00' });
    const second = submission(wallet, { amount: '20.00' });
    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, index) => send(cluster.at(index).baseUrl, index % 2 === 0 ? first : second)),
    );
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(responses.filter((response) => field(response.body, 'idempotentReplay') === false)).toHaveLength(2);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({
      balance: '970.00',
      debits: '2',
      transactions: '2',
    });
  });
});
