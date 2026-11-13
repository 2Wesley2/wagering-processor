/**
 * Dados preparados DIRETAMENTE EM SQL para os testes de schema da F2.
 * NÃO exercitam o caso de uso de submissão (F3) nem o worker de pendências (F4):
 * servem para provar o que o banco aceita e recusa. Toda aritmética de saldo é
 * feita pelo PostgreSQL (numeric), nunca em JavaScript.
 */
import pg from 'pg';

export const HASH = `v1:${'0'.repeat(64)}`;

export async function withClient<T>(url: string, work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url, application_name: 'wagering:test-fixture' });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** BEGIN … COMMIT; ROLLBACK em erro (o erro sobe com o SQLSTATE original). */
export async function inTx<T>(client: pg.Client, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface PgFailure {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/** Executa e devolve o SQLSTATE e a constraint do erro (ou 'ok'). */
export async function failureOf(work: () => Promise<unknown>): Promise<PgFailure | 'ok'> {
  try {
    await work();
    return 'ok';
  } catch (error) {
    if (typeof error !== 'object' || error === null) return { code: undefined, constraint: undefined };
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    const constraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined;
    return { code, constraint };
  }
}

/** Wallet aberta em SQL: 0.00 sem lançamento, ou saldo > 0 com OPENING + CREDIT v1. */
export async function openWalletSql(
  client: pg.Client,
  options: { balance?: string; currency?: string; playerId?: string } = {},
): Promise<{ walletId: string; playerId: string }> {
  const walletId = Bun.randomUUIDv7();
  const playerId = options.playerId ?? Bun.randomUUIDv7();
  const currency = options.currency ?? 'BRL';
  const balance = options.balance ?? '0.00';
  await inTx(client, async () => {
    await client.query(
      `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4::numeric, 1, now(), now())`,
      [walletId, playerId, currency, balance],
    );
    const positive = await client.query<{ p: boolean }>('SELECT $1::numeric > 0 AS p', [balance]);
    if (positive.rows[0]?.p === true) {
      const txId = Bun.randomUUIDv7();
      await client.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, currency, amount, status, initial_status, accepted_balance, accepted_wallet_version, accepted_at,
           result_balance, result_wallet_version, decided_at, available_at, correlation_id, created_at)
         VALUES ($1::uuid, '__internal__', 'opening:' || $2, 'internal:opening:' || $2, $3, $2::uuid, $4::uuid,
           'opening', 'internal', 'OPENING', $5, $6::numeric, 'PROCESSED', 'PROCESSED', $6::numeric, 1, statement_timestamp(),
           $6::numeric, 1, statement_timestamp(), statement_timestamp(), 'sql-fixture', now())`,
        [txId, walletId, HASH, playerId, currency, balance],
      );
      await client.query(
        `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'CREDIT', $5::numeric, 0.00, $5::numeric, 1, now())`,
        [Bun.randomUUIDv7(), walletId, txId, currency, balance],
      );
    }
  });
  return { walletId, playerId };
}

export interface TxSpec {
  readonly kind: 'BET' | 'WIN' | 'LOSS';
  readonly amount: string;
  readonly externalId?: string;
  readonly key?: string;
  readonly providerId?: string;
  readonly roundId?: string;
}

/** BET/WIN PROCESSED pelo caminho completo (tx + wallet + lançamento) em uma transação SQL. */
export async function movementSql(
  client: pg.Client,
  walletId: string,
  spec: TxSpec,
): Promise<{ txId: string; balance: string; version: string }> {
  return inTx(client, () => movementInOpenTx(client, walletId, spec));
}

/** Mesmo caminho, sem BEGIN/COMMIT: para compor várias decisões numa só transação. */
export async function movementInOpenTx(
  client: pg.Client,
  walletId: string,
  spec: TxSpec & {
    kindOverride?: 'REFUND' | 'ROLLBACK';
    referenceTxId?: string;
    referenceExternalId?: string;
    direction?: 'DEBIT' | 'CREDIT';
  },
): Promise<{ txId: string; balance: string; version: string }> {
  const kind = spec.kindOverride ?? spec.kind;
  const direction = spec.direction ?? (spec.kind === 'BET' ? 'DEBIT' : 'CREDIT');
  const externalId = spec.externalId ?? `ext-${Bun.randomUUIDv7()}`;
  const locked = await client.query<{ player_id: string; currency: string; version: string; after: string }>(
    `SELECT player_id, currency, version::text,
            (CASE WHEN $2 = 'DEBIT' THEN balance - $3::numeric ELSE balance + $3::numeric END)::text AS after
       FROM wallets WHERE id = $1::uuid FOR UPDATE`,
    [walletId, direction, spec.amount],
  );
  const lockedWallet = locked.rows[0];
  if (lockedWallet === undefined) throw new Error('wallet inexistente');
  const txId = Bun.randomUUIDv7();
  await client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, currency, amount, reference_external_transaction_id, reference_transaction_id, status, initial_status,
       accepted_balance, accepted_wallet_version, accepted_at, result_balance, result_wallet_version, decided_at, available_at,
       correlation_id, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid, $8, 'game-1', $9, $10, $11::numeric, $12, $13::uuid, 'PROCESSED', 'PROCESSED',
       $14::numeric, $15::bigint + 1, statement_timestamp(), $14::numeric, $15::bigint + 1, statement_timestamp(), statement_timestamp(),
       'sql-fixture', now())`,
    [
      txId,
      spec.providerId ?? 'provider-a',
      externalId,
      spec.key ?? `provider-a:${externalId}`,
      HASH,
      walletId,
      lockedWallet.player_id,
      spec.roundId ?? 'round-1',
      kind,
      lockedWallet.currency,
      spec.amount,
      spec.referenceExternalId ?? null,
      spec.referenceTxId ?? null,
      lockedWallet.after,
      lockedWallet.version,
    ],
  );
  await client.query(
    `UPDATE wallets SET balance = $2::numeric, version = version + 1, updated_at = now() WHERE id = $1::uuid`,
    [walletId, lockedWallet.after],
  );
  await client.query(
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, currency, direction, amount, balance_before, balance_after, wallet_version, created_at)
     SELECT $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7::numeric - CASE WHEN $5 = 'DEBIT' THEN -$6::numeric ELSE $6::numeric END,
            $7::numeric, $8::bigint + 1, now()`,
    [
      Bun.randomUUIDv7(),
      walletId,
      txId,
      lockedWallet.currency,
      direction,
      spec.amount,
      lockedWallet.after,
      lockedWallet.version,
    ],
  );
  return { txId, balance: lockedWallet.after, version: String(Number.parseInt(lockedWallet.version, 10) + 1) };
}

/** Transação terminal sem lançamento (REJECTED, ou LOSS PROCESSED), com snapshot = estado atual da wallet. */
export async function decidedWithoutEffectSql(
  client: pg.Client,
  walletId: string,
  spec: TxSpec & { status: 'REJECTED' | 'PROCESSED'; failureCode?: string },
): Promise<string> {
  const txId = Bun.randomUUIDv7();
  const externalId = spec.externalId ?? `ext-${Bun.randomUUIDv7()}`;
  await client.query(
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, currency, amount, status, failure_code, initial_status, accepted_balance, accepted_wallet_version,
       accepted_at, result_balance, result_wallet_version, decided_at, available_at, correlation_id, created_at)
     SELECT $1::uuid, $2, $3, $4, $5, w.id, w.player_id, $6, 'game-1', $7, w.currency, $8::numeric, $9, $10, $9,
            w.balance, w.version, statement_timestamp(), w.balance, w.version, statement_timestamp(), statement_timestamp(), 'sql-fixture', now()
       FROM wallets w WHERE w.id = $11::uuid`,
    [
      txId,
      spec.providerId ?? 'provider-a',
      externalId,
      spec.key ?? `provider-a:${externalId}`,
      HASH,
      spec.roundId ?? 'round-1',
      spec.kind,
      spec.amount,
      spec.status,
      spec.status === 'REJECTED' ? (spec.failureCode ?? 'INSUFFICIENT_FUNDS') : null,
      walletId,
    ],
  );
  return txId;
}
