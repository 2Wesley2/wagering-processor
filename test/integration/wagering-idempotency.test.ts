import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field, stringField } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';
import {
  invariantIssues,
  openWallet,
  send,
  submission,
  submit,
  type TestWallet,
  walletState,
  withoutReplayFlag,
} from '../support/wagering.ts';

/**
 * IT-10a: idempotência pela API, casos (a), (c), (d) e (e) do plano, mais o replay congelado de
 * uma 1ª resposta 202 ainda pendente (I1 = opção A). O caso (b) — replay depois de a pendência ser
 * resolvida pelo worker — é o IT-10b da F4. Valores fixos (D58).
 */
let fixture: Fixture;
let first: Instance;
let second: Instance;

beforeAll(async () => {
  fixture = await createFixture('it10a');
  first = startInstance({ id: 'it10a-1', env: fixture.env() });
  second = startInstance({ id: 'it10a-2', env: fixture.env() });
  await Promise.all([waitReady(first), waitReady(second)]);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function transactionsWithKey(key: string): Promise<string> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM wager_transactions WHERE idempotency_key = $1',
      [key],
    );
    return result.rows[0]?.n ?? '?';
  });
}

const PROBLEM_FIELDS = ['code', 'correlationId', 'detail', 'retryable', 'status', 'title', 'type'];

describe('[IT-10a] idempotência persistente (I2 global, I1 resposta original)', () => {
  let wallet: TestWallet;
  let bet: ReturnType<typeof submission>;
  let originalBody: unknown;

  beforeAll(async () => {
    wallet = await openWallet(first.baseUrl, '1000.00');
    bet = submission(wallet, { amount: '25.00' });
  });

  test('[IT-10a] (a) BET 25.00 → 975.00; WIN 10.00 → 985.00; replay da BET → mesmo código e corpo (975.00), só idempotentReplay muda', async () => {
    const original = await send(first.baseUrl, bet);
    originalBody = original.body;
    expect([original.status, field(original.body, 'balance'), field(original.body, 'idempotentReplay')]).toEqual([
      200,
      { amount: '975.00', currency: 'BRL' },
      false,
    ]);
    const win = await send(second.baseUrl, submission(wallet, { kind: 'WIN', amount: '10.00' }));
    expect(field(win.body, 'balance')).toEqual({ amount: '985.00', currency: 'BRL' });
    for (const instance of [first, second]) {
      const replay = await send(instance.baseUrl, bet);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...withObject(originalBody), idempotentReplay: true });
    }
    // UUIDs em maiúsculas: mesmo hash canônico (D28) → replay, não conflito.
    const upperCase = await submit(
      first.baseUrl,
      { ...bet, walletId: bet.walletId.toUpperCase(), playerId: bet.playerId.toUpperCase() },
      `${bet.providerId}:${bet.externalTransactionId}`,
    );
    expect([upperCase.status, field(upperCase.body, 'idempotentReplay')]).toEqual([200, true]);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '985.00', debits: '1' });
  });

  test('[IT-10a] (c) key global: provider-b reutiliza a key de provider-a com outro payload → 409 sem dados da transação existente', async () => {
    const key = 'shared-key-it10a-c';
    const fromA = submission(wallet, { amount: '5.00' });
    expect((await submit(first.baseUrl, fromA, key)).status).toBe(200);
    const fromB = submission(wallet, { providerId: 'provider-b', amount: '5.00' });
    const conflict = await submit(second.baseUrl, fromB, key);
    expect([conflict.status, field(conflict.body, 'code')]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(Object.keys(withObject(conflict.body)).sort((left, right) => left.localeCompare(right))).toEqual(
      PROBLEM_FIELDS,
    );
    // Mesmo provedor, outro valor: também conflito (não replay).
    const otherAmount = await submit(first.baseUrl, { ...fromA, money: { amount: '6.00', currency: 'BRL' } }, key);
    expect([otherAmount.status, field(otherAmount.body, 'code')]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await transactionsWithKey(key)).toBe('1');
  });

  test('[IT-10a] (d) key nova com externalTransactionId já usado → 409 EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const response = await submit(first.baseUrl, bet, 'nova-key-it10a-d');
    expect([response.status, field(response.body, 'code')]).toEqual([409, 'EXTERNAL_TRANSACTION_ID_CONFLICT']);
    expect(await transactionsWithKey('nova-key-it10a-d')).toBe('0');
  });

  test('[IT-10a] replay de uma 1ª resposta 202 (pendente, sem worker na F3) → 202 com o corpo original', async () => {
    const refund = submission(wallet, {
      kind: 'REFUND',
      amount: '7.00',
      referenceExternalTransactionId: 'ainda-ausente',
    });
    const pending = await send(first.baseUrl, refund);
    expect([pending.status, field(pending.body, 'status'), field(pending.body, 'balance')]).toEqual([
      202,
      'PENDING_REFERENCE',
      { amount: '980.00', currency: 'BRL' },
    ]);
    await send(second.baseUrl, submission(wallet, { amount: '30.00' }));
    const replay = await send(second.baseUrl, refund);
    expect([replay.status, withoutReplayFlag(replay.body), field(replay.body, 'idempotentReplay')]).toEqual([
      202,
      withoutReplayFlag(pending.body),
      true,
    ]);
  });

  test('[IT-10a] (e) replay idêntico depois de recriar a app (nada em memória)', async () => {
    signal(first, 'SIGTERM');
    await first.exited;
    const recreated = startInstance({ id: 'it10a-3', env: fixture.env() });
    await waitReady(recreated);
    const replay = await send(recreated.baseUrl, bet);
    expect([replay.status, replay.body]).toEqual([200, { ...withObject(originalBody), idempotentReplay: true }]);
    expect(stringField(replay.body, 'transactionId')).toBe(stringField(originalBody, 'transactionId'));
  });
});

function withObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) throw new Error('corpo não é objeto');
  return Object.fromEntries(Object.entries(body));
}
