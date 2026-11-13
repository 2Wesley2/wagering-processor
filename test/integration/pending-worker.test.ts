import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { lockWallet } from '../support/contention.ts';
import { ownerUrl } from '../support/db.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field, stringField } from '../support/http.ts';
import { type Instance, signal, startInstance, waitReady } from '../support/instances.ts';
import { setDeadline, storedTransaction, waitResolved, workerEnv } from '../support/pending.ts';
import { withClient } from '../support/sql-fixtures.ts';
import {
  invariantIssues,
  openWallet,
  send,
  submission,
  type SubmissionBody,
  type TestWallet,
  walletState,
  withoutReplayFlag,
} from '../support/wagering.ts';

/**
 * Worker de PENDING_REFERENCE (D40) com prazos controlados pelo banco (D55): a preparação é feita
 * por uma instância só de API; os prazos são fixados por SQL relativos a instantes gravados; o
 * worker só é ligado depois, para que "worker atrasado" seja real. Valores fixos (D58).
 *
 * IT-26 (a)–(f), IT-10b (replay de uma 1ª resposta 202 depois da resolução), RV-IT-03 (ordem por
 * aceite, casos E1 nas duas ordens e E2) e RV-IT-06 (prazo em cadeia).
 */
let fixture: Fixture;
let apiInstance: Instance;

beforeAll(async () => {
  fixture = await createFixture('it26');
  apiInstance = startInstance({ id: 'it26-api', env: fixture.env() });
  await waitReady(apiInstance);
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const UUID = /^[0-9a-f-]{36}$/;
function quoted(id: string): string {
  if (!UUID.test(id)) throw new Error(`id inválido: ${id}`);
  return `'${id}'::uuid`;
}
const acceptedOf = (id: string) => `(SELECT accepted_at FROM wager_transactions WHERE id = ${quoted(id)})`;

async function post(body: SubmissionBody): Promise<{ status: number; id: string; body: unknown }> {
  const response = await send(apiInstance.baseUrl, body);
  const id =
    response.status === 422
      ? stringField(field(response.body, 'transaction'), 'transactionId')
      : stringField(response.body, 'transactionId');
  return { status: response.status, id, body: response.body };
}

const reversal = (wallet: TestWallet, kind: 'REFUND' | 'ROLLBACK', externalTransactionId: string, reference: string) =>
  submission(wallet, { kind, amount: '10.00', externalTransactionId, referenceExternalTransactionId: reference });
const betOf = (wallet: TestWallet, externalTransactionId: string, amount = '10.00') =>
  submission(wallet, { kind: 'BET', amount, externalTransactionId });

/** Verdadeiro quando o relógio do PostgreSQL já passou do prazo de todas as pendências dadas. */
async function deadlinesPassed(database: string, ids: readonly string[]): Promise<boolean> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ passed: boolean }>(
      `SELECT bool_and(clock_timestamp() > pending_deadline_at) AS passed
         FROM wager_transactions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return result.rows[0]?.passed === true;
  });
}

/** Lançamentos e eventos `WagerTransactionProcessed` de cada transação (efeito aplicado uma vez). */
async function effectsOf(database: string, ids: readonly string[]): Promise<string[]> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ effects: string }>(
      `SELECT (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id)::text || ':' ||
              (SELECT count(*) FROM outbox_messages o WHERE o.event_type = 'WagerTransactionProcessed'
                  AND o.payload -> 'data' ->> 'transactionId' = t.id::text)::text AS effects
         FROM wager_transactions t, unnest($1::uuid[]) WITH ORDINALITY AS wanted(id, position)
        WHERE t.id = wanted.id ORDER BY wanted.position`,
      [ids],
    );
    return result.rows.map((row) => row.effects);
  });
}

async function undoneByOf(database: string, refundId: string): Promise<string | null | undefined> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ undone_by: string | null }>(
      'SELECT undone_by::text AS undone_by FROM wager_reversals WHERE reversal_id = $1::uuid',
      [refundId],
    );
    return result.rows[0]?.undone_by;
  });
}

interface Batch {
  wallets: Record<string, TestWallet>;
  ids: Record<string, string>;
  bodies: Record<string, SubmissionBody>;
  firstResponses: Record<string, unknown>;
}
const batch: Batch = { wallets: {}, ids: {}, bodies: {}, firstResponses: {} };

describe('[IT-26] worker de pendências: regra de prazo pelo PostgreSQL', () => {
  test('[IT-26] preparação com o worker desligado e uma única rodada de worker depois', async () => {
    const open = async (name: string, amount: string) => {
      batch.wallets[name] = await openWallet(apiInstance.baseUrl, amount);
      return batch.wallets[name];
    };
    const submitNamed = async (name: string, body: SubmissionBody) => {
      batch.bodies[name] = body;
      const result = await post(body);
      batch.ids[name] = result.id;
      batch.firstResponses[name] = result.body;
      return result;
    };
    const farDeadline = (name: string) =>
      setDeadline(fixture.database, batch.ids[name] ?? '', `${acceptedOf(batch.ids[name] ?? '')} + interval '1 hour'`);

    // (a) referência aceita antes do prazo; o worker roda depois do prazo.
    const a = await open('a', '100.00');
    expect((await submitNamed('aP', reversal(a, 'REFUND', 'a-refund', 'a-bet'))).status).toBe(202);
    expect((await submitNamed('aR', betOf(a, 'a-bet'))).status).toBe(200);
    await setDeadline(
      fixture.database,
      batch.ids['aP'] ?? '',
      `${acceptedOf(batch.ids['aR'] ?? '')} + interval '1 millisecond'`,
    );

    // (b) prazo vence antes de a referência chegar.
    const b = await open('b', '100.00');
    expect((await submitNamed('bP', reversal(b, 'REFUND', 'b-refund', 'b-bet'))).status).toBe(202);
    await setDeadline(
      fixture.database,
      batch.ids['bP'] ?? '',
      `${acceptedOf(batch.ids['bP'] ?? '')} + interval '1 millisecond'`,
    );
    await Bun.sleep(5);
    expect((await submitNamed('bR', betOf(b, 'b-bet'))).status).toBe(200);

    // (c) / RV-IT-06: prazo em cadeia u1 → r1 → b1.
    const c = await open('c', '100.00');
    expect((await submitNamed('cU', reversal(c, 'ROLLBACK', 'c-undo', 'c-refund'))).status).toBe(202);
    expect((await submitNamed('cR', reversal(c, 'REFUND', 'c-refund', 'c-bet'))).status).toBe(202);
    await setDeadline(
      fixture.database,
      batch.ids['cU'] ?? '',
      `${acceptedOf(batch.ids['cR'] ?? '')} + interval '1 millisecond'`,
    );
    await farDeadline('cR');
    await Bun.sleep(5);
    expect((await submitNamed('cB', betOf(c, 'c-bet'))).status).toBe(200);

    // (d) referência REJECTED → dependente REFERENCE_NOT_PROCESSED.
    const d = await open('d', '5.00');
    expect((await submitNamed('dP', reversal(d, 'REFUND', 'd-refund', 'd-bet'))).status).toBe(202);
    await farDeadline('dP');
    expect((await submitNamed('dR', betOf(d, 'd-bet'))).status).toBe(422);

    // IT-10b: 1ª resposta 202 (100.00); referência e outra aposta chegam; o worker resolve depois.
    const x = await open('x', '100.00');
    expect((await submitNamed('xP', reversal(x, 'REFUND', 'x-refund', 'x-bet'))).status).toBe(202);
    await farDeadline('xP');
    expect((await submitNamed('xR', betOf(x, 'x-bet'))).status).toBe(200);
    expect((await submitNamed('xOther', betOf(x, 'x-other', '20.00'))).status).toBe(200);

    // RV-IT-03 E1, ordem r1 → k1.
    const e = await open('e', '100.00');
    expect((await submitNamed('eRefund', reversal(e, 'REFUND', 'e-refund', 'e-bet'))).status).toBe(202);
    expect((await submitNamed('eRollback', reversal(e, 'ROLLBACK', 'e-rollback', 'e-bet'))).status).toBe(202);
    await farDeadline('eRefund');
    await farDeadline('eRollback');
    expect((await submitNamed('eBet', betOf(e, 'e-bet'))).status).toBe(200);

    // RV-IT-03 E1, ordem inversa k1 → r1.
    const f = await open('f', '100.00');
    expect((await submitNamed('fRollback', reversal(f, 'ROLLBACK', 'f-rollback', 'f-bet'))).status).toBe(202);
    expect((await submitNamed('fRefund', reversal(f, 'REFUND', 'f-refund', 'f-bet'))).status).toBe(202);
    await farDeadline('fRollback');
    await farDeadline('fRefund');
    expect((await submitNamed('fBet', betOf(f, 'f-bet'))).status).toBe(200);

    // RV-IT-03 E2: u1 → r1 → b1 (o reembolso é desfeito na mesma rodada).
    const g = await open('g', '100.00');
    expect((await submitNamed('gUndo', reversal(g, 'ROLLBACK', 'g-undo', 'g-refund'))).status).toBe(202);
    expect((await submitNamed('gRefund', reversal(g, 'REFUND', 'g-refund', 'g-bet'))).status).toBe(202);
    await farDeadline('gUndo');
    await farDeadline('gRefund');
    expect((await submitNamed('gBet', betOf(g, 'g-bet'))).status).toBe(200);

    // RV-IT-06 com a cadeia já vencida: u1 (ROLLBACK do REFUND) chega antes de r1 (REFUND da BET),
    // que chega antes de b1. b1 fica disponível dentro do prazo de r1, e o prazo de u1 vai até o
    // aceite de r1. O worker só começa depois do prazo efetivo de toda a cadeia.
    const h = await open('h', '100.00');
    expect((await submitNamed('hU', reversal(h, 'ROLLBACK', 'h-undo', 'h-refund'))).status).toBe(202);
    expect((await submitNamed('hR', reversal(h, 'REFUND', 'h-refund', 'h-bet'))).status).toBe(202);
    expect((await submitNamed('hB', betOf(h, 'h-bet'))).status).toBe(200);
    await setDeadline(
      fixture.database,
      batch.ids['hU'] ?? '',
      `${acceptedOf(batch.ids['hR'] ?? '')} + interval '1 millisecond'`,
    );
    await setDeadline(
      fixture.database,
      batch.ids['hR'] ?? '',
      `${acceptedOf(batch.ids['hB'] ?? '')} + interval '1 millisecond'`,
    );

    // Contraprova: na mesma forma de cadeia, r1 chega depois do prazo de u1 → u1 expira de verdade.
    const i = await open('i', '100.00');
    expect((await submitNamed('iU', reversal(i, 'ROLLBACK', 'i-undo', 'i-refund'))).status).toBe(202);
    await setDeadline(
      fixture.database,
      batch.ids['iU'] ?? '',
      `${acceptedOf(batch.ids['iU'] ?? '')} + interval '1 millisecond'`,
    );
    await Bun.sleep(5);
    expect((await submitNamed('iR', reversal(i, 'REFUND', 'i-refund', 'i-bet'))).status).toBe(202);
    await farDeadline('iR');
    expect((await submitNamed('iB', betOf(i, 'i-bet'))).status).toBe(200);

    const pendings = [
      'aP',
      'bP',
      'cU',
      'cR',
      'dP',
      'xP',
      'eRefund',
      'eRollback',
      'fRollback',
      'fRefund',
      'gUndo',
      'gRefund',
      'hU',
      'hR',
      'iU',
      'iR',
    ];
    for (const name of pendings) {
      expect({ name, status: (await storedTransaction(fixture.database, batch.ids[name] ?? '')).status }).toEqual({
        name,
        status: 'PENDING_REFERENCE',
      });
    }

    // O worker começa depois do prazo efetivo da cadeia h (prazos fixados pelo banco).
    expect(await deadlinesPassed(fixture.database, [batch.ids['hU'] ?? '', batch.ids['hR'] ?? ''])).toBe(true);
    const worker = startInstance({ id: 'it26-worker', env: workerEnv(fixture) });
    await waitReady(worker);
    await waitResolved(
      fixture.database,
      pendings.map((name) => batch.ids[name] ?? ''),
    );
    signal(worker, 'SIGTERM');
    await worker.exited;
  });

  test('[IT-26] (a) referência disponível antes do prazo, worker depois do prazo → PROCESSED', async () => {
    const stored = await storedTransaction(fixture.database, batch.ids['aP'] ?? '');
    writeEvidence('IT-26-a', { ...stored });
    expect(stored).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
      resultWalletVersion: '3',
      availableBeforeOrAtDeadline: true,
      decidedAfterDeadline: true,
      inAgenda: false,
    });
  });

  test('[IT-26] (b) referência só depois do prazo → REJECTED REFERENCE_NOT_FOUND; a referência segue normal', async () => {
    const stored = await storedTransaction(fixture.database, batch.ids['bP'] ?? '');
    writeEvidence('IT-26-b', { ...stored });
    expect(stored).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      availableEqualsDeadline: true,
      inAgenda: false,
    });
    expect((await storedTransaction(fixture.database, batch.ids['bR'] ?? '')).status).toBe('PROCESSED');
    expect((await walletState(fixture.database, batch.wallets['b']?.walletId ?? '')).balance).toBe('90.00');
  });

  test('[IT-26] [RV-IT-06] (c) prazo em cadeia u1 → r1 → b1: u1 é resolvida pelo prazo efetivo de r1', async () => {
    expect(await storedTransaction(fixture.database, batch.ids['cR'] ?? '')).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    const undo = await storedTransaction(fixture.database, batch.ids['cU'] ?? '');
    writeEvidence('IT-26-c', { ...undo });
    expect(undo).toMatchObject({ status: 'PROCESSED', resultBalance: '90.00', availableBeforeOrAtDeadline: false });
    expect((await walletState(fixture.database, batch.wallets['c']?.walletId ?? '')).balance).toBe('90.00');
  });

  test('[IT-26] (d) referência REJECTED → REJECTED REFERENCE_NOT_PROCESSED', async () => {
    expect(await storedTransaction(fixture.database, batch.ids['dP'] ?? '')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_PROCESSED',
      resultBalance: '5.00',
    });
  });
});

describe('[IT-26] [RV-IT-06] cadeia ROLLBACK → REFUND → BET com o worker depois do prazo efetivo', () => {
  test('[IT-26] [RV-IT-06] (g) BET disponível no prazo de r1: r1 e u1 aplicados uma vez cada; saldo 90.00', async () => {
    const refund = await storedTransaction(fixture.database, batch.ids['hR'] ?? '');
    const undo = await storedTransaction(fixture.database, batch.ids['hU'] ?? '');
    writeEvidence('IT-26-g', { refund, undo });
    expect(refund).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
      resultWalletVersion: '3',
      availableBeforeOrAtDeadline: true,
      decidedAfterDeadline: true,
    });
    expect(undo).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '90.00',
      resultWalletVersion: '4',
      decidedAfterDeadline: true,
    });
    expect(await effectsOf(fixture.database, [batch.ids['hR'] ?? '', batch.ids['hU'] ?? ''])).toEqual(['1:1', '1:1']);
    expect(await undoneByOf(fixture.database, batch.ids['hR'] ?? '')).toBe(batch.ids['hU']);
    expect(await walletState(fixture.database, batch.wallets['h']?.walletId ?? '')).toMatchObject({
      balance: '90.00',
      version: '4',
      entries: '4',
    });
  });

  test('[IT-26] [RV-IT-06] (g) contraprova: r1 aceita depois do prazo de u1 → u1 REFERENCE_NOT_FOUND; r1 segue', async () => {
    expect(await storedTransaction(fixture.database, batch.ids['iU'] ?? '')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      availableEqualsDeadline: true,
    });
    expect(await storedTransaction(fixture.database, batch.ids['iR'] ?? '')).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    expect((await walletState(fixture.database, batch.wallets['i']?.walletId ?? '')).balance).toBe('100.00');
  });

  test('[IT-26] [RV-IT-06] (g) WORKER_BATCH_SIZE=1: a 1ª pendência do lote não bloqueia a referência fora dele', async () => {
    const wallet = await openWallet(apiInstance.baseUrl, '100.00');
    const undo = await post(reversal(wallet, 'ROLLBACK', 'j-undo', 'j-refund'));
    const refund = await post(reversal(wallet, 'REFUND', 'j-refund', 'j-bet'));
    const bet = await post(betOf(wallet, 'j-bet'));
    expect([undo.status, refund.status, bet.status]).toEqual([202, 202, 200]);
    await setDeadline(fixture.database, undo.id, `${acceptedOf(refund.id)} + interval '1 millisecond'`);
    await setDeadline(fixture.database, refund.id, `${acceptedOf(bet.id)} + interval '1 millisecond'`);
    expect(await deadlinesPassed(fixture.database, [undo.id, refund.id])).toBe(true);

    const worker = startInstance({ id: 'it26-worker-batch1', env: workerEnv(fixture, { WORKER_BATCH_SIZE: '1' }) });
    await waitReady(worker);
    await waitResolved(fixture.database, [undo.id, refund.id]);
    signal(worker, 'SIGTERM');
    await worker.exited;

    expect(await storedTransaction(fixture.database, refund.id)).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    expect(await storedTransaction(fixture.database, undo.id)).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '90.00',
    });
    expect(await effectsOf(fixture.database, [refund.id, undo.id])).toEqual(['1:1', '1:1']);
    expect(await undoneByOf(fixture.database, refund.id)).toBe(undo.id);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '90.00', entries: '4' });
  });
});

describe('[IT-26] dependência inválida não fica pendente indefinidamente', () => {
  test('[IT-26] (h) dois ROLLBACKs que referenciam um ao outro → ambos REJECTED após o prazo; saldo e ledger intactos', async () => {
    const wallet = await openWallet(apiInstance.baseUrl, '100.00');
    const first = await post(reversal(wallet, 'ROLLBACK', 'k-a', 'k-b'));
    const second = await post(reversal(wallet, 'ROLLBACK', 'k-b', 'k-a'));
    // Cada um encontra o outro ausente ou PENDING_REFERENCE na chegada: os dois ficam pendentes.
    expect([first.status, second.status]).toEqual([202, 202]);
    // O prazo do 1º vai até o aceite do 2º (a referência existe dentro do prazo); o do 2º, 1 ms.
    await setDeadline(fixture.database, first.id, `${acceptedOf(second.id)} + interval '1 millisecond'`);
    await setDeadline(fixture.database, second.id, `${acceptedOf(second.id)} + interval '1 millisecond'`);
    expect(await deadlinesPassed(fixture.database, [first.id, second.id])).toBe(true);

    const worker = startInstance({ id: 'it26-worker-cycle', env: workerEnv(fixture) });
    try {
      await waitReady(worker);
      await waitResolved(fixture.database, [first.id, second.id], 15_000);
    } finally {
      signal(worker, 'SIGTERM');
      await worker.exited;
    }

    const stored = [
      await storedTransaction(fixture.database, first.id),
      await storedTransaction(fixture.database, second.id),
    ];
    writeEvidence('IT-26-h', { first: stored[0], second: stored[1] });
    for (const transaction of stored) {
      expect(transaction).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INVALID_REFERENCE_KIND',
        resultBalance: '100.00',
        resultWalletVersion: '1',
        decidedAfterDeadline: true,
        inAgenda: false,
      });
    }
    expect(await effectsOf(fixture.database, [first.id, second.id])).toEqual(['0:0', '0:0']);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({
      balance: '100.00',
      version: '1',
      entries: '1',
    });
  });
});

describe('[IT-10b] replay de uma 1ª resposta 202 depois da resolução (I1 = opção A)', () => {
  test('[IT-10b] o POST repetido devolve o 202 original; o GET mostra o desfecho e o saldo da decisão', async () => {
    const original = batch.firstResponses['xP'];
    expect(original).toEqual({
      transactionId: batch.ids['xP'],
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await send(apiInstance.baseUrl, batch.bodies['xP'] ?? submission({ walletId: '', playerId: '' }));
    expect([replay.status, withoutReplayFlag(replay.body), field(replay.body, 'idempotentReplay')]).toEqual([
      202,
      withoutReplayFlag(original),
      true,
    ]);
    const current = await api(apiInstance.baseUrl, 'GET', `/wagering/transactions/${batch.ids['xP'] ?? ''}`);
    expect(current.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '80.00', currency: 'BRL' },
      walletVersion: 4,
      initialStatus: 'PENDING_REFERENCE',
      acceptedBalance: { amount: '100.00', currency: 'BRL' },
      acceptedWalletVersion: 1,
      failureCode: null,
    });
    expect(typeof field(current.body, 'decidedAt')).toBe('string');
  });
});

describe('[RV-IT-03] ordem de resolução por aceite (Kahn), P1 = C', () => {
  test('[RV-IT-03] E1 r1 → k1: r1 PROCESSED, k1 REJECTED REFERENCE_ALREADY_REVERSED; saldo 100.00', async () => {
    expect(await storedTransaction(fixture.database, batch.ids['eRefund'] ?? '')).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    expect(await storedTransaction(fixture.database, batch.ids['eRollback'] ?? '')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect((await walletState(fixture.database, batch.wallets['e']?.walletId ?? '')).balance).toBe('100.00');
  });

  test('[RV-IT-03] E1 na ordem inversa k1 → r1: k1 PROCESSED, r1 REJECTED REFERENCE_ALREADY_REVERSED; saldo 100.00', async () => {
    expect((await storedTransaction(fixture.database, batch.ids['fRollback'] ?? '')).status).toBe('PROCESSED');
    expect(await storedTransaction(fixture.database, batch.ids['fRefund'] ?? '')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });
    expect((await walletState(fixture.database, batch.wallets['f']?.walletId ?? '')).balance).toBe('100.00');
  });

  test('[RV-IT-03] E2 u1 → r1 → b1: r1 (+10) e depois u1 (−10) na mesma rodada; saldo 90.00 e REFUND desfeito', async () => {
    expect(await storedTransaction(fixture.database, batch.ids['gRefund'] ?? '')).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '100.00',
    });
    expect(await storedTransaction(fixture.database, batch.ids['gUndo'] ?? '')).toMatchObject({
      status: 'PROCESSED',
      resultBalance: '90.00',
    });
    const undoneBy = await withClient(ownerUrl(fixture.database), async (client) => {
      const result = await client.query<{ undone_by: string | null }>(
        'SELECT undone_by::text AS undone_by FROM wager_reversals WHERE reversal_id = $1::uuid',
        [batch.ids['gRefund']],
      );
      return result.rows[0]?.undone_by;
    });
    expect(undoneBy).toBe(batch.ids['gUndo']);
    expect((await walletState(fixture.database, batch.wallets['g']?.walletId ?? '')).balance).toBe('90.00');
  });
});

describe('[IT-26] tentativas e várias instâncias', () => {
  test('[IT-26] (e) lock além do lock_timeout não consome tentativa; tentativas nunca rejeitam', async () => {
    const wallet = await openWallet(apiInstance.baseUrl, '100.00');
    const locked = await post(reversal(wallet, 'REFUND', 'e2-refund', 'e2-bet'));
    await setDeadline(fixture.database, locked.id, `${acceptedOf(locked.id)} + interval '1 hour'`);
    await post(betOf(wallet, 'e2-bet'));
    const other = await openWallet(apiInstance.baseUrl, '100.00');
    const waiting = await post(reversal(other, 'REFUND', 'e2-wait', 'nunca-chega'));
    await setDeadline(fixture.database, waiting.id, `${acceptedOf(waiting.id)} + interval '1 hour'`);
    await withClient(ownerUrl(fixture.database), (client) =>
      client.query('UPDATE pending_reference_checks SET attempts = 1000 WHERE transaction_id = $1::uuid', [waiting.id]),
    );

    const lock = await lockWallet(fixture.database, wallet.walletId);
    const worker = startInstance({ id: 'it26-worker-e', env: workerEnv(fixture, { DB_LOCK_TIMEOUT_MS: '200' }) });
    try {
      await waitReady(worker);
      const agenda = await eventually(
        async () =>
          withClient(ownerUrl(fixture.database), async (client) => {
            const result = await client.query<{ attempts: number; last_error: string | null }>(
              'SELECT attempts, last_error FROM pending_reference_checks WHERE transaction_id = $1::uuid',
              [locked.id],
            );
            const row = result.rows[0];
            return row !== undefined && row.last_error !== null ? row : undefined;
          }),
        { timeoutMs: 15_000, describe: 'falha de lock registrada na agenda' },
      );
      expect(agenda.attempts).toBe(0);
      expect((await storedTransaction(fixture.database, locked.id)).status).toBe('PENDING_REFERENCE');
    } finally {
      await lock.release();
    }
    await waitResolved(fixture.database, [locked.id]);
    expect((await storedTransaction(fixture.database, locked.id)).status).toBe('PROCESSED');
    const attempts = await eventually(
      async () =>
        withClient(ownerUrl(fixture.database), async (client) => {
          const result = await client.query<{ attempts: number }>(
            'SELECT attempts FROM pending_reference_checks WHERE transaction_id = $1::uuid',
            [waiting.id],
          );
          const value = result.rows[0]?.attempts;
          return value !== undefined && value > 1000 ? value : undefined;
        }),
      { timeoutMs: 15_000, describe: 'pendência reagendada (tentativas acima de 1000)' },
    );
    expect(attempts).toBeGreaterThan(1000);
    expect((await storedTransaction(fixture.database, waiting.id)).status).toBe('PENDING_REFERENCE');
    signal(worker, 'SIGTERM');
    await worker.exited;
  });

  test('[IT-26] (f) três workers simultâneos: cada pendência resolvida uma vez, status relido sob o lock', async () => {
    const pendingIds: string[] = [];
    const wallets: TestWallet[] = [];
    for (let walletIndex = 0; walletIndex < 4; walletIndex++) {
      const wallet = await openWallet(apiInstance.baseUrl, '100.00');
      wallets.push(wallet);
      for (let item = 0; item < 5; item++) {
        const result = await post(reversal(wallet, 'REFUND', `f${walletIndex}-r${item}`, `f${walletIndex}-b${item}`));
        await setDeadline(fixture.database, result.id, `${acceptedOf(result.id)} + interval '1 hour'`);
        pendingIds.push(result.id);
      }
      for (let item = 0; item < 5; item++) await post(betOf(wallet, `f${walletIndex}-b${item}`));
    }
    const workers = ['it26-f1', 'it26-f2', 'it26-f3'].map((id) => startInstance({ id, env: workerEnv(fixture) }));
    await Promise.all(workers.map((worker) => waitReady(worker)));
    await waitResolved(fixture.database, pendingIds);
    const summary = await withClient(ownerUrl(fixture.database), async (client) => {
      const result = await client.query<{ status: string; events: string; entries: string }>(
        `SELECT t.status,
                (SELECT count(*) FROM outbox_messages o WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text
                   AND o.event_type = 'WagerTransactionProcessed')::text AS events,
                (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id)::text AS entries
           FROM wager_transactions t WHERE t.id = ANY($1::uuid[])`,
        [pendingIds],
      );
      return result.rows;
    });
    const failures = workers.flatMap((worker) =>
      worker.logs.entries.filter((entry) => entry.event === 'pending_reference_worker.tick_failed'),
    );
    writeEvidence('IT-26-f', { resolved: summary.length, failures: failures.length });
    expect(summary).toHaveLength(20);
    expect(new Set(summary.map((row) => `${row.status}:${row.events}:${row.entries}`))).toEqual(
      new Set(['PROCESSED:1:1']),
    );
    expect(failures).toEqual([]);
    for (const wallet of wallets) expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('100.00');
    for (const worker of workers) signal(worker, 'SIGTERM');
    await Promise.all(workers.map((worker) => worker.exited));
  });
});
