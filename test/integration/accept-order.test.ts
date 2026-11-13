import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, startCluster } from '../support/cluster.ts';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * RV-IT-07: `accept_seq` sob 3 instâncias. A ordem de aceite numa wallet é a ordem real de
 * aquisição do lock dela: `accept_seq` estritamente crescente acompanha `accepted_at`
 * não decrescente (a regra de prazo e a ordem de resolução dependem disso, D40).
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('rvit07');
  cluster = await startCluster(fixture, 'rvit07');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[RV-IT-07] accept_seq com 3 instâncias', () => {
  test('[RV-IT-07] 30 pendências concorrentes na mesma wallet: accept_seq e accepted_at na mesma ordem', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        send(
          cluster.at(index).baseUrl,
          submission(wallet, { kind: 'REFUND', amount: '1.00', referenceExternalTransactionId: `ausente-${index}` }),
        ),
      ),
    );
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([202]));
    expect(new Set(responses.map((response) => response.headers.get('x-instance-id'))).size).toBe(3);
    const violations = await withClient(ownerUrl(fixture.database), async (client) => {
      const result = await client.query<{ n: string; total: string }>(
        `SELECT count(*) FILTER (WHERE accepted_at < previous_accepted)::text AS n, count(*)::text AS total
           FROM (SELECT accepted_at, lag(accepted_at) OVER (ORDER BY accept_seq) AS previous_accepted
                   FROM wager_transactions WHERE wallet_id = $1::uuid AND kind = 'REFUND') ordered`,
        [wallet.walletId],
      );
      return result.rows[0];
    });
    expect(violations).toEqual({ n: '0', total: '30' });
  });
});
