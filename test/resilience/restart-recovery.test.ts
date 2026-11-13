import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { inParallel } from '../support/cluster.ts';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field } from '../support/http.ts';
import { signal, startInstance, waitReady } from '../support/instances.ts';
import { consumerEnv, inboxRows, sendMessage, wagerMessage, type WagerMessage } from '../support/messaging.ts';
import { setDeadline, storedTransaction } from '../support/pending.ts';
import { withClient } from '../support/sql-fixtures.ts';
import {
  invariantIssues,
  openWallet,
  send,
  submission,
  type SubmissionBody,
  type TestWallet,
  walletState,
} from '../support/wagering.ts';

/**
 * Recuperação depois de reinício (§13 item 8, D37, D47). IT-27: outbox não publicada, pendência e
 * mensagem na fila sobrevivem a uma instância morta e são concluídas pela seguinte. CT-08: três
 * instâncias sob carga HTTP + SQS caem juntas (SIGKILL e, na variante, SIGTERM) e, depois do
 * reinício, o sistema converge: cada operação decidida uma vez, outbox publicada, nenhuma pendência
 * esquecida, reconciliação consistente e verificador global sem violação.
 */
let fixture: Fixture;

const ALL_ROLES = 'api,consumer,outbox-publisher,pending-reference-worker';

beforeAll(async () => {
  fixture = await createFixture('restart');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const sql = <T extends Record<string, unknown>>(text: string, parameters: unknown[] = []) =>
  withClient(ownerUrl(fixture.database), async (client) => (await client.query<T>(text, parameters)).rows);

const startAll = (id: string) => startInstance({ id, env: consumerEnv(fixture, { APP_ROLES: ALL_ROLES }) });

async function converged(timeoutMs: number, messages: readonly WagerMessage[]): Promise<void> {
  await eventually(
    async () => {
      const [state] = await sql<{ unpublished: string; pending: string }>(
        `SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL)::text AS unpublished,
                (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE')::text AS pending`,
      );
      if (state?.unpublished !== '0' || state.pending !== '0') return undefined;
      for (const message of messages)
        if ((await inboxRows(fixture.database, message.messageId)).length !== 1) return undefined;
      return true;
    },
    {
      timeoutMs,
      describe: 'outbox publicada, nenhuma pendência e todas as mensagens na inbox',
      diagnose: () =>
        sql(`SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
                    (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE') AS pending`),
    },
  );
}

describe('[IT-27] recuperação após reinício da app', () => {
  test('[IT-27] outbox pendente, pendência e mensagem em voo: a instância seguinte conclui tudo uma vez', async () => {
    const apiOnly = startInstance({ id: 'restart-api', env: fixture.env() });
    await waitReady(apiOnly);
    const wallet = await openWallet(apiOnly.baseUrl, '100.00');
    const pending = await send(
      apiOnly.baseUrl,
      submission(wallet, { kind: 'REFUND', amount: '10.00', referenceExternalTransactionId: 'it27-bet' }),
    );
    expect(pending.status).toBe(202);
    const pendingId = String(field(pending.body, 'transactionId'));
    await setDeadline(fixture.database, pendingId, `accepted_at + interval '1 hour'`);
    expect(
      (await send(apiOnly.baseUrl, submission(wallet, { amount: '10.00', externalTransactionId: 'it27-bet' }))).status,
    ).toBe(200);
    const message = wagerMessage(submission(wallet, { amount: '5.00' }));
    await sendMessage(fixture, message);
    signal(apiOnly, 'SIGTERM');
    await apiOnly.exited;
    const before = await sql<{ unpublished: string }>(
      'SELECT count(*)::text AS unpublished FROM outbox_messages WHERE published_at IS NULL',
    );

    // Primeira instância completa sobe e morre logo depois de ficar pronta (queda real, SIGKILL).
    const first = startAll('restart-first');
    await waitReady(first);
    signal(first, 'SIGKILL');
    await first.exited;

    const second = startAll('restart-second');
    await waitReady(second);
    await converged(30_000, [message]);
    const outcome = {
      unpublishedBefore: before[0]?.unpublished,
      pending: (await storedTransaction(fixture.database, pendingId)).status,
      inbox: await inboxRows(fixture.database, message.messageId),
      wallet: await walletState(fixture.database, wallet.walletId),
    };
    writeEvidence('IT-27', outcome);
    expect(Number(outcome.unpublishedBefore)).toBeGreaterThan(0);
    expect(outcome.pending).toBe('PROCESSED');
    expect(outcome.inbox).toHaveLength(1);
    // 100 − 10 (BET) + 10 (REFUND) − 5 (BET pela fila) = 95.00
    expect(outcome.wallet).toMatchObject({ balance: '95.00' });
    signal(second, 'SIGTERM');
    await second.exited;
  });
});

interface Load {
  readonly wallets: TestWallet[];
  readonly http: SubmissionBody[];
  readonly messages: WagerMessage[];
}

async function prepareLoad(baseUrl: string, prefix: string): Promise<Load> {
  const wallets: TestWallet[] = [];
  for (let index = 0; index < 6; index++) wallets.push(await openWallet(baseUrl, '500.00'));
  const http: SubmissionBody[] = [];
  const messages: WagerMessage[] = [];
  wallets.forEach((wallet, walletIndex) => {
    for (let operation = 0; operation < 5; operation++) {
      http.push(submission(wallet, { amount: `${operation + 1}.00` }));
      messages.push(wagerMessage(submission(wallet, { amount: `${operation + 2}.00` })));
    }
    // Reembolso antes da aposta, os dois pela fila (pendência resolvida pelo worker).
    const betId = `${prefix}-bet-${walletIndex}`;
    messages.push(
      wagerMessage(submission(wallet, { kind: 'REFUND', amount: '3.00', referenceExternalTransactionId: betId })),
    );
    messages.push(wagerMessage(submission(wallet, { amount: '3.00', externalTransactionId: betId })));
  });
  return { wallets, http, messages };
}

/** Envia uma operação HTTP; falha de rede ou 503 durante a queda fica para reenvio com a MESMA key. */
async function trySend(baseUrl: string, body: SubmissionBody): Promise<boolean> {
  try {
    const response = await send(baseUrl, body);
    return response.status === 200 || response.status === 422;
  } catch {
    return false;
  }
}

async function crashAndRecover(variant: 'SIGKILL' | 'SIGTERM'): Promise<Record<string, unknown>> {
  const cluster = [1, 2, 3].map((index) => startAll(`ct08-${variant}-${index}`));
  await Promise.all(cluster.map((instance) => waitReady(instance)));
  const load = await prepareLoad(cluster[0]?.baseUrl ?? '', `ct08-${variant}`);
  const sending = inParallel(
    load.http.map((body, index) => async () => ({ body, ok: await trySend(cluster[index % 3]?.baseUrl ?? '', body) })),
    6,
  );
  await Promise.all(
    load.messages.map((message) => sendMessage(fixture, message, { groupId: `g-${Bun.randomUUIDv7()}` })),
  );
  await Bun.sleep(300);
  for (const instance of cluster) signal(instance, variant);
  const exits = await Promise.all(cluster.map((instance) => instance.exited));
  const httpResults = await sending;

  const restarted = [1, 2, 3].map((index) => startAll(`ct08-${variant}-r${index}`));
  await Promise.all(restarted.map((instance) => waitReady(instance)));
  // O provedor reenvia, com a mesma key, o que não teve resposta durante a queda.
  const retried = httpResults.filter((result) => !result.ok);
  for (const [index, result] of retried.entries()) {
    expect(await trySend(restarted[index % 3]?.baseUrl ?? '', result.body)).toBe(true);
  }
  await converged(60_000, load.messages);

  const perOperation = await sql<{ external: string; n: string }>(
    `SELECT external_transaction_id AS external, count(*)::text AS n FROM wager_transactions
      WHERE external_transaction_id = ANY($1::text[]) GROUP BY external_transaction_id`,
    [
      [
        ...load.http.map((body) => body.externalTransactionId),
        ...load.messages.map((message) => String(message.data['externalTransactionId'])),
      ],
    ],
  );
  const reconciliations = await Promise.all(
    load.wallets.map(async (wallet) =>
      field(
        (await api(restarted[0]?.baseUrl ?? '', 'POST', `/wallets/${wallet.walletId}/reconciliation`)).body,
        'consistent',
      ),
    ),
  );
  const issues = await invariantIssues(fixture.database);
  for (const instance of restarted) signal(instance, 'SIGTERM');
  await Promise.all(restarted.map((instance) => instance.exited));
  return {
    variant,
    exits,
    httpSent: load.http.length,
    httpRetried: retried.length,
    messages: load.messages.length,
    decidedOperations: perOperation.length,
    duplicated: perOperation.filter((row) => row.n !== '1').length,
    reconciliations,
    issues,
  };
}

describe('[CT-08] reinício das três instâncias com prova de consistência final', () => {
  test('[CT-08] SIGKILL nas 3 sob carga HTTP + SQS, reinício e convergência', async () => {
    const result = await crashAndRecover('SIGKILL');
    writeEvidence('CT-08-SIGKILL', result);
    expect(result['exits']).toEqual([
      { exitCode: null, signalCode: 'SIGKILL' },
      { exitCode: null, signalCode: 'SIGKILL' },
      { exitCode: null, signalCode: 'SIGKILL' },
    ]);
    expect(result['decidedOperations']).toBe(Number(result['httpSent']) + Number(result['messages']));
    expect(result['duplicated']).toBe(0);
    expect(result['reconciliations']).toEqual([true, true, true, true, true, true]);
    expect(result['issues']).toEqual([]);
  });

  test('[CT-08] variante SIGTERM: drenagem limpa (exit 0) e a mesma convergência', async () => {
    const result = await crashAndRecover('SIGTERM');
    writeEvidence('CT-08-SIGTERM', result);
    expect(result['exits']).toEqual([
      { exitCode: 0, signalCode: null },
      { exitCode: 0, signalCode: null },
      { exitCode: 0, signalCode: null },
    ]);
    expect(result['decidedOperations']).toBe(Number(result['httpSent']) + Number(result['messages']));
    expect(result['duplicated']).toBe(0);
    expect(result['reconciliations']).toEqual([true, true, true, true, true, true]);
    expect(result['issues']).toEqual([]);
  });
});
