import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import {
  CONSUMER_NAME,
  consumerEnv,
  copiesIn,
  effectsOfExternal,
  faultPlan,
  inboxRows,
  peekMessages,
  sendMessage,
  waitCopies,
  waitDeadLetter,
  wagerMessage,
} from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, keyOf, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * Consumidor SQS (F5) contra o MiniStack real: o MESMO caso de uso do HTTP, com a inbox na mesma
 * transação SQL da decisão e o ack só depois do commit. Valores esperados fixos (D58).
 */
let fixture: Fixture;
let consumer: Instance;

beforeAll(async () => {
  fixture = await createFixture('msgc');
  consumer = startInstance({ id: 'msgc-1', env: consumerEnv(fixture) });
  await waitReady(consumer);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const waitInbox = (messageId: string) =>
  eventually(async () => (await inboxRows(fixture.database, messageId))[0], {
    timeoutMs: 15_000,
    describe: `inbox de ${messageId}`,
    diagnose: () => ({ events: consumer.logs.events().slice(-15) }),
  });

async function outboxCount(walletId: string): Promise<string> {
  return (await walletState(fixture.database, walletId)).outbox;
}

describe('[IT-14] entre canais: HTTP e SQS com a mesma Idempotency-Key', () => {
  test('[IT-14] (a) HTTP primeiro; SQS com a mesma key e payload → inbox REPLAY, 1 tx, 1 lançamento, nenhum evento novo', async () => {
    const wallet = await openWallet(consumer.baseUrl, '1000.00');
    const bet = submission(wallet, { amount: '25.00' });
    const http = await send(consumer.baseUrl, bet);
    expect([http.status, field(http.body, 'balance')]).toEqual([200, { amount: '975.00', currency: 'BRL' }]);
    const eventsBefore = await outboxCount(wallet.walletId);
    const message = wagerMessage(bet);
    await sendMessage(fixture, message);
    expect(await waitInbox(message.messageId)).toMatchObject({
      outcome: 'REPLAY',
      transactionId: field(http.body, 'transactionId'),
    });
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toEqual({
      transactions: 1,
      entries: 1,
      statuses: ['PROCESSED'],
    });
    expect(await outboxCount(wallet.walletId)).toBe(eventsBefore);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
  });

  test('[IT-14] (b) SQS primeiro; HTTP com a mesma key → 200 com o corpo original e idempotentReplay true', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    await sendMessage(fixture, message);
    const inbox = await waitInbox(message.messageId);
    expect(inbox.outcome).toBe('PROCESSED');
    const http = await send(consumer.baseUrl, bet);
    expect([http.status, http.body]).toEqual([
      200,
      {
        transactionId: inbox.transactionId,
        status: 'PROCESSED',
        balance: { amount: '90.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    ]);
  });

  test('[IT-14] (c) SQS com a key já usada e outro payload → dead-letter IDEMPOTENCY_KEY_REUSED, sem inbox; a original intacta', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    expect((await send(consumer.baseUrl, bet)).status).toBe(200);
    const conflicting = wagerMessage(
      { ...bet, money: { amount: '30.00', currency: 'BRL' } },
      { idempotencyKey: keyOf(bet) },
    );
    await sendMessage(fixture, conflicting);
    const row = await waitDeadLetter(fixture.database, conflicting.messageId, { state: 'IN_DLQ' });
    expect(row).toMatchObject({ reason: 'IDEMPOTENCY_KEY_REUSED', attempt: 1 });
    expect(await inboxRows(fixture.database, conflicting.messageId)).toEqual([]);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toEqual({
      transactions: 1,
      entries: 1,
      statuses: ['PROCESSED'],
    });
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
  });

  test('[IT-14] (d) todos os kinds pela fila passam pelas mesmas regras e CHECKs', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00', externalTransactionId: 'd-bet' });
    const refundTarget = submission(wallet, { amount: '5.00', externalTransactionId: 'd-bet2' });
    const rollbackTarget = submission(wallet, { amount: '7.00', externalTransactionId: 'd-bet3' });
    const flow = [
      bet,
      submission(wallet, { kind: 'WIN', amount: '30.00', referenceExternalTransactionId: 'd-bet' }),
      submission(wallet, { kind: 'LOSS', amount: '0.00', referenceExternalTransactionId: 'd-bet' }),
      refundTarget,
      submission(wallet, { kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: 'd-bet2' }),
      rollbackTarget,
      submission(wallet, { kind: 'ROLLBACK', amount: '7.00', referenceExternalTransactionId: 'd-bet3' }),
    ];
    const messages = flow.map((body) => wagerMessage(body));
    // Mesmo MessageGroupId (a wallet): o FIFO entrega na ordem de envio.
    for (const message of messages) await sendMessage(fixture, message);
    const outcomes = [];
    for (const message of messages) outcomes.push((await waitInbox(message.messageId)).outcome);
    expect(outcomes).toEqual([
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
      'PROCESSED',
    ]);
    // 100 − 10 + 30 − 5 + 5 − 7 + 7 = 120.00
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '120.00', entries: '7' });
  });
});

describe('[IT-20] inbox e reentrega', () => {
  test('[IT-20] 3 cópias do mesmo messageId com DedupIds distintos → 1 inbox, 1 tx; o resto é duplicata', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    for (let copy = 0; copy < 3; copy++) await sendMessage(fixture, message);
    await waitInbox(message.messageId);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    expect(await inboxRows(fixture.database, message.messageId)).toHaveLength(1);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
    const duplicates = consumer.logs.entries.filter(
      (entry) => entry.event === 'consumer.duplicate' && entry['messageId'] === message.messageId,
    );
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
  });

  test('[IT-20] mesmo messageId com outro payload → MESSAGE_ID_PAYLOAD_MISMATCH; messageId novo com a mesma key → REPLAY', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const original = wagerMessage(bet);
    await sendMessage(fixture, original);
    await waitInbox(original.messageId);
    const mismatch = { ...original, data: { ...original.data, gameId: 'outro-jogo' } };
    await sendMessage(fixture, mismatch);
    const row = await waitDeadLetter(fixture.database, original.messageId, { state: 'IN_DLQ' });
    expect(row.reason).toBe('MESSAGE_ID_PAYLOAD_MISMATCH');
    const fresh = wagerMessage(bet);
    await sendMessage(fixture, fresh);
    expect((await waitInbox(fresh.messageId)).outcome).toBe('REPLAY');
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect((await inboxRows(fixture.database, original.messageId))[0]?.outcome).toBe('PROCESSED');
  });
});

describe('[IT-21] negócio × permanente pela fila', () => {
  test('[IT-21] REJECTED de negócio: commit (tx + inbox + outbox) e ack; nada vai para a DLQ', async () => {
    const wallet = await openWallet(consumer.baseUrl, '5.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    const dlqBefore = await copiesIn(fixture.sqs, fixture.dlq.url);
    await sendMessage(fixture, message);
    expect((await waitInbox(message.messageId)).outcome).toBe('REJECTED');
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toEqual({
      transactions: 1,
      entries: 0,
      statuses: ['REJECTED'],
    });
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    expect(await copiesIn(fixture.sqs, fixture.dlq.url)).toBe(dlqBefore);
  });

  test('[IT-21] JSON inválido, OPENING e wallet inexistente → IN_DLQ, 1 cópia cada com atributos, origem vazia, sem inbox nem negócio', async () => {
    const wallet = await openWallet(consumer.baseUrl, '100.00');
    const malformedSqsId = await sendMessage(fixture, '{"messageId": nao-json', { groupId: 'it21-malformed' });
    const opening = wagerMessage(submission(wallet, { kind: 'OPENING', amount: '10.00' }));
    const missingWallet = wagerMessage(
      submission({ walletId: Bun.randomUUIDv7(), playerId: wallet.playerId }, { amount: '10.00' }),
    );
    await sendMessage(fixture, opening);
    await sendMessage(fixture, missingWallet);
    const rows = [
      await waitDeadLetter(fixture.database, `sqs:${malformedSqsId}`, { state: 'IN_DLQ' }),
      await waitDeadLetter(fixture.database, opening.messageId, { state: 'IN_DLQ' }),
      await waitDeadLetter(fixture.database, missingWallet.messageId, { state: 'IN_DLQ' }),
    ];
    expect(rows.map((row) => [row.reason, row.attempt])).toEqual([
      ['MALFORMED_JSON', 1],
      ['KIND_NOT_ALLOWED', 1],
      ['WALLET_NOT_FOUND', 1],
    ]);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    const copies = await peekMessages(fixture.sqs, fixture.dlq.url, 20);
    const ours = copies.filter((copy) => {
      const attributes = copy.MessageAttributes ?? {};
      const source = attributes['sourceMessageId']?.StringValue;
      return (
        source === malformedSqsId ||
        [opening.messageId, missingWallet.messageId].some((id) => (copy.Body ?? '').includes(id))
      );
    });
    writeEvidence('IT-21', {
      reasons: ours.map((copy) => copy.MessageAttributes?.['dlqReason']?.StringValue),
      attempts: ours.map((copy) => copy.MessageAttributes?.['dlAttempt']?.StringValue),
    });
    expect(ours).toHaveLength(3);
    for (const copy of ours) {
      expect(copy.MessageAttributes?.['dlAttempt']?.StringValue).toBe('1');
      expect(copy.MessageAttributes?.['consumerName']?.StringValue).toBe(CONSUMER_NAME);
    }
    for (const id of [opening.messageId, missingWallet.messageId])
      expect(await inboxRows(fixture.database, id)).toEqual([]);
    expect(
      await withClient(ownerUrl(fixture.database), async (client) => {
        const result = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = $1::uuid AND kind <> 'OPENING'`,
          [wallet.walletId],
        );
        return result.rows[0]?.n;
      }),
    ).toBe('0');
  });
});

describe('[IT-23] reentrega por expiração do VT', () => {
  test('[IT-23] mensagem segurada antes do processamento: o VT vence, outra instância a recebe (ReceiveCount ≥ 2) e processa uma vez', async () => {
    signal(consumer, 'SIGTERM');
    await consumer.exited;
    const wallet = await openWallet(await apiOnly(), '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    const holder = startInstance({
      id: 'msgc-holder',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        ...faultPlan('consumer.afterReceive', 'pause', { messageId: message.messageId }),
      }),
    });
    await waitReady(holder);
    await sendMessage(fixture, message);
    await holder.logs.waitFor('fault.injected', 15_000);
    const successor = startInstance({ id: 'msgc-successor', env: consumerEnv(fixture) });
    await waitReady(successor);
    await waitInbox(message.messageId);
    const received = successor.logs.entries.find(
      (entry) => entry.event === 'consumer.received' && entry['messageId'] === message.messageId,
    );
    expect(Number(received?.['receiveCount'])).toBeGreaterThanOrEqual(2);
    signal(holder, 'SIGUSR2');
    await holder.logs.waitFor('consumer.duplicate', 15_000);
    writeEvidence('IT-23', { receiveCount: received?.['receiveCount'] ?? null });
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect(await inboxRows(fixture.database, message.messageId)).toHaveLength(1);
    for (const instance of [holder, successor]) signal(instance, 'SIGTERM');
    await Promise.all([holder.exited, successor.exited]);
  });
});

describe('[IT-07d] atomicidade no caminho SQS', () => {
  test('[IT-07d] queda antes do commit: nenhuma linha (inbox, tx, lançamento); a reentrega processa uma vez', async () => {
    const wallet = await openWallet(await apiOnly(), '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    const message = wagerMessage(bet);
    const victim = startInstance({
      id: 'msgc-victim',
      env: consumerEnv(fixture, faultPlan('uow.beforeCommit', 'kill', { messageId: message.messageId })),
    });
    await waitReady(victim);
    await sendMessage(fixture, message);
    const exit = await victim.exited;
    expect(exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' });
    expect(victim.killLog).toEqual([]);
    expect(victim.logs.find('fault.injected')).toMatchObject({
      point: 'uow.beforeCommit',
      messageId: message.messageId,
    });
    expect(await inboxRows(fixture.database, message.messageId)).toEqual([]);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toEqual({
      transactions: 0,
      entries: 0,
      statuses: [],
    });
    const successor = startInstance({ id: 'msgc-after-kill', env: consumerEnv(fixture) });
    await waitReady(successor);
    expect((await waitInbox(message.messageId)).outcome).toBe('PROCESSED');
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
    signal(successor, 'SIGTERM');
    await successor.exited;
  });
});

let apiInstance: Instance | undefined;
async function apiOnly(): Promise<string> {
  if (apiInstance === undefined) {
    apiInstance = startInstance({ id: 'msgc-api', env: fixture.env() });
    await waitReady(apiInstance);
  }
  return apiInstance.baseUrl;
}
