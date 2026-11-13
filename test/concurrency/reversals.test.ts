import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { type Cluster, inParallel, startCluster } from '../support/cluster.ts';
import { appUrl } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { failureOf, movementInOpenTx, movementSql, openWalletSql, withClient } from '../support/sql-fixtures.ts';
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
 * Reversões concorrentes com 3 instâncias (P1 = C, P2 = (c)). Todas as ordens possíveis de
 * aquisição do lock levam a no máximo uma reversão em vigor e a crédito líquido 0 ou o valor da
 * aposta; o banco é a barreira final mesmo sem a política (RV-CT-04).
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('rvct');
  cluster = await startCluster(fixture, 'rvct');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

async function withBet(): Promise<{ wallet: TestWallet; bet: SubmissionBody }> {
  const wallet = await openWallet(cluster.next().baseUrl, '100.00');
  const bet = submission(wallet, { amount: '10.00' });
  expect((await send(cluster.next().baseUrl, bet)).status).toBe(200);
  return { wallet, bet };
}

const reversalOf = (wallet: TestWallet, kind: 'REFUND' | 'ROLLBACK', target: SubmissionBody) =>
  submission(wallet, {
    kind,
    amount: target.money.amount,
    referenceExternalTransactionId: target.externalTransactionId,
  });

const codeOf = (response: { status: number; body: unknown }): string =>
  response.status === 200 ? 'PROCESSED' : String(field(response.body, 'code'));

describe('[RV-CT-01] REFUND ‖ ROLLBACK da mesma BET em instâncias diferentes', () => {
  test('[RV-CT-01] 30 iterações: sempre 1 PROCESSED e 1 REFERENCE_ALREADY_REVERSED; saldo 100.00', async () => {
    const outcomes = await inParallel(
      Array.from({ length: 30 }, () => async () => {
        const { wallet, bet } = await withBet();
        const [refund, rollback] = await Promise.all([
          send(cluster.at(0).baseUrl, reversalOf(wallet, 'REFUND', bet)),
          send(cluster.at(1).baseUrl, reversalOf(wallet, 'ROLLBACK', bet)),
        ]);
        const state = await walletState(fixture.database, wallet.walletId);
        return {
          codes: [codeOf(refund), codeOf(rollback)].sort((left, right) => left.localeCompare(right)),
          balance: state.balance,
        };
      }),
      6,
    );
    const distinct = new Set(outcomes.map((outcome) => JSON.stringify(outcome)));
    writeEvidence('RV-CT-01', { iterations: outcomes.length, distinct: [...distinct] });
    expect([...distinct]).toEqual([
      JSON.stringify({ codes: ['PROCESSED', 'REFERENCE_ALREADY_REVERSED'], balance: '100.00' }),
    ]);
  });
});

describe('[CT-11h] reversões concorrentes da mesma referência via HTTP', () => {
  test('[CT-11h] 10 REFUND + 10 ROLLBACK com keys diferentes: 1 aplicada, 19 rejeitadas, um único crédito', async () => {
    for (let iteration = 0; iteration < 5; iteration++) {
      const { wallet, bet } = await withBet();
      const bodies = [
        ...Array.from({ length: 10 }, () => reversalOf(wallet, 'REFUND', bet)),
        ...Array.from({ length: 10 }, () => reversalOf(wallet, 'ROLLBACK', bet)),
      ];
      const responses = await Promise.all(bodies.map((body, index) => send(cluster.at(index).baseUrl, body)));
      const codes = responses.map(codeOf);
      expect(codes.filter((code) => code === 'PROCESSED')).toHaveLength(1);
      expect(
        codes
          .filter((code) => code !== 'PROCESSED')
          .every((code) => code === 'REVERSAL_KIND_ALREADY_USED' || code === 'REFERENCE_ALREADY_REVERSED'),
      ).toBe(true);
      expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '100.00', entries: '3' });
    }
  });
});

describe('[RV-CT-02] replays em massa e keys novas sobre a mesma BET', () => {
  test('[RV-CT-02] 50× a mesma key de ROLLBACK + 10 ROLLBACK + 10 REFUND novos: 1 aplicada e replays idênticos', async () => {
    const { wallet, bet } = await withBet();
    const repeated = reversalOf(wallet, 'ROLLBACK', bet);
    const fresh = [
      ...Array.from({ length: 10 }, () => reversalOf(wallet, 'ROLLBACK', bet)),
      ...Array.from({ length: 10 }, () => reversalOf(wallet, 'REFUND', bet)),
    ];
    const tasks = [
      ...Array.from({ length: 50 }, (_, index) => () => send(cluster.at(index).baseUrl, repeated)),
      ...fresh.map((body, index) => () => send(cluster.at(index + 1).baseUrl, body)),
    ];
    const responses = await Promise.all(tasks.map((task) => task()));
    const repeatedResponses = responses.slice(0, 50);
    expect(new Set(repeatedResponses.map((response) => JSON.stringify(withoutReplayFlag(response.body)))).size).toBe(1);
    expect(repeatedResponses.filter((response) => field(response.body, 'idempotentReplay') === false)).toHaveLength(1);
    const distinctOperations = [repeatedResponses[0], ...responses.slice(50)];
    expect(distinctOperations.filter((response) => response?.status === 200)).toHaveLength(1);
    expect(await walletState(fixture.database, wallet.walletId)).toMatchObject({ balance: '100.00', entries: '3' });
  });
});

describe('[RV-CT-03] corrida entre desfazer o REFUND (u1) e reverter a BET (k2)', () => {
  test('[RV-CT-03] 30 iterações: só as duas ordens possíveis, sempre com crédito líquido 0 ou 10.00', async () => {
    const outcomes = await inParallel(
      Array.from({ length: 30 }, () => async () => {
        const { wallet, bet } = await withBet();
        const refund = reversalOf(wallet, 'REFUND', bet);
        expect((await send(cluster.at(0).baseUrl, refund)).status).toBe(200);
        const [undo, rollback] = await Promise.all([
          send(cluster.at(1).baseUrl, reversalOf(wallet, 'ROLLBACK', refund)),
          send(cluster.at(2).baseUrl, reversalOf(wallet, 'ROLLBACK', bet)),
        ]);
        return {
          undo: codeOf(undo),
          rollback: codeOf(rollback),
          balance: (await walletState(fixture.database, wallet.walletId)).balance,
        };
      }),
      6,
    );
    const allowed = new Set([
      // u1 antes: o REFUND é desfeito e o ROLLBACK da BET passa → crédito líquido 10.00.
      JSON.stringify({ undo: 'PROCESSED', rollback: 'PROCESSED', balance: '100.00' }),
      // k2 antes: o REFUND ainda está em vigor → k2 rejeitado; u1 desfaz o REFUND → crédito líquido 0.
      JSON.stringify({ undo: 'PROCESSED', rollback: 'REFERENCE_ALREADY_REVERSED', balance: '90.00' }),
    ]);
    const seen = new Set(outcomes.map((outcome) => JSON.stringify(outcome)));
    writeEvidence('RV-CT-03', { iterations: outcomes.length, seen: [...seen] });
    for (const outcome of seen) expect(allowed.has(outcome)).toBe(true);
  });
});

describe('[RV-CT-04] barreira do banco sem a checagem da política', () => {
  async function reversalOnBet(client: pg.Client, walletId: string, betId: string, kind: 'REFUND' | 'ROLLBACK') {
    const reversal = await movementInOpenTx(client, walletId, {
      kind: 'WIN',
      kindOverride: kind,
      amount: '10.00',
      direction: 'CREDIT',
      referenceTxId: betId,
      referenceExternalId: 'ct04-bet',
    });
    await client.query(
      `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                    wallet_id, currency, amount, created_at)
       VALUES ($1::uuid, $2, 'CREDIT', $3::uuid, 'BET', 'DEBIT', $4::uuid, 'BRL', 10.00, now())`,
      [reversal.txId, kind, betId, walletId],
    );
  }

  test('[RV-CT-04] duas transações SQL concorrentes revertendo a mesma BET: uma comita, a outra cai no índice', async () => {
    const { walletId, betId } = await withClient(appUrl(fixture.database), async (client) => {
      const opened = await openWalletSql(client, { balance: '100.00' });
      const bet = await movementSql(client, opened.walletId, { kind: 'BET', amount: '10.00', externalId: 'ct04-bet' });
      return { walletId: opened.walletId, betId: bet.txId };
    });
    // Cada transação SQL grava a reversão inteira sem passar pela política (nenhuma consulta à tabela).
    const attempt = (kind: 'REFUND' | 'ROLLBACK') =>
      failureOf(() =>
        withClient(appUrl(fixture.database), async (client) => {
          await client.query('BEGIN');
          try {
            await reversalOnBet(client, walletId, betId, kind);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          }
        }),
      );
    const results = await Promise.all([attempt('REFUND'), attempt('ROLLBACK')]);
    const failures = results.filter((result) => result !== 'ok');
    writeEvidence('RV-CT-04', { results });
    expect(results.filter((result) => result === 'ok')).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(['23505', '40P01', '23514']).toContain(String(failure?.code));
    const effective = await withClient(appUrl(fixture.database), async (client) => {
      const result = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM wager_reversals WHERE target_id = $1::uuid AND undone_by IS NULL',
        [betId],
      );
      return result.rows[0]?.n;
    });
    expect(effective).toBe('1');
  });

  test('[RV-CT-04] mesma reversão por HTTP depois disso é rejeitada pela política', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '100.00');
    const bet = submission(wallet, { amount: '10.00' });
    await send(cluster.next().baseUrl, bet);
    await send(cluster.next().baseUrl, reversalOf(wallet, 'REFUND', bet));
    const second = await submit(
      cluster.next().baseUrl,
      reversalOf(wallet, 'ROLLBACK', bet),
      `rvct04-${Bun.randomUUIDv7()}`,
    );
    expect([second.status, field(second.body, 'code')]).toEqual([422, 'REFERENCE_ALREADY_REVERSED']);
  });
});
