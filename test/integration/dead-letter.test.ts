import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { envelopeMessageIdOf } from '../../src/modules/messaging/infrastructure/message-identity.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import {
  CONSUMER_NAME,
  consumerEnv,
  copiesIn,
  deadLetterRows,
  effectsOfExternal,
  faultPlan,
  inboxRows,
  peekMessages,
  runRedrive,
  sendMessage,
  waitCopies,
  waitDeadLetter,
  wagerMessage,
  type WagerMessage,
} from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { invariantIssues, openWallet, submission, type TestWallet, walletState } from '../support/wagering.ts';

/**
 * Dead-letter e redrive (D35, D36) contra o MiniStack real. A identidade de um descarte é
 * (consumidor, dl_key, body_hash): mensagens com o mesmo messageId e corpos diferentes nunca se
 * confundem. Cópias repetidas na DLQ ou na origem nunca geram efeito financeiro duplicado: as
 * asserções olham as linhas do banco, não a contagem de cópias.
 */
let fixture: Fixture;
let api: Instance;
let consumer: Instance | undefined;

const WITH_PROVIDER_C = { PROVIDER_IDS: 'provider-a,provider-b,provider-c' };

beforeAll(async () => {
  fixture = await createFixture('dlq');
  api = startInstance({ id: 'dlq-api', env: fixture.env() });
  await waitReady(api);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function startConsumer(id: string, extra: Record<string, string> = {}): Promise<Instance> {
  await stopConsumer();
  const instance = startInstance({ id, env: consumerEnv(fixture, extra) });
  await waitReady(instance);
  consumer = instance;
  return instance;
}

async function stopConsumer(): Promise<void> {
  if (consumer === undefined) return;
  signal(consumer, 'SIGTERM');
  await consumer.exited;
  consumer = undefined;
}

async function redrive(): Promise<void> {
  const run = await runRedrive(fixture);
  expect({ exitCode: run.exitCode, stderr: run.stderr.slice(0, 300) }).toEqual({ exitCode: 0, stderr: '' });
}

const validBet = (wallet: TestWallet, overrides: Record<string, string> = {}) =>
  submission(wallet, { amount: '10.00', ...overrides });

/** Mensagem válida para a app, mas descartada enquanto o provedor não está no registro. */
const providerCBet = (wallet: TestWallet) => validBet(wallet, { providerId: 'provider-c' });

const waitProcessed = (messageId: string, timeoutMs = 20_000) =>
  eventually(async () => (await inboxRows(fixture.database, messageId))[0], {
    timeoutMs,
    describe: `inbox de ${messageId}`,
  });

/** Totais do banco (todas as wallets): descartes, lançamentos e transações. */
async function totals(): Promise<{ deadLetters: number; ledgerEntries: number; transactions: number }> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ dead_letters: string; ledger: string; transactions: string }>(
      `SELECT (SELECT count(*) FROM dead_letter_messages)::text AS dead_letters,
              (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger,
              (SELECT count(*) FROM wager_transactions)::text AS transactions`,
    );
    const row = result.rows[0];
    return {
      deadLetters: Number(row?.dead_letters),
      ledgerEntries: Number(row?.ledger),
      transactions: Number(row?.transactions),
    };
  });
}

/** MessageDeduplicationIds que o consumidor usou ao enviar cópias deste messageId à DLQ (log `dlq.sent`). */
function sentToDlq(
  instance: Instance | undefined,
  messageId: string,
): { attempt: unknown; deduplicationId: unknown }[] {
  return (instance?.logs.entries ?? [])
    .filter((entry) => entry.event === 'dlq.sent' && entry['messageId'] === messageId)
    .map((entry) => ({ attempt: entry['attempt'], deduplicationId: entry['deduplicationId'] }));
}

/** O MiniStack não devolve o atributo MessageDeduplicationId no Receive: o id enviado vem do log. */
const DLQ_DEDUP_ID = /^dlq:[0-9a-f]{40}:a[1-9]\d*$/;

describe('[IT-21e] mensagem movida pela RedrivePolicy, sem registro prévio', () => {
  test('[IT-21e] o broker move após maxReceiveCount; o redrive cria REDRIVE_PENDING → REDRIVEN e o processamento é único', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const bet = validBet(wallet);
    const message = wagerMessage(bet);
    await sendMessage(fixture, message);
    // Sem consumidor da app: o teste recebe sem apagar até o broker mover (maxReceiveCount 5).
    await eventually(
      async () => {
        await fixture.sqs.send(
          new ReceiveMessageCommand({ QueueUrl: fixture.inbound.url, WaitTimeSeconds: 1, VisibilityTimeout: 1 }),
        );
        return (await copiesIn(fixture.sqs, fixture.dlq.url)) === 1 ? true : undefined;
      },
      { timeoutMs: 30_000, intervalMs: 1100, describe: 'mensagem movida para a DLQ pelo broker' },
    );
    expect(await deadLetterRows(fixture.database, message.messageId)).toEqual([]);
    await startConsumer('dlq-c1');
    await redrive();
    expect((await waitProcessed(message.messageId)).outcome).toBe('PROCESSED');
    expect(await deadLetterRows(fixture.database, message.messageId)).toEqual([
      { dlKey: message.messageId, state: 'REDRIVEN', attempt: 1, redriveCount: 1, reason: 'BROKER_MAX_RECEIVE' },
    ]);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    await waitCopies(fixture.sqs, fixture.dlq.url, 0);
  });
});

describe('[IT-21f] mesmo messageId com payloads diferentes', () => {
  let m1: WagerMessage;
  let m2: WagerMessage;
  let m3: WagerMessage;
  let m4: WagerMessage;
  let wallet: TestWallet;

  test('[IT-21f] (i) M1 inválida e M2 válida com o mesmo id: registros distintos; reentregas retomam ou viram duplicata', async () => {
    wallet = await openWallet(api.baseUrl, '100.00');
    const messageId = `x-${Bun.randomUUIDv7()}`;
    m1 = wagerMessage(validBet(wallet, { amount: '25' }), { messageId });
    m2 = wagerMessage(validBet(wallet), { messageId });
    await sendMessage(fixture, m1);
    expect(await waitDeadLetter(fixture.database, messageId, { state: 'IN_DLQ' })).toMatchObject({
      reason: 'INVALID_AMOUNT',
      attempt: 1,
    });
    await sendMessage(fixture, m2);
    expect((await waitProcessed(messageId)).outcome).toBe('PROCESSED');
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
    // Reentregas: M1 retoma o descarte (só apaga); M2 é duplicata pela inbox.
    await sendMessage(fixture, m1);
    await sendMessage(fixture, m2);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    expect(await deadLetterRows(fixture.database, messageId)).toMatchObject([{ state: 'IN_DLQ', attempt: 1 }]);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
    expect(await inboxRows(fixture.database, messageId)).toHaveLength(1);
  });

  test('[IT-21f] (ii) M3 válida processada; M4 com o mesmo id → MESSAGE_ID_PAYLOAD_MISMATCH; M3 intacta', async () => {
    const messageId = `y-${Bun.randomUUIDv7()}`;
    m3 = wagerMessage(validBet(wallet, { amount: '5.00' }), { messageId });
    m4 = wagerMessage(validBet(wallet, { amount: '7.00' }), { messageId });
    await sendMessage(fixture, m3);
    await waitProcessed(messageId);
    await sendMessage(fixture, m4);
    expect(await waitDeadLetter(fixture.database, messageId, { state: 'IN_DLQ' })).toMatchObject({
      reason: 'MESSAGE_ID_PAYLOAD_MISMATCH',
    });
    await sendMessage(fixture, m4);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    expect(await deadLetterRows(fixture.database, messageId)).toMatchObject([{ state: 'IN_DLQ', attempt: 1 }]);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('85.00');
  });

  test('[IT-21f] (iii) redrive de M1 e M4: nova falha (tentativa 2) e nenhum efeito', async () => {
    await redrive();
    await waitDeadLetter(fixture.database, m1.messageId, { state: 'IN_DLQ', attempt: 2 });
    await waitDeadLetter(fixture.database, m4.messageId, { state: 'IN_DLQ', attempt: 2 });
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('85.00');
    expect(await inboxRows(fixture.database, m2.messageId)).toHaveLength(1);
    expect(await inboxRows(fixture.database, m3.messageId)).toHaveLength(1);
  });
});

describe('[IT-21g] nova falha depois do redrive', () => {
  test('[IT-21g] IN_DLQ (1) → redrive → REDRIVEN → falha → IN_DLQ (2) com cópia nova; a reentrega não incrementa de novo', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const invalid = wagerMessage(submission(wallet, { kind: 'OPENING', amount: '10.00' }));
    await sendMessage(fixture, invalid);
    await waitDeadLetter(fixture.database, invalid.messageId, { state: 'IN_DLQ', attempt: 1 });
    await redrive();
    const row = await waitDeadLetter(fixture.database, invalid.messageId, { state: 'IN_DLQ', attempt: 2 });
    expect(row).toMatchObject({ redriveCount: 1, reason: 'KIND_NOT_ALLOWED' });
    const sent = sentToDlq(consumer, invalid.messageId);
    // Reentrega da falha 2: retoma (só apaga), sem tentativa 3.
    await sendMessage(fixture, invalid);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    expect(await deadLetterRows(fixture.database, invalid.messageId)).toMatchObject([{ state: 'IN_DLQ', attempt: 2 }]);
    expect(await effectsOfExternal(fixture.database, String(invalid.data['externalTransactionId']))).toMatchObject({
      transactions: 0,
    });
    writeEvidence('IT-21g', { sent });
    // Uma cópia por tentativa, cada uma com DedupId próprio (tentativa nova → id novo).
    expect(sent.map((item) => item.attempt)).toEqual([1, 2]);
    for (const item of sent) expect(String(item.deduplicationId)).toMatch(DLQ_DEDUP_ID);
    expect(sent[0]?.deduplicationId).not.toBe(sent[1]?.deduplicationId);
  });

  test('[IT-21g] JSON malformado volta à DLQ enquanto o redrive roda: o comando termina, reenvia uma vez e deixa a tentativa 2 do mesmo registro', async () => {
    // Corpo ilegível (UUID sem aspas) e sem messageId: a identidade é `sqs:<MessageId da origem>`.
    const body = `{"malformado": ${Bun.randomUUIDv7()}`;
    const totalsBefore = await totals();
    // Dois envios independentes do mesmo corpo: dois descartes distintos.
    const first = await sendMessage(fixture, body, { groupId: 'it21g-malformed' });
    const independent = await sendMessage(fixture, body, { groupId: 'it21g-malformed' });
    const keys = [`sqs:${first}`, `sqs:${independent}`];
    for (const key of keys) await waitDeadLetter(fixture.database, key, { state: 'IN_DLQ', attempt: 1 });

    // O consumidor segue ativo: a mensagem reenviada falha de novo e volta à DLQ durante o redrive.
    const startedAt = performance.now();
    const run = await Promise.race([
      runRedrive(fixture, {}, 6),
      Bun.sleep(60_000).then(() => {
        throw new Error('sqs:redrive não terminou em 60 s');
      }),
    ]);
    const durationMs = Math.round(performance.now() - startedAt);
    expect(run.exitCode).toBe(0);
    const logsOf = (event: string, key: string) =>
      run.logs.entries.filter((entry) => entry.event === event && entry['dlKey'] === key);
    for (const key of keys) {
      await waitDeadLetter(fixture.database, key, { state: 'IN_DLQ', attempt: 2 });
      expect({ key, sent: logsOf('redrive.sent', key).length }).toEqual({ key, sent: 1 });
      expect(logsOf('redrive.deferred', key).length).toBeGreaterThanOrEqual(1);
    }
    const rows = (await deadLetterRows(fixture.database)).filter((row) => keys.includes(row.dlKey));
    const copies = (await peekMessages(fixture.sqs, fixture.dlq.url, 100, 5000)).filter((copy) =>
      keys.includes(copy.MessageAttributes?.['deadLetterKey']?.StringValue ?? ''),
    );
    const totalsAfter = await totals();
    writeEvidence('IT-21g-malformed', {
      keys,
      durationMs,
      report: run.logs.find('redrive.done'),
      rows,
      copies: copies.map((copy) => ({
        key: copy.MessageAttributes?.['deadLetterKey']?.StringValue,
        attempt: copy.MessageAttributes?.['dlAttempt']?.StringValue,
        bodyIntact: copy.Body === body,
      })),
      totalsBefore,
      totalsAfter,
    });
    // Mesmo registro, agora na tentativa 2; nenhum registro novo para a cópia reenviada.
    expect(rows.map(({ state, attempt, redriveCount, reason }) => ({ state, attempt, redriveCount, reason }))).toEqual([
      { state: 'IN_DLQ', attempt: 2, redriveCount: 1, reason: 'MALFORMED_JSON' },
      { state: 'IN_DLQ', attempt: 2, redriveCount: 1, reason: 'MALFORMED_JSON' },
    ]);
    expect(totalsAfter.deadLetters).toBe(totalsBefore.deadLetters + 2);
    // Uma cópia por descarte na DLQ, na tentativa 2, com o corpo intacto.
    expect(
      copies
        .map(
          (copy) =>
            `${copy.MessageAttributes?.['deadLetterKey']?.StringValue}:${copy.MessageAttributes?.['dlAttempt']?.StringValue}:${copy.Body === body}`,
        )
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(keys.map((key) => `${key}:2:true`).toSorted((left, right) => left.localeCompare(right)));
    // Nenhum lançamento no ledger nem linha de negócio.
    expect(totalsAfter.ledgerEntries).toBe(totalsBefore.ledgerEntries);
    expect(totalsAfter.transactions).toBe(totalsBefore.transactions);
  });
});

describe('[IT-21i] MessageDeduplicationId no SQS real', () => {
  const longId = (prefix: string) => `${prefix} pedido nº 7 — açaí 🍇 linha\n`.padEnd(200, 'z');

  test('[IT-21i] (a) messageId de 200 caracteres com símbolos: envio à DLQ e redrive funcionam; DedupId ≤ 128 e no formato', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const message = wagerMessage(submission(wallet, { kind: 'OPENING', amount: '10.00' }), { messageId: longId('a') });
    expect(message.messageId).toHaveLength(200);
    await sendMessage(fixture, message);
    await waitDeadLetter(fixture.database, message.messageId, { state: 'IN_DLQ', attempt: 1 });
    const sent = sentToDlq(consumer, message.messageId);
    writeEvidence('IT-21i-a', { sent });
    expect(sent).toHaveLength(1);
    const deduplicationId = String(sent[0]?.deduplicationId);
    expect(deduplicationId).toMatch(/^dlq:[0-9a-f]{40}:a1$/);
    expect(deduplicationId.length).toBeLessThanOrEqual(128);
    // A cópia foi aceita pelo SQS real e está na DLQ com os atributos do protocolo.
    const copies = await peekMessages(fixture.sqs, fixture.dlq.url, 50, 4000);
    // O corpo é JSON (a quebra de linha do messageId vem escapada): compara o messageId do envelope.
    expect(copies.some((copy) => envelopeMessageIdOf(copy.Body ?? '') === message.messageId)).toBe(true);
  });

  test('[IT-21i] (b) queda depois do reenvio do redrive: o retry da mesma tentativa reusa o id e a origem recebe 1 cópia', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const message = wagerMessage(providerCBet(wallet), { messageId: longId('b') });
    await startConsumer('dlq-c2');
    await sendMessage(fixture, message);
    await waitDeadLetter(fixture.database, message.messageId, { state: 'IN_DLQ' });
    await startConsumer('dlq-c3', WITH_PROVIDER_C);
    const killed = await runRedrive(
      fixture,
      faultPlan('redrive.afterSendBeforeMark', 'kill', { messageId: message.messageId }),
    );
    expect(killed.signalCode).toBe('SIGKILL');
    expect((await deadLetterRows(fixture.database, message.messageId))[0]?.state).toBe('REDRIVE_PENDING');
    // A cópia da DLQ volta a ficar visível (VT 2 s); a nova execução (5 rodadas ociosas) a retoma
    // e reenvia com o MESMO DedupId.
    const rerun = await runRedrive(fixture, {}, 5);
    expect(rerun.exitCode).toBe(0);
    const sending = (run: typeof rerun) =>
      run.logs.entries.filter((entry) => entry.event === 'redrive.sending' && entry['dlKey'] === message.messageId);
    const before = sending(killed).map((entry) => entry['deduplicationId']);
    const after = sending(rerun).map((entry) => entry['deduplicationId']);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
    expect(String(before[0])).toMatch(/^rd:[0-9a-f]{40}:a1:r1$/);
    await waitProcessed(message.messageId);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    const received = (consumer?.logs.entries ?? []).filter(
      (entry) => entry.event === 'consumer.received' && entry['messageId'] === message.messageId,
    );
    writeEvidence('IT-21i-b', { receivedAfterRedrive: received.length, deduplicationIds: { before, after } });
    expect(received).toHaveLength(1);
    expect(
      await effectsOfExternal(fixture.database, String(message.data['externalTransactionId']), 'provider-c'),
    ).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect((await deadLetterRows(fixture.database, message.messageId))[0]?.state).toBe('REDRIVEN');
  });
});

describe('[IT-21h] cópias repetidas sem deduplicação', () => {
  test('[IT-21h] 3 cópias de uma inválida e 3 de uma válida descartada antes: depois do redrive, 0 e exatamente 1 efeito', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const invalid = wagerMessage(submission(wallet, { kind: 'OPENING', amount: '10.00' }));
    const valid = wagerMessage(providerCBet(wallet));
    await startConsumer('dlq-c4');
    await sendMessage(fixture, invalid);
    await sendMessage(fixture, valid);
    await waitDeadLetter(fixture.database, invalid.messageId, { state: 'IN_DLQ' });
    await waitDeadLetter(fixture.database, valid.messageId, { state: 'IN_DLQ' });
    // Cópias extras direto na DLQ, com DedupIds distintos: duas da tentativa 1 e uma "movida pelo broker".
    for (const message of [invalid, valid]) {
      for (const attempt of ['1', '1', undefined]) {
        await sendMessage(fixture, message, {
          queueUrl: fixture.dlq.url,
          attributes: {
            consumerName: { DataType: 'String', StringValue: CONSUMER_NAME },
            ...(attempt === undefined ? {} : { dlAttempt: { DataType: 'Number', StringValue: attempt } }),
          },
        });
      }
    }
    await startConsumer('dlq-c5', WITH_PROVIDER_C);
    await redrive();
    await redrive();
    await waitProcessed(valid.messageId);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    const validEffects = await effectsOfExternal(
      fixture.database,
      String(valid.data['externalTransactionId']),
      'provider-c',
    );
    const invalidEffects = await effectsOfExternal(fixture.database, String(invalid.data['externalTransactionId']));
    writeEvidence('IT-21h', { validEffects, invalidEffects, rows: await deadLetterRows(fixture.database) });
    expect(validEffects).toEqual({ transactions: 1, entries: 1, statuses: ['PROCESSED'] });
    expect(invalidEffects.transactions).toBe(0);
    expect(await inboxRows(fixture.database, valid.messageId)).toHaveLength(1);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('90.00');
  });
});

describe('[IT-22] retry com backoff e DLQ pelo broker', () => {
  test('[IT-22] falha transitória em toda entrega: backoff, sem ack; após maxReceiveCount o broker move; o redrive processa uma vez', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const bet = validBet(wallet);
    const message = wagerMessage(bet);
    const failing = await startConsumer(
      'dlq-c6',
      faultPlan('uow.beforeCommit', 'fail', { messageId: message.messageId }),
    );
    const baseline = await copiesIn(fixture.sqs, fixture.dlq.url);
    await sendMessage(fixture, message);
    await eventually(async () => ((await copiesIn(fixture.sqs, fixture.dlq.url)) > baseline ? true : undefined), {
      timeoutMs: 40_000,
      describe: 'mensagem movida pela RedrivePolicy',
      diagnose: () => failing.logs.events().slice(-10),
    });
    const retries = failing.logs.entries.filter(
      (entry) => entry.event === 'consumer.retry_scheduled' && entry['messageId'] === message.messageId,
    );
    writeEvidence('IT-22', { retries: retries.map((entry) => [entry['receiveCount'], entry['delayS']]) });
    expect(retries.length).toBeGreaterThanOrEqual(4);
    expect(retries.every((entry) => entry['delayS'] === 1)).toBe(true);
    expect(await inboxRows(fixture.database, message.messageId)).toEqual([]);
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({ transactions: 0 });
    await startConsumer('dlq-c7');
    await redrive();
    expect((await waitProcessed(message.messageId)).outcome).toBe('PROCESSED');
    expect(await effectsOfExternal(fixture.database, bet.externalTransactionId)).toMatchObject({
      transactions: 1,
      entries: 1,
    });
    expect((await deadLetterRows(fixture.database, message.messageId))[0]).toMatchObject({
      state: 'REDRIVEN',
      reason: 'BROKER_MAX_RECEIVE',
    });
    await stopConsumer();
  });
});
