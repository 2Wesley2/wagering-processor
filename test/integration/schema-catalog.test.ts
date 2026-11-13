import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, dropTestDatabase, ownerUrl } from '../support/db.ts';
import { withClient } from '../support/sql-fixtures.ts';

/** QG-04: o schema é verificado por NOME (constraints, índices, triggers, tipos, privilégios). */
let database: string;

beforeAll(async () => {
  database = await createTestDatabase('qg04');
});
afterAll(async () => {
  await dropTestDatabase(database);
});

const queryRows = <T extends Record<string, unknown>>(sql: string, parameters: unknown[] = []) =>
  withClient(ownerUrl(database), async (client) => (await client.query<T>(sql, parameters)).rows);

const EXPECTED_CONSTRAINTS: Record<string, string[]> = {
  wallets: [
    'wallets_balance_nonneg_ck',
    'wallets_id_currency_uq',
    'wallets_identity_uq',
    'wallets_player_currency_uq',
    'wallets_version_ck',
  ],
  wager_transactions: [
    'wtx_accept_seq_uq',
    'wtx_amount_ck',
    'wtx_failure_code_ck',
    'wtx_idempotency_key_format_ck',
    'wtx_idempotency_key_uq',
    'wtx_initial_consistency_ck',
    'wtx_initial_status_ck',
    'wtx_key5_uq',
    'wtx_kind_ck',
    'wtx_ledger_target_uq',
    'wtx_opening_provider_ck',
    'wtx_provider_external_uq',
    'wtx_ref_link_uq',
    'wtx_reference_by_kind_ck',
    'wtx_reference_fk',
    'wtx_reference_id_ck',
    'wtx_result_presence_ck',
    'wtx_reversal_reference_ck',
    'wtx_self_reference_ck',
    'wtx_snapshot_nonneg_ck',
    'wtx_status_ck',
    'wtx_versions_ck',
    'wtx_wait_deadline_ck',
    'wtx_wallet_fk',
  ],
  wallet_ledger_entries: [
    'ledger_amount_positive_ck',
    'ledger_arithmetic_ck',
    'ledger_balances_nonneg_ck',
    'ledger_direction_value_ck',
    'ledger_genesis_ck',
    'ledger_tx_dir_amt_uq',
    'ledger_tx_fk',
    'ledger_tx_wallet_uq',
    'ledger_version_ck',
    'ledger_wallet_fk',
    'ledger_wallet_version_uq',
  ],
  outbox_messages: ['outbox_attempts_ck', 'outbox_event_version_ck', 'outbox_payload_event_ck', 'outbox_seq_uq'],
  // F4 (migration 0002): reversões (P1 = C) e agenda de pendências.
  wager_reversals: [
    'rev_direction_ck',
    'rev_link_uq',
    'rev_pair_ck',
    'rev_reference_fk',
    'rev_reversal_ledger_fk',
    'rev_reversal_tx_fk',
    'rev_target_direction_ck',
    'rev_target_kind_uq',
    'rev_target_ledger_fk',
    'rev_target_tx_fk',
    'rev_undo_kind_ck',
    'rev_undone_by_fk',
    'rev_undone_by_uq',
  ],
  pending_reference_checks: ['prc_attempts_ck', 'prc_claim_ck', 'prc_transaction_fk'],
  // F5 (migration 0003): inbox do consumidor e registro de dead-letter.
  inbox_messages: ['inbox_envelope_hash_ck', 'inbox_message_id_ck', 'inbox_outcome_ck', 'inbox_transaction_fk'],
  // F6 (migration 0004): projeção de referência dos eventos.
  wallet_events_projection: ['projection_balance_ck', 'projection_version_ck'],
  dead_letter_messages: [
    'dead_letter_attempt_ck',
    'dead_letter_body_hash_ck',
    'dead_letter_redrive_count_ck',
    'dead_letter_redriven_ck',
    'dead_letter_state_ck',
  ],
};

describe('[QG-04] catálogo do schema por nome', () => {
  test('[QG-04] constraints nomeadas por tabela (sem PK, NOT NULL e constraint triggers)', async () => {
    for (const [table, expected] of Object.entries(EXPECTED_CONSTRAINTS)) {
      const rows = await queryRows<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype NOT IN ('p', 'n', 't') ORDER BY conname`,
        [table],
      );
      expect({ table, names: rows.map((row) => row.conname) }).toEqual({ table, names: expected });
    }
  });

  test('[QG-04] índices parciais e de apoio', async () => {
    const rows = await queryRows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE ANY (ARRAY['wtx\\_%idx', 'wtx\\_one\\_%', 'outbox\\_%idx']) ORDER BY indexname`,
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'outbox_unpublished_idx',
      'wtx_one_opening_per_wallet_uq',
      'wtx_pending_reference_idx',
      'wtx_reference_idx',
      'wtx_wallet_seq_idx',
    ]);
    const opening = rows.find((row) => row.indexname === 'wtx_one_opening_per_wallet_uq')?.indexdef ?? '';
    expect(opening).toContain('UNIQUE');
    expect(opening).toContain("WHERE (kind = 'OPENING'::text)");
  });

  test('[QG-04] P1 = C: uma reversão em vigor por alvo (índice parcial) e agenda indexada por vencimento', async () => {
    const rows = await queryRows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('wager_reversals', 'pending_reference_checks') AND indexname NOT LIKE '%_pkey'
        ORDER BY indexname`,
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'prc_due_idx',
      'prc_wallet_idx',
      'rev_link_uq',
      'rev_one_effective_uq',
      'rev_target_kind_uq',
      'rev_undone_by_uq',
    ]);
    const effective = rows.find((row) => row.indexname === 'rev_one_effective_uq')?.indexdef ?? '';
    expect(effective).toContain('UNIQUE');
    expect(effective).toContain('WHERE (undone_by IS NULL)');
  });

  test('[QG-04] triggers de guarda e checagens diferidas', async () => {
    const rows = await queryRows<{ tgname: string; table: string; deferrable: boolean; deferred: boolean }>(
      `SELECT t.tgname, c.relname AS table, t.tgdeferrable AS deferrable, t.tginitdeferred AS deferred
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace ORDER BY t.tgname`,
    );
    expect(rows.map((row) => `${row.table}.${row.tgname}`)).toEqual([
      'dead_letter_messages.dead_letter_guard',
      'dead_letter_messages.dead_letter_no_truncate',
      'inbox_messages.inbox_guard',
      'inbox_messages.inbox_no_truncate',
      'wallet_ledger_entries.ledger_chain_guard',
      'wallet_ledger_entries.ledger_consistency_deferred',
      'wallet_ledger_entries.ledger_immutable',
      'wallet_ledger_entries.ledger_no_truncate',
      'outbox_messages.outbox_guard',
      'wager_reversals.rev_guard',
      'wager_reversals.rev_no_truncate',
      'wager_reversals.rev_settled_bet_guard',
      'wallets.wallets_guard',
      'wallets.wallets_head_deferred',
      'wallets.wallets_no_truncate',
      'wager_transactions.wtx_consistency_deferred',
      'wager_transactions.wtx_guard',
      'wager_transactions.wtx_no_truncate',
      'wager_transactions.wtx_reversal_coverage_deferred',
      'wager_transactions.wtx_settlement_guard',
    ]);
    for (const row of rows) {
      const shouldDefer = row.tgname.endsWith('_deferred');
      expect({ trigger: row.tgname, deferrable: row.deferrable, deferred: row.deferred }).toEqual({
        trigger: row.tgname,
        deferrable: shouldDefer,
        deferred: shouldDefer,
      });
    }
  });

  test('[QG-04] tipos: dinheiro em money_amount, key com collation "C", accept_seq identity CACHE 1', async () => {
    const money = await queryRows<{ col: string; domain: string | null }>(
      `SELECT table_name || '.' || column_name AS col, domain_name AS domain FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('balance', 'amount', 'accepted_balance', 'result_balance', 'balance_before', 'balance_after')
        ORDER BY 1`,
    );
    expect(money.every((column) => column.domain === 'money_amount')).toBe(true);
    expect(money.map((column) => column.col)).toEqual([
      'wager_reversals.amount',
      'wager_transactions.accepted_balance',
      'wager_transactions.amount',
      'wager_transactions.result_balance',
      'wallet_events_projection.balance',
      'wallet_ledger_entries.amount',
      'wallet_ledger_entries.balance_after',
      'wallet_ledger_entries.balance_before',
      'wallets.balance',
    ]);
    const domain = await queryRows<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'money_amount_ck'`,
    );
    expect(domain[0]?.def).toContain('scale(VALUE) = 2');
    const key = await queryRows<{ collation: string | null }>(
      `SELECT collation_name AS collation FROM information_schema.columns
        WHERE table_name = 'wager_transactions' AND column_name = 'idempotency_key'`,
    );
    expect(key[0]?.collation).toBe('C');
    const seq = await queryRows<{ identity: string; cache: string }>(
      `SELECT a.attidentity AS identity, s.cache_size::text AS cache
         FROM pg_attribute a, pg_sequences s
        WHERE a.attrelid = 'wager_transactions'::regclass AND a.attname = 'accept_seq'
          AND s.sequencename = pg_get_serial_sequence('wager_transactions', 'accept_seq')::regclass::text`,
    );
    expect(seq[0]).toEqual({ identity: 'a', cache: '1' });
  });

  test('[QG-04] privilégios do role da app: sem UPDATE/DELETE no ledger, UPDATE só em colunas permitidas', async () => {
    const rows = await queryRows<{ check: string; allowed: boolean }>(
      `SELECT * FROM (VALUES
         ('ledger UPDATE', has_table_privilege('wagering_app', 'wallet_ledger_entries', 'UPDATE')),
         ('ledger DELETE', has_table_privilege('wagering_app', 'wallet_ledger_entries', 'DELETE')),
         ('ledger TRUNCATE', has_table_privilege('wagering_app', 'wallet_ledger_entries', 'TRUNCATE')),
         ('ledger INSERT', has_table_privilege('wagering_app', 'wallet_ledger_entries', 'INSERT')),
         ('wallets DELETE', has_table_privilege('wagering_app', 'wallets', 'DELETE')),
         ('wallets.balance UPDATE', has_column_privilege('wagering_app', 'wallets', 'balance', 'UPDATE')),
         ('wallets.player_id UPDATE', has_column_privilege('wagering_app', 'wallets', 'player_id', 'UPDATE')),
         ('wtx DELETE', has_table_privilege('wagering_app', 'wager_transactions', 'DELETE')),
         ('wtx.amount UPDATE', has_column_privilege('wagering_app', 'wager_transactions', 'amount', 'UPDATE')),
         ('wtx.status UPDATE', has_column_privilege('wagering_app', 'wager_transactions', 'status', 'UPDATE')),
         ('wtx.accepted_balance UPDATE', has_column_privilege('wagering_app', 'wager_transactions', 'accepted_balance', 'UPDATE')),
         ('outbox.payload UPDATE', has_column_privilege('wagering_app', 'outbox_messages', 'payload', 'UPDATE')),
         ('outbox DELETE', has_table_privilege('wagering_app', 'outbox_messages', 'DELETE')),
         ('wtx.pending_deadline_at UPDATE', has_column_privilege('wagering_app', 'wager_transactions', 'pending_deadline_at', 'UPDATE')),
         ('reversals INSERT', has_table_privilege('wagering_app', 'wager_reversals', 'INSERT')),
         ('reversals.undone_by UPDATE', has_column_privilege('wagering_app', 'wager_reversals', 'undone_by', 'UPDATE')),
         ('reversals.target_id UPDATE', has_column_privilege('wagering_app', 'wager_reversals', 'target_id', 'UPDATE')),
         ('reversals DELETE', has_table_privilege('wagering_app', 'wager_reversals', 'DELETE')),
         ('agenda DELETE', has_table_privilege('wagering_app', 'pending_reference_checks', 'DELETE')),
         ('agenda.transaction_id UPDATE', has_column_privilege('wagering_app', 'pending_reference_checks', 'transaction_id', 'UPDATE')),
         ('inbox INSERT', has_table_privilege('wagering_app', 'inbox_messages', 'INSERT')),
         ('inbox UPDATE', has_table_privilege('wagering_app', 'inbox_messages', 'UPDATE')),
         ('inbox DELETE', has_table_privilege('wagering_app', 'inbox_messages', 'DELETE')),
         ('dead_letter INSERT', has_table_privilege('wagering_app', 'dead_letter_messages', 'INSERT')),
         ('dead_letter.state UPDATE', has_column_privilege('wagering_app', 'dead_letter_messages', 'state', 'UPDATE')),
         ('dead_letter.body_hash UPDATE', has_column_privilege('wagering_app', 'dead_letter_messages', 'body_hash', 'UPDATE')),
         ('dead_letter DELETE', has_table_privilege('wagering_app', 'dead_letter_messages', 'DELETE')),
         ('purge EXECUTE', has_function_privilege('wagering_app', 'wagering_purge_retention(integer, integer, integer)', 'EXECUTE')),
         ('purge PUBLIC EXECUTE', has_function_privilege('public', 'wagering_purge_retention(integer, integer, integer)', 'EXECUTE')),
         ('projection DELETE', has_table_privilege('wagering_app', 'wallet_events_projection', 'DELETE')),
         ('projection.wallet_id UPDATE', has_column_privilege('wagering_app', 'wallet_events_projection', 'wallet_id', 'UPDATE'))
       ) v("check", allowed)`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.check, row.allowed]))).toEqual({
      'ledger UPDATE': false,
      'ledger DELETE': false,
      'ledger TRUNCATE': false,
      'ledger INSERT': true,
      'wallets DELETE': false,
      'wallets.balance UPDATE': true,
      'wallets.player_id UPDATE': false,
      'wtx DELETE': false,
      'wtx.amount UPDATE': false,
      'wtx.status UPDATE': true,
      'wtx.accepted_balance UPDATE': false,
      'outbox.payload UPDATE': false,
      'outbox DELETE': false,
      'wtx.pending_deadline_at UPDATE': false,
      'reversals INSERT': true,
      'reversals.undone_by UPDATE': true,
      'reversals.target_id UPDATE': false,
      'reversals DELETE': false,
      'agenda DELETE': true,
      'agenda.transaction_id UPDATE': false,
      'inbox INSERT': true,
      'inbox UPDATE': false,
      'inbox DELETE': false,
      'dead_letter INSERT': true,
      'dead_letter.state UPDATE': true,
      'dead_letter.body_hash UPDATE': false,
      'dead_letter DELETE': false,
      'purge EXECUTE': true,
      'purge PUBLIC EXECUTE': false,
      'projection DELETE': false,
      'projection.wallet_id UPDATE': false,
    });
  });
});
