import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import {
  consumerEnv,
  copiesIn,
  effectsOfExternal,
  faultPlan,
  inboxRows,
  sendMessage,
  waitCopies,
  wagerMessage,
} from '../support/messaging.ts';
import { queueCounts } from '../support/sqs.ts';
import { invariantIssues, openWallet, submission, walletState } from '../support/wagering.ts';

/**
 * Quedas e encerramento do consumidor (D37, D47): morte depois do commit e antes do ack (CT-05),
 * SIGTERM concluindo ou devolvendo a mensagem em voo (IT-28) e mensagem venenosa que derruba o
 * processo a cada entrega (IT-30).
 */
let fixture: Fixture;
let api: Instance;

beforeAll(async () => {
  fixture = await createFixture('ccrash');
  api = startInstance({ id: 'ccrash-api', env: fixture.env() });
  await waitReady(api);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function stop(instance: Instance): Promise<void> {
  signal(instance, 'SIGTERM');
  await instance.exited;
}

const waitInbox = (messageId: string, timeoutMs = 20_000) =>
  eventually(async () => (await inboxRows(fixture.database, messageId))[0], {
    timeoutMs,
    describe: `inbox de ${messageId}`,
  });

describe('[CT-05] consumidor morto depois do commit e antes do ack', () => {
  test('[CT-05] cinco evidências: marcador, SIGKILL próprio, commit visível, reentrega (count ≥ 2) e duplicata no sucessor', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    const victim = startInstance({
      id: 'ccrash-05a',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        ...faultPlan('consumer.afterCommitBeforeAck', 'kill', { messageId: message.messageId }),
      }),
    });
    await waitReady(victim);
    await sendMessage(fixture, message);
    const exit = await victim.exited;
    // (1) marcador e (2) SIGKILL autoinfligido, sem kill do harness.
    const marker = victim.logs.find('fault.injected');
    expect(marker).toMatchObject({ point: 'consumer.afterCommitBeforeAck', messageId: message.messageId });
    expect(exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' });
    expect(victim.killLog).toEqual([]);
    // (3) PostgreSQL antes do sucessor: o commit está visível (inbox, transação e lançamento).
    const committed = {
      inbox: await inboxRows(fixture.database, message.messageId),
      effects: await effectsOfExternal(fixture.database, bet.externalTransactionId),
    };
    expect(committed.inbox).toMatchObject([{ outcome: 'PROCESSED' }]);
    expect(committed.effects).toEqual({ transactions: 1, entries: 1, statuses: ['PROCESSED'] });
    // (4) SQS: a mensagem não foi apagada (em voo até o VT vencer).
    const sqsAtKill = await queueCounts(fixture.sqs, fixture.inbound.url);
    expect(sqsAtKill.visible + sqsAtKill.notVisible).toBe(1);

    const successor = startInstance({ id: 'ccrash-05b', env: consumerEnv(fixture) });
    await waitReady(successor);
    const duplicate = await successor.logs.waitFor('consumer.duplicate', 15_000);
    const received = successor.logs.entries.find(
      (entry) => entry.event === 'consumer.received' && entry['messageId'] === message.messageId,
    );
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    // (5) contagens exatas e verificador global.
    const final = {
      inbox: await inboxRows(fixture.database, message.messageId),
      effects: await effectsOfExternal(fixture.database, bet.externalTransactionId),
      wallet: await walletState(fixture.database, wallet.walletId),
      issues: await invariantIssues(fixture.database),
    };
    writeEvidence('CT-05', {
      marker,
      exit,
      killLog: victim.killLog,
      committed,
      sqsAtKill,
      redelivery: { receiveCount: received?.['receiveCount'] ?? null, duplicate: duplicate['messageId'] },
      final,
    });
    expect(Number(received?.['receiveCount'])).toBeGreaterThanOrEqual(2);
    expect(duplicate['messageId']).toBe(message.messageId);
    expect(final.inbox).toHaveLength(1);
    expect(final.effects).toEqual({ transactions: 1, entries: 1, statuses: ['PROCESSED'] });
    expect(final.wallet).toMatchObject({ balance: '90.00', entries: '2' });
    expect(final.issues).toEqual([]);
    await stop(successor);
  });
});

describe('[IT-28] SIGTERM com mensagem em voo', () => {
  test('[IT-28] concluir: ready 503 e live 200 na drenagem; a mensagem termina, é confirmada e o processo sai com 0', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const message = wagerMessage(submission(wallet, { amount: '10.00' }));
    const instance = startInstance({
      id: 'ccrash-28a',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        ...faultPlan('uow.beforeCommit', 'pause', { messageId: message.messageId }),
      }),
    });
    await waitReady(instance);
    await sendMessage(fixture, message);
    await instance.logs.waitFor('fault.injected', 15_000);
    signal(instance, 'SIGTERM');
    await instance.logs.waitFor('inflight.draining', 5000);
    const ready = await fetch(`${instance.baseUrl}/health/ready`);
    const live = await fetch(`${instance.baseUrl}/health/live`);
    signal(instance, 'SIGUSR2');
    const exit = await instance.exited;
    const order = instance.logs
      .events()
      .filter((event) =>
        [
          'shutdown.signal_received',
          'readiness.off',
          'pollers.stopped',
          'inflight.draining',
          'inflight.completed',
          'visibility.returned',
          'http.closed',
          'db.closed',
          'shutdown.complete',
        ].includes(event),
      );
    writeEvidence('IT-28-concluir', { ready: ready.status, live: live.status, order, exit });
    expect([ready.status, live.status]).toEqual([503, 200]);
    expect(order).toEqual([
      'shutdown.signal_received',
      'readiness.off',
      'pollers.stopped',
      'inflight.draining',
      'inflight.completed',
      'http.closed',
      'db.closed',
      'shutdown.complete',
    ]);
    expect(exit).toEqual({ exitCode: 0, signalCode: null });
    expect((await inboxRows(fixture.database, message.messageId))[0]?.outcome).toBe('PROCESSED');
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
  });

  test('[IT-28] devolver: a drenagem vence, a visibilidade volta a 0 e outra instância processa em ≤ Wait + 1 s', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    const instance = startInstance({
      id: 'ccrash-28b',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        SHUTDOWN_DRAIN_MS: '2000',
        ...faultPlan('uow.beforeCommit', 'pause', { messageId: message.messageId }),
      }),
    });
    await waitReady(instance);
    await sendMessage(fixture, message);
    await instance.logs.waitFor('fault.injected', 15_000);
    const other = startInstance({ id: 'ccrash-28c', env: consumerEnv(fixture) });
    try {
      await waitReady(other);
      signal(instance, 'SIGTERM');
      const returned = await instance.logs.waitFor('visibility.returned', 10_000);
      const exit = await instance.exited;
      const received = await eventually(
        () =>
          other.logs.entries.find(
            (entry) => entry.event === 'consumer.received' && entry['messageId'] === message.messageId,
          ),
        { timeoutMs: 15_000, describe: 'outra instância recebe a mensagem devolvida' },
      );
      await waitInbox(message.messageId);
      const elapsedMs = Date.parse(String(received['time'])) - Date.parse(String(returned['time']));
      writeEvidence('IT-28-devolver', {
        exit,
        elapsedMs,
        receiveCount: received['receiveCount'],
        closeTimeouts: instance.logs.entries.filter((entry) => entry.event === 'shutdown.close_timeout').length,
      });
      expect(exit).toEqual({ exitCode: 0, signalCode: null });
      // Wait 1 s + 1 s: bem antes do VT (3 s), então foi a devolução, não a expiração do VT.
      expect(elapsedMs).toBeLessThanOrEqual(2000);
      expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
        transactions: 1,
        entries: 1,
      });
    } finally {
      await stop(other);
    }
  });
});

describe('[IT-30] mensagem venenosa', () => {
  test('[IT-30] derruba o processo a cada entrega: quedas ≤ maxReceiveCount, vai para a DLQ e as outras wallets seguem', async () => {
    const poisonWallet = await openWallet(api.baseUrl, '100.00');
    const poison = wagerMessage(submission(poisonWallet, { amount: '10.00' }));
    const others = [];
    for (let index = 0; index < 3; index++) {
      const wallet = await openWallet(api.baseUrl, '100.00');
      others.push(wagerMessage(submission(wallet, { amount: '10.00' })));
    }
    const dlqBefore = await copiesIn(fixture.sqs, fixture.dlq.url);
    await sendMessage(fixture, poison);
    for (const message of others) await sendMessage(fixture, message);
    const env = consumerEnv(fixture, {
      CONSUMER_POLLERS: '1',
      ...faultPlan('consumer.afterReceive', 'kill', { messageId: poison.messageId }),
    });
    let crashes = 0;
    let survivor: Instance | undefined;
    for (let round = 0; round < 8 && survivor === undefined; round++) {
      // Sem esperar o ready: a instância pode receber a venenosa e cair antes do health responder.
      const instance = startInstance({ id: `ccrash-30-${round}`, env });
      const outcome = await Promise.race([
        instance.exited.then((exit) => ({ type: 'exit' as const, exit })),
        eventually(async () => ((await copiesIn(fixture.sqs, fixture.dlq.url)) > dlqBefore ? true : undefined), {
          timeoutMs: 15_000,
          describe: 'venenosa na DLQ',
        }).then(
          () => ({ type: 'moved' as const }),
          () => ({ type: 'timeout' as const }),
        ),
      ]);
      if (outcome.type === 'exit') {
        expect(outcome.exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' });
        crashes += 1;
      } else if (outcome.type === 'moved') {
        survivor = instance;
      } else {
        await stop(instance);
        throw new Error(`rodada ${round}: a venenosa não derrubou o processo nem foi para a DLQ em 15 s`);
      }
    }
    expect(survivor).toBeDefined();
    for (const message of others) expect((await waitInbox(message.messageId)).outcome).toBe('PROCESSED');
    writeEvidence('IT-30', { crashes, maxReceiveCount: 5 });
    expect(crashes).toBeGreaterThanOrEqual(1);
    expect(crashes).toBeLessThanOrEqual(5);
    expect(await effectsOfExternal(fixture.database, String(poison.data['externalTransactionId']))).toMatchObject({
      transactions: 0,
    });
    if (survivor !== undefined) await stop(survivor);
  });
});
