import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appUrl, createTestDatabase, dropTestDatabase } from '../support/db.ts';
import { decidedWithoutEffectSql, failureOf, HASH, inTx, openWalletSql, withClient } from '../support/sql-fixtures.ts';

/**
 * IT-03: matriz de constraints por SQL direto, conectado como o role da app.
 * Cada caso confere SQLSTATE e NOME da constraint. Os dados são preparados em
 * SQL; nada aqui exercita o caso de uso de submissão (F3).
 */
let database: string;
let url: string;

beforeAll(async () => {
  database = await createTestDatabase('it03');
  url = appUrl(database);
});
afterAll(async () => {
  await dropTestDatabase(database);
});

const rejected = (
  walletId: string,
  options: { key?: string; providerId?: string; externalId?: string; kind?: 'BET' | 'WIN' | 'LOSS' } = {},
) =>
  withClient(url, (client) =>
    inTx(client, () =>
      decidedWithoutEffectSql(client, walletId, {
        kind: options.kind ?? 'BET',
        amount: '10.00',
        status: 'REJECTED',
        ...options,
      }),
    ),
  );

describe('[IT-03] constraints do schema', () => {
  test('[IT-03] wallets: saldo negativo, versão, unicidade (player, moeda) e escala do dinheiro', async () => {
    const { playerId } = await withClient(url, (client) => openWalletSql(client));
    const insert = (balance: string, player = Bun.randomUUIDv7(), version = 1) =>
      withClient(url, (client) =>
        client.query(
          `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'BRL', $3::numeric, $4, now(), now())`,
          [Bun.randomUUIDv7(), player, balance, version],
        ),
      );
    expect(await failureOf(() => insert('-0.01'))).toEqual({ code: '23514', constraint: 'wallets_balance_nonneg_ck' });
    expect(await failureOf(() => insert('0.00', Bun.randomUUIDv7(), 0))).toEqual({
      code: '23514',
      constraint: 'wallets_version_ck',
    });
    expect(await failureOf(() => insert('0.00', playerId))).toEqual({
      code: '23505',
      constraint: 'wallets_player_currency_uq',
    });
    // Escala ≠ 2 e limite: o DOMAIN recusa; nada é arredondado.
    expect(await failureOf(() => insert('10.5'))).toEqual({ code: '23514', constraint: 'money_amount_ck' });
    expect(await failureOf(() => insert('10.005'))).toEqual({ code: '23514', constraint: 'money_amount_ck' });
    expect(await failureOf(() => insert('1000000000000000.00'))).toEqual({
      code: '23514',
      constraint: 'money_amount_ck',
    });
    const max = await withClient(
      url,
      async (client) =>
        (await client.query<{ v: string }>("SELECT '999999999999999.99'::money_amount::text AS v")).rows[0]?.v,
    );
    expect(max).toBe('999999999999999.99');
  });

  test('[IT-03] transações: kind × referência, status PENDING, OPENING interna, valor, failure_code', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    const raw = (patch: Record<string, string | null>) =>
      withClient(url, (client) =>
        client.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, currency, amount, reference_external_transaction_id, status, failure_code, initial_status,
             accepted_balance, accepted_wallet_version, accepted_at, result_balance, result_wallet_version, decided_at, available_at,
             correlation_id, created_at)
           SELECT $1::uuid, $2, $3, $4, $5, w.id, w.player_id, 'r', 'g', $6, 'BRL', $7::numeric, $8, $9, $10, $11,
                  w.balance, w.version, now(), w.balance, w.version, now(), now(), 'c', now()
             FROM wallets w WHERE w.id = $12::uuid`,
          [
            Bun.randomUUIDv7(),
            patch['provider'] ?? 'provider-a',
            patch['ext'] ?? `e-${Bun.randomUUIDv7()}`,
            patch['key'] ?? `k-${Bun.randomUUIDv7()}`,
            HASH,
            patch['kind'] ?? 'BET',
            patch['amount'] ?? '10.00',
            patch['ref'] ?? null,
            patch['status'] ?? 'REJECTED',
            patch['failure'] === undefined ? 'INSUFFICIENT_FUNDS' : patch['failure'],
            patch['initial'] ?? 'REJECTED',
            walletId,
          ],
        ),
      );
    expect(await failureOf(() => raw({ kind: 'BET', ref: 'x' }))).toEqual({
      code: '23514',
      constraint: 'wtx_reference_by_kind_ck',
    });
    expect(await failureOf(() => raw({ kind: 'REFUND' }))).toEqual({
      code: '23514',
      constraint: 'wtx_reference_by_kind_ck',
    });
    expect(await failureOf(() => raw({ kind: 'ROLLBACK' }))).toEqual({
      code: '23514',
      constraint: 'wtx_reference_by_kind_ck',
    });
    expect(await failureOf(() => raw({ kind: 'JACKPOT' }))).toEqual({ code: '23514', constraint: 'wtx_kind_ck' });
    expect(await failureOf(() => raw({ status: 'PENDING', failure: null, initial: 'PENDING_REFERENCE' }))).toEqual({
      code: '23514',
      constraint: 'wtx_status_ck',
    });
    expect(await failureOf(() => raw({ kind: 'OPENING' }))).toEqual({
      code: '23514',
      constraint: 'wtx_opening_provider_ck',
    });
    expect(await failureOf(() => raw({ provider: '__internal__' }))).toEqual({
      code: '23514',
      constraint: 'wtx_opening_provider_ck',
    });
    expect(await failureOf(() => raw({ amount: '0.00' }))).toEqual({ code: '23514', constraint: 'wtx_amount_ck' });
    expect(await failureOf(() => raw({ kind: 'LOSS', amount: '0.00' }))).toBe('ok');
    expect(await failureOf(() => raw({ failure: null }))).toEqual({ code: '23514', constraint: 'wtx_failure_code_ck' });
    expect(await failureOf(() => raw({ ext: 'same', ref: 'same', kind: 'WIN' }))).toEqual({
      code: '23514',
      constraint: 'wtx_self_reference_ck',
    });
  });

  test('[IT-03] ledger: aritmética, gênese, valor positivo e uma entrada por (wallet, versão)', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client, { balance: '100.00' }));
    const ledger = (direction: string, amount: string, before: string, after: string, version: number) =>
      withClient(url, (client) =>
        client.query(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
           SELECT $1::uuid, $2::uuid, t.id, 'BRL', $3, $4::numeric, $5::numeric, $6::numeric, $7, now()
             FROM wager_transactions t WHERE t.wallet_id = $2::uuid AND t.kind = 'OPENING'`,
          [Bun.randomUUIDv7(), walletId, direction, amount, before, after, version],
        ),
      );
    expect(await failureOf(() => ledger('CREDIT', '100.00', '100.00', '200.01', 2))).toEqual({
      code: '23514',
      constraint: 'ledger_arithmetic_ck',
    });
    expect(await failureOf(() => ledger('DEBIT', '0.00', '100.00', '100.00', 2))).toEqual({
      code: '23514',
      constraint: 'ledger_amount_positive_ck',
    });
    expect(await failureOf(() => ledger('DEBIT', '150.00', '100.00', '-50.00', 2))).toEqual({
      code: '23514',
      constraint: 'ledger_balances_nonneg_ck',
    });
    expect(await failureOf(() => ledger('DEBIT', '100.00', '100.00', '0.00', 1))).toEqual({
      code: '23514',
      constraint: 'ledger_genesis_ck',
    });
    expect(await failureOf(() => ledger('CREDIT', '100.00', '100.00', '200.00', 2))).toEqual({
      code: '23505',
      constraint: 'ledger_tx_wallet_uq',
    });
  });

  test('[IT-03] uma OPENING por wallet', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client, { balance: '5.00' }));
    const second = await failureOf(() =>
      withClient(url, (client) =>
        client.query(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, currency, amount, status, initial_status, accepted_balance, accepted_wallet_version, accepted_at,
             result_balance, result_wallet_version, decided_at, available_at, correlation_id, created_at)
           SELECT $1::uuid, '__internal__', 'opening-2', 'internal:opening-2:' || w.id, $2, w.id, w.player_id, 'opening', 'internal',
                  'OPENING', 'BRL', 5.00, 'PROCESSED', 'PROCESSED', 5.00, 1, now(), 5.00, 1, now(), now(), 'c', now()
             FROM wallets w WHERE w.id = $3::uuid`,
          [Bun.randomUUIDv7(), HASH, walletId],
        ),
      ),
    );
    expect(second).toEqual({ code: '23505', constraint: 'wtx_one_opening_per_wallet_uq' });
  });
});

describe('[IT-03] Idempotency-Key no schema: unicidade GLOBAL e comparação byte a byte (decisão I2)', () => {
  // Teste de schema. O replay/409 pela API HTTP é do IT-10a (F3) e NÃO é coberto aqui.
  test('[IT-03] a mesma key é recusada mesmo vinda de outro provedor (escopo global)', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    expect(await rejected(walletId, { key: 'shared-key-1', providerId: 'provider-a' }).then(() => 'ok')).toBe('ok');
    expect(await failureOf(() => rejected(walletId, { key: 'shared-key-1', providerId: 'provider-b' }))).toEqual({
      code: '23505',
      constraint: 'wtx_idempotency_key_uq',
    });
    expect(await failureOf(() => rejected(walletId, { key: 'shared-key-1', providerId: 'provider-a' }))).toEqual({
      code: '23505',
      constraint: 'wtx_idempotency_key_uq',
    });
  });

  test('[IT-03] o formato recomendado {providerId}:{externalTransactionId} não é obrigatório', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    expect(
      await rejected(walletId, {
        key: 'opaque-key-without-provider',
        providerId: 'provider-a',
        externalId: 'x-1',
      }).then(() => 'ok'),
    ).toBe('ok');
    expect(
      await rejected(walletId, { key: 'provider-b:x-1', providerId: 'provider-a', externalId: 'x-2' }).then(() => 'ok'),
    ).toBe('ok');
  });

  test('[IT-03] comparação byte a byte: caixa e caracteres diferentes são keys distintas', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    for (const key of ['Key-Byte-1', 'key-byte-1', 'KEY-BYTE-1', 'key-byte-1:', 'key_byte_1']) {
      expect({ key, result: await rejected(walletId, { key }).then(() => 'ok') }).toEqual({ key, result: 'ok' });
    }
    expect(await failureOf(() => rejected(walletId, { key: 'key-byte-1' }))).toEqual({
      code: '23505',
      constraint: 'wtx_idempotency_key_uq',
    });
    const stored = await withClient(
      url,
      async (client) =>
        (
          await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM wager_transactions WHERE lower(idempotency_key) = 'key-byte-1'`,
          )
        ).rows[0]?.n,
    );
    expect(stored).toBe('3');
  });

  test('[IT-03] o banco recusa key fora do formato (espaço, vazia, não ASCII, > 255)', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    for (const key of ['has space', '', 'chave-é', 'x'.repeat(256), 'tab\tkey']) {
      expect({ key: key.slice(0, 12), r: await failureOf(() => rejected(walletId, { key })) }).toEqual({
        key: key.slice(0, 12),
        r: { code: '23514', constraint: 'wtx_idempotency_key_format_ck' },
      });
    }
    expect(await rejected(walletId, { key: 'x'.repeat(255) }).then(() => 'ok')).toBe('ok');
  });

  test('[IT-03] (provider, externalTransactionId) é único independentemente da key', async () => {
    const { walletId } = await withClient(url, (client) => openWalletSql(client));
    await rejected(walletId, { key: 'k-ext-1', providerId: 'provider-a', externalId: 'ext-dup' });
    expect(
      await failureOf(() => rejected(walletId, { key: 'k-ext-2', providerId: 'provider-a', externalId: 'ext-dup' })),
    ).toEqual({
      code: '23505',
      constraint: 'wtx_provider_external_uq',
    });
    expect(
      await rejected(walletId, { key: 'k-ext-3', providerId: 'provider-b', externalId: 'ext-dup' }).then(() => 'ok'),
    ).toBe('ok');
  });
});
