import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
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
import { queueCounts } from '../support/sqs.ts';
import { invariantIssues, openWallet, submission, type TestWallet } from '../support/wagering.ts';

/**
 * Quedas no protocolo de dead-letter e no redrive (D35, D36, D47). Em todos os casos: nenhuma
 * linha de negócio a mais e efeito financeiro no máximo uma vez. Cada queda é comprovada pelo
 * marcador `fault.injected`, por SIGKILL autoinfligido (nenhum kill do harness) e pelo estado do
 * PostgreSQL e do SQS lido antes do sucessor.
 */
let fixture: Fixture;
let api: Instance;

const WITH_PROVIDER_C = { PROVIDER_IDS: 'provider-a,provider-b,provider-c' };

beforeAll(async () => {
  fixture = await createFixture('dlcrash');
  api = startInstance({ id: 'dlcrash-api', env: fixture.env() });
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

function selfKillEvidence(
  instance: Instance,
  exit: { exitCode: number | null; signalCode: string | null },
  point: string,
) {
  expect(exit).toEqual({ exitCode: null, signalCode: 'SIGKILL' });
  expect(instance.killLog).toEqual([]);
  expect(instance.logs.find('fault.injected')).toMatchObject({ point });
}

const invalidMessage = (wallet: TestWallet) => wagerMessage(submission(wallet, { kind: 'OPENING', amount: '10.00' }));
const providerCMessage = (wallet: TestWallet) =>
  wagerMessage(submission(wallet, { amount: '10.00', providerId: 'provider-c' }));

async function dlqCopiesOf(message: WagerMessage): Promise<number> {
  const copies = await peekMessages(fixture.sqs, fixture.dlq.url, 50, 4000);
  return copies.filter((copy) => (copy.Body ?? '').includes(message.messageId)).length;
}

describe('[IT-21d] redrive com queda em cada etapa e nova execução', () => {
  const steps = [
    'redrive.afterPendingBeforeSend',
    'redrive.afterSendBeforeMark',
    'redrive.afterMarkBeforeDelete',
  ] as const;

  test('[IT-21d] (a) (b) (c): mensagem válida com no máximo 1 efeito; DLQ vazia no fim; REDRIVEN', async () => {
    // Roda antes dos outros casos do arquivo: a DLQ desta fixture começa vazia em cada etapa.
    const evidence: Record<string, unknown>[] = [];
    for (const step of steps) {
      const wallet = await openWallet(api.baseUrl, '100.00');
      const message = providerCMessage(wallet);
      const rejecting = startInstance({ id: `dlcrash-d-${step}-r`, env: consumerEnv(fixture) });
      await waitReady(rejecting);
      await sendMessage(fixture, message);
      await waitDeadLetter(fixture.database, message.messageId, { state: 'IN_DLQ' });
      await stop(rejecting);
      const accepting = startInstance({ id: `dlcrash-d-${step}-a`, env: consumerEnv(fixture, WITH_PROVIDER_C) });
      await waitReady(accepting);

      const killed = await runRedrive(fixture, faultPlan(step, 'kill', { messageId: message.messageId }));
      expect({ step, signal: killed.signalCode }).toEqual({ step, signal: 'SIGKILL' });
      const stateAfterKill = (await deadLetterRows(fixture.database, message.messageId))[0]?.state;
      // A cópia volta a ficar visível na DLQ depois do VT do redrive (2 s); a nova execução retoma.
      const rerun = await runRedrive(fixture, {}, 5);
      expect(rerun.exitCode).toBe(0);
      await eventually(async () => (await inboxRows(fixture.database, message.messageId))[0], {
        timeoutMs: 15_000,
        describe: `${step}: mensagem processada`,
      });
      await waitCopies(fixture.sqs, fixture.inbound.url, 0);
      await waitCopies(fixture.sqs, fixture.dlq.url, 0);
      const effects = await effectsOfExternal(
        fixture.database,
        String(message.data['externalTransactionId']),
        'provider-c',
      );
      const row = (await deadLetterRows(fixture.database, message.messageId))[0];
      evidence.push({ step, stateAfterKill, effects, finalState: row?.state, report: rerun.logs.find('redrive.done') });
      expect({ step, effects }).toEqual({ step, effects: { transactions: 1, entries: 1, statuses: ['PROCESSED'] } });
      expect({ step, state: row?.state }).toEqual({ step, state: 'REDRIVEN' });
      await stop(accepting);
    }
    writeEvidence('IT-21d', { steps: evidence });
    expect(evidence.map((item) => item['stateAfterKill'])).toEqual(['REDRIVE_PENDING', 'REDRIVE_PENDING', 'REDRIVEN']);
  });
});

describe('[IT-21b] queda depois do envio à DLQ e antes do delete', () => {
  test('[IT-21b] o sucessor retoma (dlq.resume): 1 cópia na DLQ, origem vazia, IN_DLQ, efeito zero', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const message = invalidMessage(wallet);
    const victim = startInstance({
      id: 'dlcrash-b1',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        ...faultPlan('consumer.afterDlqSendBeforeDelete', 'kill', { messageId: message.messageId }),
      }),
    });
    await waitReady(victim);
    await sendMessage(fixture, message);
    selfKillEvidence(victim, await victim.exited, 'consumer.afterDlqSendBeforeDelete');
    const atKill = {
      row: (await deadLetterRows(fixture.database, message.messageId))[0],
      source: await queueCounts(fixture.sqs, fixture.inbound.url),
      dlqCopies: await copiesIn(fixture.sqs, fixture.dlq.url),
    };
    expect(atKill.row).toMatchObject({ state: 'PENDING_DLQ', attempt: 1 });
    expect(atKill.source.visible + atKill.source.notVisible).toBe(1);
    expect(atKill.dlqCopies).toBe(1);

    const successor = startInstance({ id: 'dlcrash-b2', env: consumerEnv(fixture) });
    await waitReady(successor);
    await waitDeadLetter(fixture.database, message.messageId, { state: 'IN_DLQ', attempt: 1 });
    const resume = await successor.logs.waitFor('dlq.resume', 10_000);
    expect(Number(resume['receiveCount'])).toBeGreaterThanOrEqual(2);
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    const finalCopies = await dlqCopiesOf(message);
    writeEvidence('IT-21b', { atKill, resume: { receiveCount: resume['receiveCount'] }, finalCopies });
    // ≥ 1 em geral; 1 aqui porque o reenvio cai na janela de deduplicação de 5 min.
    expect(finalCopies).toBe(1);
    expect(await effectsOfExternal(fixture.database, String(message.data['externalTransactionId']))).toMatchObject({
      transactions: 0,
    });
    expect(await inboxRows(fixture.database, message.messageId)).toEqual([]);
    await stop(successor);
  });
});

describe('[IT-21c] queda depois do commit do descarte e antes do envio', () => {
  test('[IT-21c] PENDING_DLQ sem cópia; o sucessor envia uma vez e conclui', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const message = invalidMessage(wallet);
    const victim = startInstance({
      id: 'dlcrash-c1',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        ...faultPlan('consumer.afterDeadLetterCommitBeforeSend', 'kill', { messageId: message.messageId }),
      }),
    });
    await waitReady(victim);
    await sendMessage(fixture, message);
    selfKillEvidence(victim, await victim.exited, 'consumer.afterDeadLetterCommitBeforeSend');
    expect((await deadLetterRows(fixture.database, message.messageId))[0]).toMatchObject({ state: 'PENDING_DLQ' });
    const copiesAtKill = await dlqCopiesOf(message);
    expect(copiesAtKill).toBe(0);

    const successor = startInstance({ id: 'dlcrash-c2', env: consumerEnv(fixture) });
    await waitReady(successor);
    await waitDeadLetter(fixture.database, message.messageId, { state: 'IN_DLQ', attempt: 1 });
    await waitCopies(fixture.sqs, fixture.inbound.url, 0);
    const finalCopies = await dlqCopiesOf(message);
    writeEvidence('IT-21c', { copiesAtKill, finalCopies });
    expect(finalCopies).toBe(1);
    await stop(successor);
  });
});

describe('[IT-21j] envio manual à DLQ falha e o broker move a mensagem com PENDING_DLQ existente', () => {
  test('[IT-21j] continua recuperável pelo redrive; válida → 1 efeito; inválida → nova falha (tentativa 2) já com envio', async () => {
    const wallet = await openWallet(api.baseUrl, '100.00');
    const valid = providerCMessage(wallet);
    const invalid = invalidMessage(wallet);
    const failing = startInstance({
      id: 'dlcrash-j1',
      env: consumerEnv(fixture, {
        CONSUMER_POLLERS: '1',
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([
          { point: 'consumer.dlqSendFails', action: 'fail', match: { messageId: valid.messageId } },
          { point: 'consumer.dlqSendFails', action: 'fail', match: { messageId: invalid.messageId } },
        ]),
      }),
    });
    await waitReady(failing);
    const baseline = await copiesIn(fixture.sqs, fixture.dlq.url);
    await sendMessage(fixture, valid, { groupId: 'j-valid' });
    await sendMessage(fixture, invalid, { groupId: 'j-invalid' });
    // Cada entrega retoma PENDING_DLQ e falha no envio; esgotado o maxReceiveCount (5), o broker move.
    await eventually(async () => ((await copiesIn(fixture.sqs, fixture.dlq.url)) >= baseline + 2 ? true : undefined), {
      timeoutMs: 60_000,
      describe: 'as duas mensagens movidas pela RedrivePolicy',
      diagnose: () => failing.logs.events().slice(-10),
    });
    const rowsAtMove = await deadLetterRows(fixture.database);
    const stuck = failing.logs.entries.filter((entry) => entry.event === 'dead_letter_pending_stuck');
    await stop(failing);
    expect(rowsAtMove.filter((row) => [valid.messageId, invalid.messageId].includes(row.dlKey))).toMatchObject([
      { state: 'PENDING_DLQ', attempt: 1 },
      { state: 'PENDING_DLQ', attempt: 1 },
    ]);
    expect(stuck.length).toBeGreaterThanOrEqual(1);
    const moved = (await peekMessages(fixture.sqs, fixture.dlq.url, baseline + 2)).filter((copy) =>
      [valid.messageId, invalid.messageId].some((id) => (copy.Body ?? '').includes(id)),
    );
    expect(moved.map((copy) => copy.MessageAttributes?.['dlAttempt']?.StringValue)).toEqual([undefined, undefined]);

    const accepting = startInstance({ id: 'dlcrash-j2', env: consumerEnv(fixture, WITH_PROVIDER_C) });
    await waitReady(accepting);
    expect((await runRedrive(fixture)).exitCode).toBe(0);
    await eventually(async () => (await inboxRows(fixture.database, valid.messageId))[0], {
      timeoutMs: 15_000,
      describe: 'válida processada depois do redrive',
    });
    await waitDeadLetter(fixture.database, invalid.messageId, { state: 'IN_DLQ', attempt: 2 });
    // Cópia repetida da válida (sem dlAttempt, como o broker) + novo redrive: duplicata na inbox.
    await sendMessage(fixture, valid, {
      queueUrl: fixture.dlq.url,
      groupId: 'j-valid',
      attributes: { consumerName: { DataType: 'String', StringValue: CONSUMER_NAME } },
    });
    expect((await runRedrive(fixture)).exitCode).toBe(0);
    await eventually(
      () =>
        accepting.logs.entries.some(
          (entry) => entry.event === 'consumer.duplicate' && entry['messageId'] === valid.messageId,
        )
          ? true
          : undefined,
      { timeoutMs: 15_000, describe: 'cópia repetida tratada como duplicata' },
    );
    const effects = await effectsOfExternal(
      fixture.database,
      String(valid.data['externalTransactionId']),
      'provider-c',
    );
    writeEvidence('IT-21j', {
      rowsAtMove,
      stuckAlerts: stuck.length,
      effects,
      rows: await deadLetterRows(fixture.database),
    });
    expect(effects).toEqual({ transactions: 1, entries: 1, statuses: ['PROCESSED'] });
    expect(await effectsOfExternal(fixture.database, String(invalid.data['externalTransactionId']))).toMatchObject({
      transactions: 0,
    });
    await stop(accepting);
  });
});
