import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { lockWallet } from '../support/contention.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { centsOf, ModelWallet, textOf } from '../support/model.ts';
import {
  invariantIssues,
  openWallet,
  send,
  type SubmissionBody,
  submission,
  type TestWallet,
  walletState,
} from '../support/wagering.ts';

/**
 * CT-04h (§13 concorrência item 4, via HTTP): ≥ 3 instâncias com carga mista (BET, WIN, LOSS e
 * duplicatas) sobre várias wallets. A contenção entre as 3 instâncias é comprovada antes; o saldo
 * esperado vem do modelo de referência ingênuo (D58), não do código de produção.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct04');
  cluster = await startCluster(fixture, 'ct04');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const OPERATIONS: readonly { kind: 'BET' | 'WIN' | 'LOSS'; amount: string }[] = [
  { kind: 'BET', amount: '5.00' },
  { kind: 'WIN', amount: '3.00' },
  { kind: 'BET', amount: '2.50' },
  { kind: 'LOSS', amount: '0.00' },
  { kind: 'BET', amount: '7.25' },
  { kind: 'WIN', amount: '1.10' },
];

describe('[CT-04h] 3 instâncias, carga mista, várias wallets', () => {
  test('[CT-04h] contenção comprovada entre 3 instâncias na mesma wallet', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const lock = await lockWallet(fixture.database, wallet.walletId);
    const pending = [0, 1, 2].map((index) => send(cluster.at(index).baseUrl, submission(wallet, { amount: '1.00' })));
    const waiters = await lock.waitForWaiters(3).finally(() => lock.release());
    const responses = await Promise.all(pending);
    writeEvidence('CT-04h-contention', { waiters, statuses: responses.map((response) => response.status) });
    expect(waiters).toEqual(['app:ct04-1', 'app:ct04-2', 'app:ct04-3']);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '97.00', debits: '3' });
  });

  test('[CT-04h] 5 wallets × 60 operações (com duplicatas) → saldo igual ao do modelo e ledger íntegro', async () => {
    const wallets: TestWallet[] = await Promise.all(
      Array.from({ length: 5 }, () => openWallet(cluster.next().baseUrl, '500.00')),
    );
    const plans = wallets.map((wallet) => {
      const bodies: SubmissionBody[] = Array.from({ length: 30 }, (_, index) => {
        const operation = OPERATIONS[index % OPERATIONS.length] ?? { kind: 'BET', amount: '1.00' };
        return submission(wallet, { kind: operation.kind, amount: operation.amount });
      });
      const model = new ModelWallet(centsOf('500.00'));
      for (const body of bodies) {
        if (body.kind !== 'LOSS') model.apply(body.kind === 'BET' ? 'DEBIT' : 'CREDIT', centsOf(body.money.amount));
      }
      return { wallet, bodies, model };
    });
    // Cada operação vai duas vezes (duplicata at-least-once), em instâncias diferentes, tudo misturado.
    const tasks = plans.flatMap((plan) =>
      plan.bodies.flatMap((body, index) => [
        () => send(cluster.at(index).baseUrl, body),
        () => send(cluster.at(index + 1).baseUrl, body),
      ]),
    );
    const shuffled = tasks
      .map((task, index) => ({ task, order: (index * 7919) % tasks.length }))
      .sort((left, right) => left.order - right.order);
    const responses = await inParallel(
      shuffled.map((entry) => entry.task),
      30,
    );
    const instances = new Set(responses.map((response) => response.headers.get('x-instance-id')));
    expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
    expect(instances.size).toBe(3);
    for (const plan of plans) {
      const state = await walletState(fixture.database, plan.wallet.walletId);
      expect({ wallet: plan.wallet.walletId, balance: state.balance, transactions: state.transactions }).toEqual({
        wallet: plan.wallet.walletId,
        balance: textOf(plan.model.balance),
        transactions: '30',
      });
    }
  });
});
