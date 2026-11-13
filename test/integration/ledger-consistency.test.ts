import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { appUrl, createTestDatabase, dropTestDatabase } from '../support/db.ts';
import {
  decidedWithoutEffectSql,
  failureOf,
  HASH,
  inTx,
  movementInOpenTx,
  movementSql,
  openWalletSql,
  withClient,
} from '../support/sql-fixtures.ts';

/**
 * IT-05: consistência saldo ↔ ledger ↔ transação imposta pelo banco (D17), com
 * valores fixos escritos à mão. TODOS os cenários usam dados preparados em SQL:
 * provam o que o schema aceita e recusa. O cenário (ii) reproduz o formato de um
 * lote de decisões, mas NÃO é o worker de pendências (IT-26, F4).
 */
let database: string;
let url: string;

beforeAll(async () => {
  database = await createTestDatabase('it05');
  url = appUrl(database);
});
afterAll(async () => {
  await dropTestDatabase(database);
});

async function walletState(client: pg.Client, walletId: string): Promise<[string, string]> {
  const result = await client.query<{ b: string; v: string }>(
    'SELECT balance::text AS b, version::text AS v FROM wallets WHERE id = $1::uuid',
    [walletId],
  );
  return [result.rows[0]?.b ?? '?', result.rows[0]?.v ?? '?'];
}

async function snapshot(client: pg.Client, txId: string): Promise<Record<string, string | null>> {
  const result = await client.query<Record<string, string | null>>(
    `SELECT status, failure_code, accepted_balance::text AS accepted_balance, accepted_wallet_version::text AS accepted_version,
            result_balance::text AS result_balance, result_wallet_version::text AS result_version
       FROM wager_transactions WHERE id = $1::uuid`,
    [txId],
  );
  return result.rows[0] ?? {};
}

describe('[IT-05] consistência diferida saldo ↔ ledger ↔ transação', () => {
  test('[IT-05] (i) wallet aberta com 0.00: rejeição com snapshot (0.00, v1); primeiro crédito vira v2 com before 0.00', async () => {
    await withClient(url, async (client) => {
      const { walletId } = await openWalletSql(client);
      const bet = await inTx(client, () =>
        decidedWithoutEffectSql(client, walletId, { kind: 'BET', amount: '10.00', status: 'REJECTED' }),
      );
      expect(await snapshot(client, bet)).toEqual({
        status: 'REJECTED',
        failure_code: 'INSUFFICIENT_FUNDS',
        accepted_balance: '0.00',
        accepted_version: '1',
        result_balance: '0.00',
        result_version: '1',
      });
      const win = await movementSql(client, walletId, { kind: 'WIN', amount: '50.00' });
      const entry = await client.query<{ b: string; a: string; v: string }>(
        `SELECT balance_before::text AS b, balance_after::text AS a, wallet_version::text AS v FROM wallet_ledger_entries WHERE transaction_id = $1::uuid`,
        [win.txId],
      );
      expect(entry.rows).toEqual([{ b: '0.00', a: '50.00', v: '2' }]);
      expect(await walletState(client, walletId)).toEqual(['50.00', '2']);
      const sum = await client.query<{ s: string; n: string }>(
        `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS s, count(*)::text AS n
           FROM wallet_ledger_entries WHERE wallet_id = $1::uuid`,
        [walletId],
      );
      expect(sum.rows[0]).toEqual({ s: '50.00', n: '1' });
    });
  });

  test('[IT-05] (ii) várias decisões numa mesma transação SQL: cada snapshot é o estado daquele ponto (dados em SQL; não é o worker)', async () => {
    await withClient(url, async (client) => {
      const { walletId } = await openWalletSql(client, { balance: '100.00' });
      const pendingIds: Record<string, string> = {};
      // Pendências aceitas com a wallet em (100.00, v1), nesta ordem: r1, k3, k2.
      for (const [name, kind, amount, referenceExternalId] of [
        ['r1', 'REFUND', '10.00', 'b1'],
        ['k3', 'ROLLBACK', '7.00', 'b3'],
        ['k2', 'ROLLBACK', '20.00', 'b2'],
      ] as const) {
        const id = Bun.randomUUIDv7();
        pendingIds[name] = id;
        // Transação e agenda na mesma transação SQL (a checagem diferida exige as duas no COMMIT).
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, currency, amount, reference_external_transaction_id, status, initial_status,
             accepted_balance, accepted_wallet_version, accepted_at, pending_deadline_at, correlation_id, created_at)
           SELECT $1::uuid, 'provider-a', $2, 'provider-a:' || $2, $3, w.id, w.player_id, 'round-1', 'game-1', $4, 'BRL', $5::numeric, $6,
                  'PENDING_REFERENCE', 'PENDING_REFERENCE', w.balance, w.version, statement_timestamp(),
                  statement_timestamp() + interval '30 minutes', 'sql-fixture', now()
             FROM wallets w WHERE w.id = $7::uuid`,
          [id, name, HASH, kind, amount, referenceExternalId, walletId],
        );
        await client.query(
          `INSERT INTO pending_reference_checks (transaction_id, wallet_id, next_check_at, created_at)
           VALUES ($1::uuid, $2::uuid, now(), now())`,
          [id, walletId],
        );
        await client.query('COMMIT');
      }
      const b1 = await movementSql(client, walletId, { kind: 'BET', amount: '10.00', externalId: 'b1' });
      const b2 = await movementSql(client, walletId, { kind: 'BET', amount: '20.00', externalId: 'b2' });
      await movementSql(client, walletId, { kind: 'BET', amount: '5.00', externalId: 'b3' });
      expect(await walletState(client, walletId)).toEqual(['65.00', '4']);

      await inTx(client, async () => {
        await resolve(client, walletId, pendingIds['r1'] ?? '', b1.txId, 'CREDIT', '10.00');
        await client.query(
          `UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'REFERENCE_AMOUNT_MISMATCH',
                  result_balance = w.balance, result_wallet_version = w.version, decided_at = statement_timestamp(), available_at = statement_timestamp()
             FROM wallets w WHERE w.id = $2::uuid AND wager_transactions.id = $1::uuid`,
          [pendingIds['k3'], walletId],
        );
        await client.query('DELETE FROM pending_reference_checks WHERE transaction_id = $1::uuid', [pendingIds['k3']]);
        await resolve(client, walletId, pendingIds['k2'] ?? '', b2.txId, 'CREDIT', '20.00');
      });

      expect(await snapshot(client, pendingIds['r1'] ?? '')).toMatchObject({
        status: 'PROCESSED',
        result_balance: '75.00',
        result_version: '5',
      });
      expect(await snapshot(client, pendingIds['k3'] ?? '')).toMatchObject({
        status: 'REJECTED',
        failure_code: 'REFERENCE_AMOUNT_MISMATCH',
        accepted_balance: '100.00',
        accepted_version: '1',
        result_balance: '75.00',
        result_version: '5',
      });
      expect(await snapshot(client, pendingIds['k2'] ?? '')).toMatchObject({
        status: 'PROCESSED',
        result_balance: '95.00',
        result_version: '6',
      });
      await movementSql(client, walletId, { kind: 'BET', amount: '5.00' });
      expect(await walletState(client, walletId)).toEqual(['90.00', '7']);
      // Operação posterior não altera snapshot já gravado.
      expect(await snapshot(client, pendingIds['k3'] ?? '')).toMatchObject({
        result_balance: '75.00',
        result_version: '5',
      });
    });
  });

  test('[IT-05] (iii) caminhos inválidos falham no COMMIT (ou antes)', async () => {
    await withClient(url, async (client) => {
      const { walletId } = await openWalletSql(client, { balance: '100.00' });

      // Saldo alterado sem lançamento.
      expect(
        await failureOf(() =>
          inTx(client, () =>
            client.query('UPDATE wallets SET balance = balance - 1.00, version = version + 1 WHERE id = $1::uuid', [
              walletId,
            ]),
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'wallet_ledger_head_ck' });

      // LOSS com lançamento.
      expect(
        await failureOf(() =>
          inTx(client, () => movementInOpenTx(client, walletId, { kind: 'LOSS', amount: '5.00', direction: 'DEBIT' })),
        ),
      ).toEqual({ code: '23514', constraint: 'wtx_ledger_effect_ck' });

      // REJECTED com lançamento.
      expect(
        await failureOf(() =>
          inTx(client, async () => {
            const txId = await decidedWithoutEffectSql(client, walletId, {
              kind: 'BET',
              amount: '5.00',
              status: 'REJECTED',
            });
            await client.query(
              'UPDATE wallets SET balance = balance - 5.00, version = version + 1 WHERE id = $1::uuid',
              [walletId],
            );
            await client.query(
              `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'BRL', 'DEBIT', 5.00, 100.00, 95.00, 2, now())`,
              [Bun.randomUUIDv7(), walletId, txId],
            );
          }),
        ),
      ).toEqual({ code: '23514', constraint: 'wtx_ledger_effect_ck' });

      // Snapshot fora da cadeia: (55.55, v1) nunca foi estado da wallet.
      expect(
        await failureOf(() =>
          inTx(client, () =>
            client.query(
              `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                 round_id, game_id, kind, currency, amount, status, failure_code, initial_status, accepted_balance, accepted_wallet_version,
                 accepted_at, result_balance, result_wallet_version, decided_at, available_at, correlation_id, created_at)
               SELECT $1::uuid, 'provider-a', 'snap-x', 'snap-x', $2, w.id, w.player_id, 'r', 'g', 'BET', 'BRL', 200.00, 'REJECTED',
                      'INSUFFICIENT_FUNDS', 'REJECTED', 55.55, 1, now(), 55.55, 1, now(), now(), 'c', now()
                 FROM wallets w WHERE w.id = $3::uuid`,
              [Bun.randomUUIDv7(), HASH, walletId],
            ),
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'wtx_snapshot_chain_ck' });

      // v2 com before ≠ 0.00 numa wallet aberta sem OPENING: barrado já no INSERT.
      const zero = await openWalletSql(client);
      expect(
        await failureOf(() =>
          inTx(client, async () => {
            const txId = Bun.randomUUIDv7();
            await client.query(
              `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                 round_id, game_id, kind, currency, amount, status, initial_status, accepted_balance, accepted_wallet_version, accepted_at,
                 result_balance, result_wallet_version, decided_at, available_at, correlation_id, created_at)
               SELECT $1::uuid, 'provider-a', 'v2-x', 'v2-x', $2, w.id, w.player_id, 'r', 'g', 'WIN', 'BRL', 50.00, 'PROCESSED', 'PROCESSED',
                      60.00, 2, now(), 60.00, 2, now(), now(), 'c', now()
                 FROM wallets w WHERE w.id = $3::uuid`,
              [txId, HASH, zero.walletId],
            );
            await client.query(
              `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
               VALUES ($1::uuid, $2::uuid, $3::uuid, 'BRL', 'CREDIT', 50.00, 10.00, 60.00, 2, now())`,
              [Bun.randomUUIDv7(), zero.walletId, txId],
            );
          }),
        ),
      ).toEqual({ code: '23514', constraint: 'ledger_chain_ck' });

      // Nada do que falhou ficou gravado.
      expect(await walletState(client, walletId)).toEqual(['100.00', '1']);
    });
  });
});

/** Resolve uma pendência como PROCESSED com lançamento, dentro da transação aberta. */
async function resolve(
  client: pg.Client,
  walletId: string,
  txId: string,
  refId: string,
  direction: 'CREDIT' | 'DEBIT',
  amount: string,
): Promise<void> {
  const lockedWallet = await client.query<{ after: string; v: string; before: string }>(
    `SELECT (CASE WHEN $2 = 'CREDIT' THEN balance + $3::numeric ELSE balance - $3::numeric END)::text AS after,
            version::text AS v, balance::text AS before
       FROM wallets WHERE id = $1::uuid FOR UPDATE`,
    [walletId, direction, amount],
  );
  const row = lockedWallet.rows[0];
  if (row === undefined) throw new Error('wallet inexistente');
  await client.query(
    `UPDATE wager_transactions SET status = 'PROCESSED', reference_transaction_id = $2::uuid, result_balance = $3::numeric,
            result_wallet_version = $4::bigint + 1, decided_at = statement_timestamp(), available_at = statement_timestamp()
      WHERE id = $1::uuid`,
    [txId, refId, row.after, row.v],
  );
  await client.query(
    'UPDATE wallets SET balance = $2::numeric, version = version + 1, updated_at = now() WHERE id = $1::uuid',
    [walletId, row.after],
  );
  await client.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'BRL', $4, $5::numeric, $6::numeric, $7::numeric, $8::bigint + 1, now())`,
    [Bun.randomUUIDv7(), walletId, txId, direction, amount, row.before, row.after, row.v],
  );
  // Schema da F4 (P1 = C): toda reversão aplicada tem sua linha; a pendência sai da agenda.
  await client.query(
    `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                  wallet_id, currency, amount, created_at)
     SELECT t.id, t.kind, $3, r.id, r.kind, 'DEBIT', t.wallet_id, t.currency, t.amount, now()
       FROM wager_transactions t JOIN wager_transactions r ON r.id = $2::uuid WHERE t.id = $1::uuid`,
    [txId, refId, direction],
  );
  await client.query('DELETE FROM pending_reference_checks WHERE transaction_id = $1::uuid', [txId]);
}
