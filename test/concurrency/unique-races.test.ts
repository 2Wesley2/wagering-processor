import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, startCluster } from '../support/cluster.ts';
import { lockWallet, type WalletLock } from '../support/contention.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, submission, submit, type TestWallet } from '../support/wagering.ts';

/**
 * CT-10: corridas decididas pelo índice único (23505). Requisições para wallets DIFERENTES não se
 * encontram no lock da wallet; o teste segura os locks até todas passarem pelo caminho rápido e
 * as solta juntas, para que a disputa aconteça no INSERT. Exatamente uma vence; as demais viram 409.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct10');
  cluster = await startCluster(fixture, 'ct10');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function raceOnInsert(
  wallets: readonly TestWallet[],
  request: (wallet: TestWallet, index: number) => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown }[]> {
  const locks: WalletLock[] = await Promise.all(wallets.map((wallet) => lockWallet(fixture.database, wallet.walletId)));
  const pending = wallets.map((wallet, index) => request(wallet, index));
  try {
    await locks[0]?.waitForWaiters(3);
    await locks[0]?.waitForWaitingBackends(wallets.length);
  } finally {
    await Promise.all(locks.map((lock) => lock.release()));
  }
  return Promise.all(pending);
}

/** "status:código" de cada resposta, em ordem estável para comparar com o esperado. */
function outcomeOf(responses: readonly { status: number; body: unknown }[]): string[] {
  return responses
    .map((response) => {
      const code = field(response.body, 'code');
      return `${response.status}:${typeof code === 'string' ? code : 'ok'}`;
    })
    .sort((left, right) => left.localeCompare(right));
}

function races(): number {
  return cluster.instances.reduce(
    (total, instance) =>
      total + instance.logs.entries.filter((entry) => entry.event === 'transaction.unique_race').length,
    0,
  );
}

describe('[CT-10] corridas de 23505 em wallets diferentes', () => {
  test('[CT-10] mesmo (provider, externalId) com keys diferentes → 1×200 e 5×409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(cluster.next().baseUrl, '100.00')));
    const racesBefore = races();
    const responses = await raceOnInsert(wallets, (wallet, index) =>
      submit(
        cluster.at(index).baseUrl,
        submission(wallet, { externalTransactionId: 'same-external-id' }),
        `ext-race-${index}`,
      ),
    );
    const outcome = outcomeOf(responses);
    writeEvidence('CT-10-external', { outcome, uniqueRaces: races() - racesBefore });
    expect(outcome).toEqual(['200:ok', ...Array.from({ length: 5 }, () => '409:EXTERNAL_TRANSACTION_ID_CONFLICT')]);
    expect(races() - racesBefore).toBeGreaterThan(0);
  });

  test('[CT-10] mesma key com payloads diferentes (wallets diferentes) → 1×200 e 5×409 IDEMPOTENCY_KEY_REUSED', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet(cluster.next().baseUrl, '100.00')));
    const racesBefore = races();
    const responses = await raceOnInsert(wallets, (wallet, index) =>
      submit(cluster.at(index).baseUrl, submission(wallet), 'same-key-race'),
    );
    const outcome = outcomeOf(responses);
    writeEvidence('CT-10-key', { outcome, uniqueRaces: races() - racesBefore });
    expect(outcome).toEqual(['200:ok', ...Array.from({ length: 5 }, () => '409:IDEMPOTENCY_KEY_REUSED')]);
    expect(races() - racesBefore).toBeGreaterThan(0);
  });
});
