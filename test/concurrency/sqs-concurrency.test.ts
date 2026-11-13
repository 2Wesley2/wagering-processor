import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import {
  deadLetterRows,
  effectsOfExternal,
  inboxRows,
  sendMessage,
  waitCopies,
  wagerMessage,
  type WagerMessage,
} from '../support/messaging.ts';
import { storedTransaction, waitResolved } from '../support/pending.ts';
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
 * Variantes SQS dos cenários de concorrência (§13), com 3 instâncias que consomem a fila (4 pollers
 * cada) e rodam o worker. Os MessageGroupIds são distintos de propósito: a ordem do FIFO não é
 * garantia (§8); o banco é quem decide.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ctsqs');
  cluster = await startCluster(fixture, 'ctsqs', {
    env: { APP_ROLES: 'api,consumer,pending-reference-worker', CONSUMER_POLLERS: '4' },
  });
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const groupOf = () => `g-${Bun.randomUUIDv7()}`;

async function waitInboxCount(messageIds: readonly string[], timeoutMs = 30_000): Promise<void> {
  await eventually(
    async () => {
      for (const id of messageIds) if ((await inboxRows(fixture.database, id)).length === 0) return undefined;
      return true;
    },
    { timeoutMs, describe: `${messageIds.length} mensagem(ns) na inbox` },
  );
}

async function sendAll(bodies: readonly WagerMessage[]): Promise<void> {
  await Promise.all(bodies.map((message) => sendMessage(fixture, message, { groupId: groupOf() })));
}

describe('[CT-01s] 50 duplicatas pela fila em 3 instâncias', () => {
  test('[CT-01s] 50 cópias do mesmo messageId + 10 messageIds novos com a mesma key: 1 efeito, 11 linhas de inbox', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const original = wagerMessage(bet);
    const fresh = Array.from({ length: 10 }, () => wagerMessage(bet));
    await sendAll([...Array.from({ length: 50 }, () => original), ...fresh]);
    await waitInboxCount([original.messageId, ...fresh.map((message) => message.messageId)]);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0, 40_000);
    const outcomes = (await inboxRows(fixture.database))
      .filter((row) => [original.messageId, ...fresh.map((message) => message.messageId)].includes(row.messageId))
      .map((row) => row.outcome);
    writeEvidence('CT-01s', { outcomes: outcomes.toSorted((left, right) => left.localeCompare(right)) });
    expect(outcomes.filter((outcome) => outcome === 'PROCESSED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'REPLAY')).toHaveLength(10);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toEqual({
      transactions: 1,
      entries: 1,
      statuses: ['PROCESSED'],
    });
    expect(await deadLetterRows(fixture.database, original.messageId)).toEqual([]);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
  });
});

describe('[CT-02s] §8 pela fila', () => {
  test('[CT-02s] 30 iterações: duas BETs de 80.00 sobre 100.00 em grupos distintos → 1 PROCESSED, 1 REJECTED, saldo 20.00', async () => {
    const outcomes = await inParallel(
      Array.from({ length: 30 }, (_, iteration) => async () => {
        const wallet = await openWallet(cluster.at(iteration).baseUrl, '100.00');
        const messages = [
          wagerMessage(submission(wallet, { amount: '80.00' })),
          wagerMessage(submission(wallet, { amount: '80.00' })),
        ];
        await sendAll(messages);
        await waitInboxCount(messages.map((message) => message.messageId));
        const rows = await Promise.all(
          messages.map(async (message) => (await inboxRows(fixture.database, message.messageId))[0]?.outcome),
        );
        const state = await walletState(fixture.database, wallet.walletId);
        return JSON.stringify({
          outcomes: rows.map((row) => row ?? '').toSorted((left, right) => left.localeCompare(right)),
          balance: state.balance,
          debits: state.debits,
        });
      }),
      6,
    );
    const distinct = [...new Set(outcomes)];
    writeEvidence('CT-02s', { iterations: outcomes.length, distinct });
    expect(distinct).toEqual([JSON.stringify({ outcomes: ['PROCESSED', 'REJECTED'], balance: '20.00', debits: '1' })]);
  });
});

describe('[CT-04s] carga mista HTTP + SQS em 3 instâncias', () => {
  test('[CT-04s] 6 wallets, 60 operações metade por canal: tudo decidido, inbox completa, invariantes válidas', async () => {
    const wallets: TestWallet[] = [];
    for (let index = 0; index < 6; index++) wallets.push(await openWallet(cluster.next().baseUrl, '500.00'));
    const viaQueue: WagerMessage[] = [];
    const viaHttp: SubmissionBody[] = [];
    wallets.forEach((wallet, walletIndex) => {
      for (let operation = 0; operation < 10; operation++) {
        const body =
          operation % 3 === 2
            ? submission(wallet, { kind: 'WIN', amount: '3.00' })
            : submission(wallet, { amount: `${((walletIndex + operation) % 7) + 1}.00` });
        if (operation % 2 === 0) viaQueue.push(wagerMessage(body));
        else viaHttp.push(body);
      }
    });
    await Promise.all([
      sendAll(viaQueue),
      inParallel(
        viaHttp.map((body, index) => async () => send(cluster.at(index).baseUrl, body)),
        9,
      ),
    ]);
    await waitInboxCount(
      viaQueue.map((message) => message.messageId),
      40_000,
    );
    const decided = await Promise.all(
      [
        ...viaQueue.map((message) => String(message.data['externalTransactionId'])),
        ...viaHttp.map((body) => body.externalTransactionId),
      ].map(async (externalId) => (await effectsOfExternal(fixture.database, externalId)).transactions),
    );
    writeEvidence('CT-04s', { queue: viaQueue.length, http: viaHttp.length });
    expect(decided.every((count) => count === 1)).toBe(true);
    expect(await invariantIssues(fixture.database)).toEqual([]);
  });
});

describe('[CT-07s] REFUND antes da referência pela fila, com worker', () => {
  test('[CT-07s] 20 iterações REFUND ‖ BET (REFUND duplicado): o reembolso vale uma vez; saldo 100.00', async () => {
    const results = await inParallel(
      Array.from({ length: 20 }, (_, iteration) => async () => {
        const wallet = await openWallet(cluster.at(iteration).baseUrl, '100.00');
        const bet = submission(wallet, { amount: '10.00', externalTransactionId: `ct07s-b-${iteration}` });
        const refund = wagerMessage(
          submission(wallet, {
            kind: 'REFUND',
            amount: '10.00',
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        );
        const betMessage = wagerMessage(bet);
        await sendAll([refund, betMessage, refund]);
        await waitInboxCount([refund.messageId, betMessage.messageId]);
        const refundId = (await inboxRows(fixture.database, refund.messageId))[0]?.transactionId ?? '';
        await waitResolved(fixture.database, [refundId], 20_000);
        return { wallet, refundId };
      }),
      5,
    );
    for (const { wallet, refundId } of results) {
      expect((await storedTransaction(fixture.database, refundId)).status).toBe('PROCESSED');
      expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '100.00', entries: '3' });
    }
  });
});

describe('[CT-11s] reversões concorrentes da mesma BET pela fila', () => {
  test('[CT-11s] 10 REFUND + 10 ROLLBACK com keys diferentes: 1 aplicada, 19 rejeitadas, um único crédito', async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const wallet = await openWallet(cluster.next().baseUrl, '100.00');
      const bet = submission(wallet, { amount: '10.00' });
      expect((await send(cluster.next().baseUrl, bet)).status).toBe(200);
      const reversal = (kind: 'REFUND' | 'ROLLBACK') =>
        wagerMessage(
          submission(wallet, { kind, amount: '10.00', referenceExternalTransactionId: bet.externalTransactionId }),
        );
      const messages = [
        ...Array.from({ length: 10 }, () => reversal('REFUND')),
        ...Array.from({ length: 10 }, () => reversal('ROLLBACK')),
      ];
      await sendAll(messages);
      await waitInboxCount(messages.map((message) => message.messageId));
      const outcomes = await Promise.all(
        messages.map(async (message) => (await inboxRows(fixture.database, message.messageId))[0]?.outcome),
      );
      expect(outcomes.filter((outcome) => outcome === 'PROCESSED')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === 'REJECTED')).toHaveLength(19);
      expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '100.00', entries: '3' });
    }
  });
});
