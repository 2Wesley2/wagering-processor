import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field, stringField } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';
import {
  invariantIssues,
  openWallet,
  send,
  submission,
  submit,
  keyOf,
  type TestWallet,
  walletState,
  withoutReplayFlag,
} from '../support/wagering.ts';

/**
 * IT-11: desfechos da submissão pela API real — aplicada, LOSS, WIN referenciando BET, rejeições de
 * negócio persistidas com evento e replay, pendência (202) sem worker e mismatch sem persistir.
 * Valores esperados escritos à mão (D58).
 */
let fixture: Fixture;
let app: Instance;
const base = () => app.baseUrl;

beforeAll(async () => {
  fixture = await createFixture('it11');
  app = startInstance({ id: 'it11-1', env: fixture.env() });
  await waitReady(app);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function transactionRow(transactionId: string): Promise<Record<string, string | null>> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<Record<string, string | null>>(
      `SELECT status, initial_status, failure_code, accepted_balance::text AS accepted_balance,
              result_balance::text AS result_balance, reference_transaction_id::text AS reference_transaction_id,
              (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id)::text AS entries,
              ARRAY_TO_STRING(ARRAY(SELECT o.event_type FROM outbox_messages o
                                     WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text ORDER BY o.seq), ',') AS events
         FROM wager_transactions t WHERE t.id = $1::uuid`,
      [transactionId],
    );
    return result.rows[0] ?? {};
  });
}

async function countWhere(sql: string, parameters: unknown[]): Promise<string> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ n: string }>(sql, parameters);
    return result.rows[0]?.n ?? '?';
  });
}

describe('[IT-11] desfechos da submissão', () => {
  let wallet: TestWallet;
  let betExternalId: string;
  let betId: string;

  beforeAll(async () => {
    wallet = await openWallet(base(), '1000.00');
  });

  test('[IT-11] BET 25.00 sobre 1000.00 → 200 PROCESSED 975.00, 1 débito, Processed + BalanceChanged', async () => {
    const body = submission(wallet, { amount: '25.00' });
    betExternalId = body.externalTransactionId;
    const response = await send(base(), body);
    betId = stringField(response.body, 'transactionId');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      transactionId: betId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(response.headers.get('location')).toBe(`/wagering/transactions/${betId}`);
    expect(await transactionRow(betId)).toMatchObject({
      status: 'PROCESSED',
      initial_status: 'PROCESSED',
      failure_code: null,
      accepted_balance: '975.00',
      result_balance: '975.00',
      entries: '1',
      events: 'WagerTransactionProcessed,WalletBalanceChanged',
    });
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({
      balance: '975.00',
      version: '2',
      debits: '1',
    });
  });

  test('[IT-11] BET acima do saldo → 422 INSUFFICIENT_FUNDS persistido, sem lançamento, evento Rejected; replay idêntico', async () => {
    const body = submission(wallet, { amount: '2000.00' });
    const first = await send(base(), body);
    expect(first.status).toBe(422);
    expect(first.headers.get('content-type')).toContain('application/problem+json');
    const transactionId = stringField(field(first.body, 'transaction'), 'transactionId');
    expect(first.body).toEqual({
      type: 'urn:wagering:error:INSUFFICIENT_FUNDS',
      title: 'INSUFFICIENT_FUNDS',
      status: 422,
      code: 'INSUFFICIENT_FUNDS',
      detail: 'transação rejeitada por regra de negócio: INSUFFICIENT_FUNDS',
      retryable: false,
      correlationId: field(first.body, 'correlationId'),
      transaction: {
        transactionId,
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '975.00', currency: 'BRL' },
      },
      idempotentReplay: false,
    });
    expect(await transactionRow(transactionId)).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      accepted_balance: '975.00',
      entries: '0',
      events: 'WagerTransactionRejected',
    });
    const replay = await send(base(), body);
    expect(replay.status).toBe(422);
    expect(field(replay.body, 'idempotentReplay')).toBe(true);
    expect(withoutReplayFlag(replay.body)).toEqual(withoutReplayFlag(first.body));
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('975.00');
  });

  test('[IT-11] WIN referenciando a BET → 200, crédito e referência ligada; LOSS → 200 sem lançamento nem versão', async () => {
    const win = await send(
      base(),
      submission(wallet, { kind: 'WIN', amount: '50.00', referenceExternalTransactionId: betExternalId }),
    );
    expect([win.status, field(win.body, 'balance')]).toEqual([200, { amount: '1025.00', currency: 'BRL' }]);
    const winRow = await transactionRow(stringField(win.body, 'transactionId'));
    expect(winRow).toMatchObject({ reference_transaction_id: betId, entries: '1' });

    const loss = await send(
      base(),
      submission(wallet, { kind: 'LOSS', amount: '0.00', referenceExternalTransactionId: betExternalId }),
    );
    expect([loss.status, field(loss.body, 'status'), field(loss.body, 'balance')]).toEqual([
      200,
      'PROCESSED',
      { amount: '1025.00', currency: 'BRL' },
    ]);
    expect(await transactionRow(stringField(loss.body, 'transactionId'))).toMatchObject({
      status: 'PROCESSED',
      entries: '0',
      events: 'WagerTransactionProcessed',
    });
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '1025.00', version: '3' });
  });

  test('[IT-11] REFUND de BET ainda ausente → 202 PENDING_REFERENCE com o saldo do aceite, sem mover saldo; replay 202', async () => {
    const body = submission(wallet, {
      kind: 'REFUND',
      amount: '10.00',
      referenceExternalTransactionId: 'bet-que-ainda-nao-chegou',
    });
    const first = await send(base(), body);
    const transactionId = stringField(first.body, 'transactionId');
    expect([first.status, first.body]).toEqual([
      202,
      {
        transactionId,
        status: 'PENDING_REFERENCE',
        balance: { amount: '1025.00', currency: 'BRL' },
        idempotentReplay: false,
      },
    ]);
    expect(await transactionRow(transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      initial_status: 'PENDING_REFERENCE',
      result_balance: null,
      entries: '0',
      events: 'WagerTransactionPendingReference',
    });
    const replay = await send(base(), body);
    expect([replay.status, withoutReplayFlag(replay.body), field(replay.body, 'idempotentReplay')]).toEqual([
      202,
      withoutReplayFlag(first.body),
      true,
    ]);
    expect((await walletState(fixture.database, wallet.walletId)).version).toBe('3');
  });
});

describe('[IT-11] rejeições de referência e de limite (regras comuns a todas as opções de P1/P2)', () => {
  test('[IT-11] REFUND com valor diferente e REFUND de outra rodada → 422 com códigos próprios', async () => {
    const wallet = await openWallet(base(), '1000.00');
    const bet = submission(wallet, { amount: '100.00' });
    expect((await send(base(), bet)).status).toBe(200);
    const amountMismatch = await send(
      base(),
      submission(wallet, {
        kind: 'REFUND',
        amount: '50.00',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect([amountMismatch.status, field(amountMismatch.body, 'code')]).toEqual([422, 'REFERENCE_AMOUNT_MISMATCH']);
    const otherRound = await send(
      base(),
      submission(wallet, {
        kind: 'REFUND',
        amount: '100.00',
        roundId: 'round-2',
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect([otherRound.status, field(otherRound.body, 'code')]).toEqual([422, 'REFERENCE_SCOPE_MISMATCH']);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('900.00');
  });

  test('[IT-11] REFUND referenciando WIN → INVALID_REFERENCE_KIND', async () => {
    const wallet = await openWallet(base(), '1000.00');
    const bet = submission(wallet, { amount: '100.00' });
    await send(base(), bet);
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '10.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await send(base(), win);
    const refundOfWin = await send(
      base(),
      submission(wallet, {
        kind: 'REFUND',
        amount: '10.00',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect([refundOfWin.status, field(refundOfWin.body, 'code')]).toEqual([422, 'INVALID_REFERENCE_KIND']);
  });

  test('[IT-11] ROLLBACK de WIN sem saldo → REVERSAL_INSUFFICIENT_FUNDS, distinto de BET sem saldo', async () => {
    const wallet = await openWallet(base(), '100.00');
    const bet = submission(wallet, { amount: '100.00' });
    await send(base(), bet);
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await send(base(), win);
    expect(field((await send(base(), submission(wallet, { amount: '30.00' }))).body, 'balance')).toEqual({
      amount: '0.00',
      currency: 'BRL',
    });
    const rollback = await send(
      base(),
      submission(wallet, {
        kind: 'ROLLBACK',
        amount: '30.00',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect([rollback.status, field(rollback.body, 'code')]).toEqual([422, 'REVERSAL_INSUFFICIENT_FUNDS']);
    const betWithoutFunds = await send(base(), submission(wallet, { amount: '1.00' }));
    expect([betWithoutFunds.status, field(betWithoutFunds.body, 'code')]).toEqual([422, 'INSUFFICIENT_FUNDS']);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('0.00');
  });

  test('[IT-11] crédito acima do saldo máximo → BALANCE_LIMIT_EXCEEDED', async () => {
    const wallet = await openWallet(base(), '999999999999999.00');
    const response = await send(base(), submission(wallet, { kind: 'WIN', amount: '1.00' }));
    expect([response.status, field(response.body, 'code')]).toEqual([422, 'BALANCE_LIMIT_EXCEEDED']);
  });

  test('[IT-11] REFUND de BET já premiada (P2 = (c)) → 422 BET_ALREADY_SETTLED, rejeição persistida sem lançamento', async () => {
    const wallet = await openWallet(base(), '1000.00');
    const bet = submission(wallet, { amount: '100.00' });
    await send(base(), bet);
    await send(
      base(),
      submission(wallet, { kind: 'WIN', amount: '10.00', referenceExternalTransactionId: bet.externalTransactionId }),
    );
    const refund = submission(wallet, {
      kind: 'REFUND',
      amount: '100.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const response = await send(base(), refund);
    expect([response.status, field(response.body, 'code')]).toEqual([422, 'BET_ALREADY_SETTLED']);
    expect(
      await countWhere(
        `SELECT count(*)::text AS n FROM wager_transactions
          WHERE idempotency_key = $1 AND status = 'REJECTED' AND failure_code = 'BET_ALREADY_SETTLED'`,
        [keyOf(refund)],
      ),
    ).toBe('1');
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('910.00');
  });
});

describe('[IT-11] wallet de outro player ou moeda divergente → 400 sem persistir', () => {
  test('[IT-11] WALLET_PLAYER_MISMATCH e CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(base(), '50.00');
    const otherPlayer = await submit(
      base(),
      submission({ ...wallet, playerId: Bun.randomUUIDv7() }),
      'it11-mismatch-1',
    );
    expect([otherPlayer.status, field(otherPlayer.body, 'code')]).toEqual([400, 'WALLET_PLAYER_MISMATCH']);
    const otherCurrency = await submit(
      base(),
      { ...submission(wallet), money: { amount: '10.00', currency: 'USD' } },
      'it11-mismatch-2',
    );
    expect([otherCurrency.status, field(otherCurrency.body, 'code')]).toEqual([400, 'CURRENCY_MISMATCH']);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '50.00', transactions: '0' });
  });
});
