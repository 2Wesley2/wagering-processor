import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, startCluster } from '../support/cluster.ts';
import { lockWallet } from '../support/contention.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * CT-03 (§13 concorrência item 3): wallets distintas são processadas em paralelo; o lock da
 * wallet A (segurado pelo teste) não bloqueia as demais — não há lock global.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct03');
  cluster = await startCluster(fixture, 'ct03');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

describe('[CT-03] wallets distintas em paralelo', () => {
  test('[CT-03] com a wallet A travada, 9 outras wallets concluem; A conclui depois de liberada', async () => {
    const blocked = await openWallet(cluster.next().baseUrl, '100.00');
    const others = await Promise.all(Array.from({ length: 9 }, () => openWallet(cluster.next().baseUrl, '100.00')));
    const lock = await lockWallet(fixture.database, blocked.walletId);
    let blockedSettled = false;
    const blockedRequest = send(cluster.at(0).baseUrl, submission(blocked, { amount: '10.00' })).then((response) => {
      blockedSettled = true;
      return response;
    });
    try {
      await lock.waitForWaiters(1);
      const startedAt = performance.now();
      const responses = await Promise.all(
        others.map((wallet, index) => send(cluster.at(index).baseUrl, submission(wallet, { amount: '10.00' }))),
      );
      const elapsedMs = Math.round(performance.now() - startedAt);
      writeEvidence('CT-03', { elapsedMs, blockedSettledWhileOthersRan: blockedSettled });
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 9 }, () => 200));
      expect(blockedSettled).toBe(false);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      await lock.release();
    }
    const blockedResponse = await blockedRequest;
    expect([blockedResponse.status, field(blockedResponse.body, 'balance')]).toEqual([
      200,
      { amount: '90.00', currency: 'BRL' },
    ]);
    for (const wallet of [blocked, ...others]) {
      expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
    }
  });
});
