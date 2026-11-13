import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { ownerUrl } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field, stringField } from '../support/http.ts';
import { setDeadline, storedTransaction, waitResolved } from '../support/pending.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, send, submission, type TestWallet, walletState } from '../support/wagering.ts';

/**
 * CT-07h (§13 concorrência item 7, via HTTP): REFUND/ROLLBACK entregues antes da referência, com 3
 * instâncias que também rodam o worker. Inclui a corrida no prazo: o desfecho de cada pendência é
 * previsto pelo teste lendo do banco o aceite da referência e o prazo da pendência — o horário do
 * worker não pode mudar o resultado (D40).
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct07');
  cluster = await startCluster(fixture, 'ct07', { env: { APP_ROLES: 'api,pending-reference-worker' } });
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

/** Prazo da pendência = agora + δ; a referência é enviada logo depois, por outra instância. */
const RACE_DELTAS_MS = [0, 5, 10, 20, 40, 80, 160, 320, 640, 1000] as const;

const transactionIdOf = (response: { status: number; body: unknown }) =>
  response.status === 422
    ? stringField(field(response.body, 'transaction'), 'transactionId')
    : stringField(response.body, 'transactionId');

describe('[CT-07h] reversões antes da referência com 3 instâncias e worker', () => {
  test('[CT-07h] 50 iterações BET ‖ REFUND (com duplicata do REFUND): sempre um único reembolso; saldo final 100.00', async () => {
    const results = await inParallel(
      Array.from({ length: 50 }, (_, iteration) => async () => {
        const wallet = await openWallet(cluster.at(iteration).baseUrl, '100.00');
        const bet = submission(wallet, { amount: '10.00', externalTransactionId: `ct07-b-${iteration}` });
        const refund = submission(wallet, {
          kind: 'REFUND',
          amount: '10.00',
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        const [refundFirst, , refundDuplicate] = await Promise.all([
          send(cluster.at(iteration).baseUrl, refund),
          send(cluster.at(iteration + 1).baseUrl, bet),
          send(cluster.at(iteration + 2).baseUrl, refund),
        ]);
        const refundId = transactionIdOf(refundFirst);
        expect(transactionIdOf(refundDuplicate)).toBe(refundId);
        await waitResolved(fixture.database, [refundId]);
        return { wallet, refundId };
      }),
      6,
    );
    for (const { wallet, refundId } of results) {
      expect((await storedTransaction(fixture.database, refundId)).status).toBe('PROCESSED');
      expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '100.00', entries: '3' });
    }
  });

  test('[CT-07h] ROLLBACK de WIN antes do WIN → resolvido com débito; referência que nunca chega → REFERENCE_NOT_FOUND pelo TTL', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const rollback = await send(
      cluster.next().baseUrl,
      submission(wallet, { kind: 'ROLLBACK', amount: '30.00', referenceExternalTransactionId: 'ct07-win' }),
    );
    expect(rollback.status).toBe(202);
    await send(
      cluster.next().baseUrl,
      submission(wallet, { kind: 'WIN', amount: '30.00', externalTransactionId: 'ct07-win' }),
    );
    const orphan = await send(
      cluster.next().baseUrl,
      submission(wallet, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'nunca-chega' }),
    );
    await waitResolved(fixture.database, [transactionIdOf(rollback), transactionIdOf(orphan)], 20_000);
    expect(await storedTransaction(fixture.database, transactionIdOf(rollback))).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    expect(await storedTransaction(fixture.database, transactionIdOf(orphan))).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      availableEqualsDeadline: true,
    });
    const rejectedEvent = await withClient(ownerUrl(fixture.database), async (client) => {
      const result = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM outbox_messages
          WHERE event_type = 'WagerTransactionRejected' AND payload -> 'data' ->> 'transactionId' = $1`,
        [transactionIdOf(orphan)],
      );
      return result.rows[0]?.n;
    });
    expect(rejectedEvent).toBe('1');
  });

  test('[CT-07h] corrida no prazo: 50 iterações com prazo = agora + δ e a referência em paralelo; o banco prevê o desfecho', async () => {
    const outcomes = await inParallel(
      Array.from({ length: 50 }, (_, iteration) => async () => {
        const wallet: TestWallet = await openWallet(cluster.at(iteration).baseUrl, '100.00');
        const betExternalId = `ct07-race-${iteration}`;
        const pending = await send(
          cluster.at(iteration).baseUrl,
          submission(wallet, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: betExternalId }),
        );
        const pendingId = transactionIdOf(pending);
        const delta = RACE_DELTAS_MS[iteration % RACE_DELTAS_MS.length] ?? 0;
        await setDeadline(fixture.database, pendingId, `clock_timestamp() + interval '${delta} milliseconds'`);
        const bet = await send(
          cluster.at(iteration + 1).baseUrl,
          submission(wallet, { amount: '10.00', externalTransactionId: betExternalId }),
        );
        await waitResolved(fixture.database, [pendingId]);
        const predicted = await withClient(ownerUrl(fixture.database), async (client) => {
          const result = await client.query<{ in_time: boolean }>(
            `SELECT r.accepted_at <= p.pending_deadline_at AS in_time
               FROM wager_transactions p, wager_transactions r WHERE p.id = $1::uuid AND r.id = $2::uuid`,
            [pendingId, transactionIdOf(bet)],
          );
          return result.rows[0]?.in_time ? 'PROCESSED' : 'REJECTED:REFERENCE_NOT_FOUND';
        });
        const stored = await storedTransaction(fixture.database, pendingId);
        const actual = stored.status === 'PROCESSED' ? 'PROCESSED' : `${stored.status}:${String(stored.failureCode)}`;
        return { predicted, actual };
      }),
      8,
    );
    const mismatches = outcomes.filter((outcome) => outcome.predicted !== outcome.actual);
    writeEvidence('CT-07h-deadline-race', {
      iterations: outcomes.length,
      processed: outcomes.filter((outcome) => outcome.actual === 'PROCESSED').length,
      notFound: outcomes.filter((outcome) => outcome.actual !== 'PROCESSED').length,
      mismatches,
    });
    expect(mismatches).toEqual([]);
    // Os dois lados do prazo precisam aparecer: δ = 0 deixa a referência sempre depois do prazo e
    // δ = 1 s, com folga, antes dele.
    expect(outcomes.some((outcome) => outcome.actual === 'PROCESSED')).toBe(true);
    expect(outcomes.some((outcome) => outcome.actual !== 'PROCESSED')).toBe(true);
  });
});
