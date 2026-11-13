import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { consumerEnv, inboxRows, sendMessage, wagerMessage } from '../support/messaging.ts';
import { invariantIssues, openWallet, send, submission } from '../support/wagering.ts';

/**
 * IT-31: logs JSON com os ids de correlação e sem dado sensível (§12, D41), e /metrics com as
 * métricas mínimas (D42). Os valores sentinela (playerId e quantias incomuns) não podem aparecer em
 * nenhuma linha de log.
 */
let fixture: Fixture;
let instance: Instance;

const ALL_ROLES = 'api,consumer,outbox-publisher,pending-reference-worker,events-projection';
const SENTINEL_OPENING = '7654.32';
const SENTINEL_BET = '1234.56';

beforeAll(async () => {
  fixture = await createFixture('obs');
  instance = startInstance({ id: 'obs-1', env: consumerEnv(fixture, { APP_ROLES: ALL_ROLES }) });
  await waitReady(instance);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const REQUIRED_METRICS = [
  'wagering_transactions_total',
  'wagering_rejections_total',
  'wagering_processing_duration_seconds',
  'idempotency_duplicates_total',
  'db_lock_conflicts_total',
  'uow_retries_total',
  'sqs_messages_total',
  'sqs_redeliveries_total',
  'dlq_messages_total',
  'outbox_publish_lag_seconds',
  'outbox_pending_messages',
  'outbox_oldest_pending_age_seconds',
  'pending_reference_backlog',
  'pending_reference_resolutions_total',
  'wallet_reconciliation_divergence_total',
  'http_request_duration_seconds',
  'sqs_queue_messages',
];

describe('[IT-31] logs e métricas', () => {
  test('[IT-31] tráfego HTTP e SQS: logs JSON com ids de correlação, sem playerId nem valores; /metrics completo', async () => {
    const wallet = await openWallet(instance.baseUrl, SENTINEL_OPENING);
    const bet = submission(wallet, { amount: SENTINEL_BET });
    expect((await send(instance.baseUrl, bet)).status).toBe(200);
    expect((await send(instance.baseUrl, bet)).status).toBe(200); // replay
    expect((await send(instance.baseUrl, submission(wallet, { amount: '99999.00' }))).status).toBe(422);
    const message = wagerMessage(submission(wallet, { amount: '1.11' }));
    await sendMessage(fixture, message);
    await eventually(async () => (await inboxRows(fixture.database, message.messageId))[0], {
      timeoutMs: 15_000,
      describe: 'mensagem processada',
    });
    await api(instance.baseUrl, 'POST', `/wallets/${wallet.walletId}/reconciliation`);
    // Lag da outbox e projeção: espera o publicador e a projeção consumirem os eventos.
    await instance.logs.waitFor('projection.applied', 15_000);

    const metrics = await (await fetch(`${instance.baseUrl}/metrics`)).text();
    const missing = REQUIRED_METRICS.filter((name) => !metrics.includes(`# TYPE ${name} `));
    const lines = instance.logs.entries.map((entry) => JSON.stringify(entry));
    const leaks = lines.filter(
      (line) => line.includes(wallet.playerId) || line.includes(SENTINEL_OPENING) || line.includes(SENTINEL_BET),
    );
    const decided = instance.logs.entries.find((entry) => entry.event === 'transaction.decided');
    const processed = instance.logs.entries.find(
      (entry) => entry.event === 'consumer.processed' && entry['messageId'] === message.messageId,
    );
    writeEvidence('IT-31', {
      missing,
      nonJson: instance.logs.nonJson.length,
      leaks: leaks.length,
      decided,
      processed,
      samples: metrics
        .split('\n')
        .filter((line) =>
          /^(wagering_transactions_total|wagering_rejections_total|sqs_messages_total|outbox_pending_messages)\{/.test(
            line,
          ),
        ),
    });
    expect(missing).toEqual([]);
    expect(instance.logs.nonJson).toEqual([]);
    expect(leaks).toEqual([]);
    for (const entry of instance.logs.entries) {
      expect(typeof entry['instance']).toBe('string');
      expect(typeof entry['time']).toBe('string');
    }
    expect(decided).toMatchObject({ walletId: wallet.walletId, providerId: 'provider-a' });
    expect(typeof decided?.['correlationId']).toBe('string');
    expect(typeof decided?.['transactionId']).toBe('string');
    expect(processed).toMatchObject({
      messageId: message.messageId,
      correlationId: message.messageId,
      walletId: wallet.walletId,
    });
    expect(metrics).toMatch(/wagering_transactions_total\{[^}]*channel="sqs"[^}]*\} 1/);
    expect(metrics).toMatch(/wagering_rejections_total\{[^}]*failure_code="INSUFFICIENT_FUNDS"[^}]*\} 1/);
    expect(metrics).toMatch(/idempotency_duplicates_total\{[^}]*outcome="replay"[^}]*\} 1/);
    expect(metrics).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/wagering\/transactions"/);
    expect(metrics).toMatch(/outbox_publish_lag_seconds_count\{[^}]*\} [1-9]/);
    expect(metrics).toMatch(/sqs_queue_messages\{[^}]*state="visible"/);
    signal(instance, 'SIGTERM');
    await instance.exited;
  });
});
