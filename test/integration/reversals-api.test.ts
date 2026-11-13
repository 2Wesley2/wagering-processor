import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ownerUrl } from '../support/db.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { withClient } from '../support/sql-fixtures.ts';
import {
  invariantIssues,
  openWallet,
  send,
  submission,
  submit,
  type SubmissionBody,
  type TestWallet,
  walletState,
  withoutReplayFlag,
} from '../support/wagering.ts';

/**
 * Reversões pela API real com P1 = C e P2 = (c) (ARCHITECTURE.md §1). Base dos exemplos: saldo
 * 100.00 (OPENING, v1) e BET b1 de 10.00 (90.00, v2). Saldos, versões e códigos escritos à mão
 * a partir das tabelas da decisão (D58).
 */
let fixture: Fixture;
let app: Instance;

beforeAll(async () => {
  fixture = await createFixture('rvapi');
  app = startInstance({ id: 'rvapi-1', env: fixture.env() });
  await waitReady(app);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function withBet(): Promise<{ wallet: TestWallet; bet: SubmissionBody }> {
  const wallet = await openWallet(app.baseUrl, '100.00');
  const bet = submission(wallet, { amount: '10.00' });
  expect((await send(app.baseUrl, bet)).status).toBe(200);
  return { wallet, bet };
}

const reversalOf = (
  wallet: TestWallet,
  kind: 'REFUND' | 'ROLLBACK',
  target: SubmissionBody,
  amount = target.money.amount,
) => submission(wallet, { kind, amount, referenceExternalTransactionId: target.externalTransactionId });

const outcome = (response: { status: number; body: unknown }) => [
  response.status,
  field(response.body, 'code') ?? field(response.body, 'status'),
  field(response.body, 'balance') ?? field(field(response.body, 'transaction'), 'balance'),
];
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function ledgerOf(walletId: string): Promise<string[]> {
  return withClient(ownerUrl(fixture.database), async (client) => {
    const result = await client.query<{ line: string }>(
      `SELECT e.wallet_version || ':' || e.direction || ':' || e.amount::text || ':' || e.balance_before::text || '→' || e.balance_after::text AS line
         FROM wallet_ledger_entries e WHERE e.wallet_id = $1::uuid ORDER BY e.wallet_version`,
      [walletId],
    );
    return result.rows.map((row) => row.line);
  });
}

describe('[RV-IT-02] cenários 1 e 2 de P1 = C, ponta a ponta', () => {
  test('[RV-IT-02] cenário 1: REFUND em vigor, ROLLBACK da mesma BET → 422 REFERENCE_ALREADY_REVERSED; saldo 100.00', async () => {
    const { wallet, bet } = await withBet();
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet)))).toEqual([
      200,
      'PROCESSED',
      brl('100.00'),
    ]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', bet)))).toEqual([
      422,
      'REFERENCE_ALREADY_REVERSED',
      brl('100.00'),
    ]);
    expect(await ledgerOf(wallet.walletId)).toEqual([
      '1:CREDIT:100.00:0.00→100.00',
      '2:DEBIT:10.00:100.00→90.00',
      '3:CREDIT:10.00:90.00→100.00',
    ]);
  });

  test('[RV-IT-02] cenário 2: REFUND desfeito antes → ROLLBACK da BET aceito; novo REFUND → REVERSAL_KIND_ALREADY_USED', async () => {
    const { wallet, bet } = await withBet();
    const refund = reversalOf(wallet, 'REFUND', bet);
    expect(outcome(await send(app.baseUrl, refund))).toEqual([200, 'PROCESSED', brl('100.00')]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', refund)))).toEqual([
      200,
      'PROCESSED',
      brl('90.00'),
    ]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', bet)))).toEqual([
      200,
      'PROCESSED',
      brl('100.00'),
    ]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet)))).toEqual([
      422,
      'REVERSAL_KIND_ALREADY_USED',
      brl('100.00'),
    ]);
    expect(await ledgerOf(wallet.walletId)).toEqual([
      '1:CREDIT:100.00:0.00→100.00',
      '2:DEBIT:10.00:100.00→90.00',
      '3:CREDIT:10.00:90.00→100.00',
      '4:DEBIT:10.00:100.00→90.00',
      '5:CREDIT:10.00:90.00→100.00',
    ]);
  });
});

describe('[RV-IT-04] replay depois de mudança de estado', () => {
  test('[RV-IT-04] o REFUND desfeito e o ROLLBACK rejeitado continuam devolvendo a resposta original', async () => {
    const { wallet, bet } = await withBet();
    const refund = reversalOf(wallet, 'REFUND', bet);
    const firstRefund = await send(app.baseUrl, refund);
    const rejected = reversalOf(wallet, 'ROLLBACK', bet);
    const firstRejection = await send(app.baseUrl, rejected);
    expect(firstRejection.status).toBe(422);
    await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', refund));
    const refundReplay = await send(app.baseUrl, refund);
    expect([
      refundReplay.status,
      withoutReplayFlag(refundReplay.body),
      field(refundReplay.body, 'idempotentReplay'),
    ]).toEqual([200, withoutReplayFlag(firstRefund.body), true]);
    expect(field(refundReplay.body, 'balance')).toEqual(brl('100.00'));
    // O ROLLBACK da BET agora seria aceito com uma key nova, mas o replay mantém o 422 original.
    const rejectionReplay = await send(app.baseUrl, rejected);
    expect([rejectionReplay.status, withoutReplayFlag(rejectionReplay.body)]).toEqual([
      422,
      withoutReplayFlag(firstRejection.body),
    ]);
  });
});

describe('[P2-T1] WIN sobre BET revertida (P2 = (c))', () => {
  test('[P2-T1] REFUND em vigor, depois WIN 30.00 → 422 REFERENCED_BET_REVERSED; saldo 100.00', async () => {
    const { wallet, bet } = await withBet();
    await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet));
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(outcome(await send(app.baseUrl, win))).toEqual([422, 'REFERENCED_BET_REVERSED', brl('100.00')]);
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('100.00');
  });

  test('[P2-T1] reembolso já desfeito não impede o WIN: 200 e saldo 120.00', async () => {
    const { wallet, bet } = await withBet();
    const refund = reversalOf(wallet, 'REFUND', bet);
    await send(app.baseUrl, refund);
    await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', refund));
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(outcome(await send(app.baseUrl, win))).toEqual([200, 'PROCESSED', brl('120.00')]);
  });
});

describe('[P2-T2] reversão de BET com WIN em vigor', () => {
  test('[P2-T2] WIN 30.00 (120.00), depois REFUND → 422 BET_ALREADY_SETTLED; saldo 120.00; ROLLBACK da BET idem', async () => {
    const { wallet, bet } = await withBet();
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(outcome(await send(app.baseUrl, win))).toEqual([200, 'PROCESSED', brl('120.00')]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet)))).toEqual([
      422,
      'BET_ALREADY_SETTLED',
      brl('120.00'),
    ]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', bet)))).toEqual([
      422,
      'BET_ALREADY_SETTLED',
      brl('120.00'),
    ]);
  });
});

describe('[P2-T3] fluxo corretivo: estornar o WIN e pedir o reembolso de novo', () => {
  test('[P2-T3] o 422 do 1º REFUND não muda; ROLLBACK do WIN (90.00); REFUND novo com novo externalId e nova key → 100.00', async () => {
    const { wallet, bet } = await withBet();
    const win = submission(wallet, {
      kind: 'WIN',
      amount: '30.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await send(app.baseUrl, win);
    const firstRefund = reversalOf(wallet, 'REFUND', bet);
    const rejected = await send(app.baseUrl, firstRefund);
    expect(field(rejected.body, 'code')).toBe('BET_ALREADY_SETTLED');
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'ROLLBACK', win)))).toEqual([
      200,
      'PROCESSED',
      brl('90.00'),
    ]);
    // Reenviar a mesma operação (mesma key) devolve o mesmo 422: estornar o WIN não muda aquela resposta.
    const replay = await send(app.baseUrl, firstRefund);
    expect([replay.status, withoutReplayFlag(replay.body)]).toEqual([422, withoutReplayFlag(rejected.body)]);
    // Mesmo externalId com outra key → conflito; operação nova (novo externalId e nova key) → aplicada.
    const sameExternalId = await submit(app.baseUrl, firstRefund, 'nova-key-mesmo-external-id');
    expect([sameExternalId.status, field(sameExternalId.body, 'code')]).toEqual([
      409,
      'EXTERNAL_TRANSACTION_ID_CONFLICT',
    ]);
    expect(outcome(await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet)))).toEqual([
      200,
      'PROCESSED',
      brl('100.00'),
    ]);
  });
});

describe('[P2-T4] WIN sem referência à BET (limitação documentada)', () => {
  test('[P2-T4] REFUND em vigor, depois WIN 30.00 sem referência → 200 e saldo 130.00', async () => {
    const { wallet, bet } = await withBet();
    await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet));
    const win = submission(wallet, { kind: 'WIN', amount: '30.00' });
    expect(outcome(await send(app.baseUrl, win))).toEqual([200, 'PROCESSED', brl('130.00')]);
  });
});

describe('[P2-T5] LOSS sobre BET revertida', () => {
  test('[P2-T5] REFUND em vigor, depois LOSS → 422 REFERENCED_BET_REVERSED; saldo 100.00', async () => {
    const { wallet, bet } = await withBet();
    await send(app.baseUrl, reversalOf(wallet, 'REFUND', bet));
    const loss = submission(wallet, {
      kind: 'LOSS',
      amount: '0.00',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(outcome(await send(app.baseUrl, loss))).toEqual([422, 'REFERENCED_BET_REVERSED', brl('100.00')]);
  });
});
