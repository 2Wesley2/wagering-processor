import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appUrl, createTestDatabase, dropTestDatabase, ownerUrl } from '../support/db.ts';
import { decidedWithoutEffectSql, failureOf, inTx, openWalletSql, withClient } from '../support/sql-fixtures.ts';

/**
 * IT-04: imutabilidade em duas camadas (D18). Role da app → sem privilégio
 * (42501). Dono do schema → bloqueado por trigger (23000 + nome).
 */
let database: string;
let walletId: string;
let terminalTxId: string;

beforeAll(async () => {
  database = await createTestDatabase('it04');
  ({ walletId } = await withClient(appUrl(database), (client) => openWalletSql(client, { balance: '50.00' })));
  terminalTxId = await withClient(appUrl(database), (client) =>
    inTx(client, () => decidedWithoutEffectSql(client, walletId, { kind: 'BET', amount: '80.00', status: 'REJECTED' })),
  );
  await withClient(appUrl(database), (client) =>
    client.query(
      `INSERT INTO outbox_messages (id, aggregate_id, message_group_id, event_type, event_version, payload, created_at)
       VALUES ($1::uuid, $2::uuid, $2, 'X', 1, jsonb_build_object('eventId', $1::text, 'eventType', 'X'), now())`,
      [Bun.randomUUIDv7(), walletId],
    ),
  );
});
afterAll(async () => {
  await dropTestDatabase(database);
});

const asApp = (sql: string, parameters: unknown[] = []) =>
  failureOf(() => withClient(appUrl(database), (client) => client.query(sql, parameters)));
const asOwner = (sql: string, parameters: unknown[] = []) =>
  failureOf(() => withClient(ownerUrl(database), (client) => client.query(sql, parameters)));
const denied = { code: '42501', constraint: undefined };

describe('[IT-04] imutabilidade em duas camadas', () => {
  test('[IT-04] role da app: sem privilégio para alterar ledger, identidade, valores e apagar', async () => {
    expect(await asApp('UPDATE wallet_ledger_entries SET amount = amount')).toEqual(denied);
    expect(await asApp('DELETE FROM wallet_ledger_entries')).toEqual(denied);
    expect(await asApp('TRUNCATE wallet_ledger_entries')).toEqual(denied);
    expect(await asApp('UPDATE wallets SET player_id = player_id')).toEqual(denied);
    expect(await asApp('DELETE FROM wallets')).toEqual(denied);
    expect(await asApp('UPDATE wager_transactions SET amount = amount')).toEqual(denied);
    expect(await asApp('UPDATE wager_transactions SET accepted_balance = accepted_balance')).toEqual(denied);
    expect(await asApp('DELETE FROM wager_transactions')).toEqual(denied);
    expect(await asApp('UPDATE outbox_messages SET payload = payload')).toEqual(denied);
    expect(await asApp('DELETE FROM outbox_messages')).toEqual(denied);
    // F4: reversões e prazo das pendências.
    expect(await asApp('DELETE FROM wager_reversals')).toEqual(denied);
    expect(await asApp('UPDATE wager_reversals SET target_id = target_id')).toEqual(denied);
    expect(await asApp('UPDATE wager_transactions SET pending_deadline_at = pending_deadline_at')).toEqual(denied);
  });

  test('[IT-04] dono do schema: triggers bloqueiam mesmo com privilégio', async () => {
    const immutable = { code: '23000', constraint: 'ledger_immutable' };
    expect(await asOwner('UPDATE wallet_ledger_entries SET created_at = now()')).toEqual(immutable);
    expect(await asOwner('DELETE FROM wallet_ledger_entries')).toEqual(immutable);
    // Desde a F4 a tabela de reversões referencia o ledger: o TRUNCATE simples já é barrado pela FK
    // (0A000) e o TRUNCATE em cascata, pelos triggers das duas tabelas.
    expect(await asOwner('TRUNCATE wallet_ledger_entries')).toEqual({ code: '0A000', constraint: undefined });
    const cascade = await asOwner('TRUNCATE wallet_ledger_entries CASCADE');
    expect(cascade === 'ok' ? 'ok' : cascade.code).toBe('23000');
    expect(cascade === 'ok' ? undefined : cascade.constraint).toMatch(/^(ledger|rev)_immutable$/);
    expect(
      await asOwner('UPDATE wallets SET player_id = $1::uuid WHERE id = $2::uuid', [Bun.randomUUIDv7(), walletId]),
    ).toEqual({
      code: '23000',
      constraint: 'wallets_identity_immutable',
    });
    expect(await asOwner('DELETE FROM wallets WHERE id = $1::uuid', [walletId])).toEqual({
      code: '23000',
      constraint: 'wallets_no_delete',
    });
    expect(await asOwner('UPDATE wallets SET balance = balance + 1.00 WHERE id = $1::uuid', [walletId])).toEqual({
      code: '23514',
      constraint: 'wallets_version_step_ck',
    });
    expect(await asOwner('UPDATE wallets SET version = version + 1 WHERE id = $1::uuid', [walletId])).toEqual({
      code: '23514',
      constraint: 'wallets_version_step_ck',
    });
    expect(await asOwner('DELETE FROM wager_transactions WHERE id = $1::uuid', [terminalTxId])).toEqual({
      code: '23000',
      constraint: 'wtx_immutable',
    });
  });

  test('[IT-04] transação terminal é imutável também para o role da app (que tem UPDATE em status)', async () => {
    const terminal = { code: '23000', constraint: 'wtx_immutable' };
    expect(
      await asApp(`UPDATE wager_transactions SET status = 'PROCESSED', failure_code = NULL WHERE id = $1::uuid`, [
        terminalTxId,
      ]),
    ).toEqual(terminal);
    expect(
      await asOwner(`UPDATE wager_transactions SET failure_code = 'BALANCE_LIMIT_EXCEEDED' WHERE id = $1::uuid`, [
        terminalTxId,
      ]),
    ).toEqual(terminal);
  });

  test('[IT-04] outbox: payload imutável; published_at só vai de NULL para um valor', async () => {
    expect(await asApp('UPDATE outbox_messages SET published_at = now()')).toBe('ok');
    expect(await asApp(`UPDATE outbox_messages SET published_at = now() + interval '1 hour'`)).toEqual({
      code: '23000',
      constraint: 'outbox_immutable',
    });
    expect(await asOwner(`UPDATE outbox_messages SET payload = '{}'::jsonb`)).toEqual({
      code: '23000',
      constraint: 'outbox_immutable',
    });
  });
});
