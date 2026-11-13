import { sqlMigration } from './sql-migration.ts';

/**
 * F2 — schema financeiro (D14–D18). O PostgreSQL é a autoridade final das
 * invariantes (§5 item 9): tipos, constraints com nome, triggers de guarda e
 * checagens diferidas saldo↔ledger↔transação. Tabelas da F4/F5 (agenda de
 * pendências, inbox, dead-letter, reversões dependentes de P1) entram em
 * migrations próprias, nas fases delas.
 *
 * Escopo da Idempotency-Key (I2, decidido): GLOBAL — UNIQUE (idempotency_key),
 * coluna com COLLATE "C" (comparação byte a byte, sem normalização).
 */
const up: string[] = [
  // ---------------------------------------------------------------- tipos
  `CREATE DOMAIN money_amount AS numeric
     CONSTRAINT money_amount_ck CHECK (scale(VALUE) = 2 AND abs(VALUE) < 1000000000000000)`,
  `CREATE DOMAIN currency_code AS text CONSTRAINT currency_code_ck CHECK (VALUE ~ '^[A-Z]{3}$')`,
  `CREATE DOMAIN hash_v1 AS text CONSTRAINT hash_v1_ck CHECK (VALUE ~ '^v1:[0-9a-f]{64}$')`,

  // ---------------------------------------------------------------- wallets
  `CREATE TABLE wallets (
     id          uuid PRIMARY KEY,
     player_id   uuid NOT NULL,
     currency    currency_code NOT NULL,
     balance     money_amount NOT NULL,
     version     bigint NOT NULL,
     created_at  timestamptz NOT NULL,
     updated_at  timestamptz NOT NULL,
     CONSTRAINT wallets_balance_nonneg_ck CHECK (balance >= 0),
     CONSTRAINT wallets_version_ck CHECK (version >= 1),
     CONSTRAINT wallets_player_currency_uq UNIQUE (player_id, currency),
     CONSTRAINT wallets_id_currency_uq UNIQUE (id, currency),
     CONSTRAINT wallets_identity_uq UNIQUE (id, player_id, currency)
   )`,

  // ---------------------------------------------------------------- transações
  `CREATE TABLE wager_transactions (
     id                                uuid PRIMARY KEY,
     provider_id                       text NOT NULL,
     external_transaction_id           text NOT NULL,
     idempotency_key                   text COLLATE "C" NOT NULL,
     payload_hash                      hash_v1 NOT NULL,
     wallet_id                         uuid NOT NULL,
     player_id                         uuid NOT NULL,
     round_id                          text NOT NULL,
     game_id                           text NOT NULL,
     kind                              text NOT NULL,
     currency                          currency_code NOT NULL,
     amount                            money_amount NOT NULL,
     reference_external_transaction_id text,
     reference_transaction_id          uuid,
     status                            text NOT NULL,
     failure_code                      text,
     initial_status                    text NOT NULL,
     accepted_balance                  money_amount NOT NULL,
     accepted_wallet_version           bigint NOT NULL,
     accepted_at                       timestamptz NOT NULL,
     result_balance                    money_amount,
     result_wallet_version             bigint,
     decided_at                        timestamptz,
     available_at                      timestamptz,
     accept_seq                        bigint GENERATED ALWAYS AS IDENTITY (CACHE 1) NOT NULL,
     correlation_id                    text NOT NULL,
     created_at                        timestamptz NOT NULL,
     CONSTRAINT wtx_idempotency_key_uq UNIQUE (idempotency_key),
     CONSTRAINT wtx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
     CONSTRAINT wtx_accept_seq_uq UNIQUE (accept_seq),
     CONSTRAINT wtx_ledger_target_uq UNIQUE (id, wallet_id, currency, amount),
     CONSTRAINT wtx_wallet_fk FOREIGN KEY (wallet_id, player_id, currency) REFERENCES wallets (id, player_id, currency),
     CONSTRAINT wtx_reference_fk FOREIGN KEY (reference_transaction_id) REFERENCES wager_transactions (id),
     CONSTRAINT wtx_kind_ck CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
     CONSTRAINT wtx_status_ck CHECK (status IN ('PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
     CONSTRAINT wtx_initial_status_ck CHECK (initial_status IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE')),
     CONSTRAINT wtx_idempotency_key_format_ck CHECK (idempotency_key ~ '^[!-~]{1,255}$'),
     CONSTRAINT wtx_reference_by_kind_ck CHECK (
       (kind NOT IN ('BET', 'OPENING') OR reference_external_transaction_id IS NULL)
       AND (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL)),
     CONSTRAINT wtx_self_reference_ck CHECK (reference_external_transaction_id IS DISTINCT FROM external_transaction_id),
     CONSTRAINT wtx_opening_provider_ck CHECK ((kind = 'OPENING') = (provider_id = '__internal__')),
     CONSTRAINT wtx_amount_ck CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
     CONSTRAINT wtx_failure_code_ck CHECK (
       ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL))
       AND (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z_]{1,63}$')),
     CONSTRAINT wtx_reference_id_ck CHECK (reference_transaction_id IS NULL OR status = 'PROCESSED'),
     CONSTRAINT wtx_reversal_reference_ck CHECK (
       NOT (status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')) OR reference_transaction_id IS NOT NULL),
     CONSTRAINT wtx_result_presence_ck CHECK (
       ((status = 'PENDING_REFERENCE') = (result_balance IS NULL))
       AND ((result_balance IS NULL) = (result_wallet_version IS NULL))
       AND ((result_balance IS NULL) = (decided_at IS NULL))
       AND ((decided_at IS NULL) = (available_at IS NULL))),
     CONSTRAINT wtx_initial_consistency_ck CHECK (
       initial_status = 'PENDING_REFERENCE'
       OR (status = initial_status AND result_balance = accepted_balance
           AND result_wallet_version = accepted_wallet_version
           AND decided_at = accepted_at AND available_at = accepted_at)),
     CONSTRAINT wtx_versions_ck CHECK (
       accepted_wallet_version >= 1 AND (result_wallet_version IS NULL OR result_wallet_version >= accepted_wallet_version)),
     CONSTRAINT wtx_snapshot_nonneg_ck CHECK (accepted_balance >= 0 AND (result_balance IS NULL OR result_balance >= 0))
   )`,
  `CREATE UNIQUE INDEX wtx_one_opening_per_wallet_uq ON wager_transactions (wallet_id) WHERE kind = 'OPENING'`,
  `CREATE INDEX wtx_pending_reference_idx ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,
  `CREATE INDEX wtx_wallet_seq_idx ON wager_transactions (wallet_id, accept_seq)`,
  `CREATE INDEX wtx_reference_idx ON wager_transactions (reference_transaction_id) WHERE reference_transaction_id IS NOT NULL`,

  // ---------------------------------------------------------------- ledger
  `CREATE TABLE wallet_ledger_entries (
     id              uuid PRIMARY KEY,
     wallet_id       uuid NOT NULL,
     transaction_id  uuid NOT NULL,
     currency        currency_code NOT NULL,
     direction       text NOT NULL,
     amount          money_amount NOT NULL,
     balance_before  money_amount NOT NULL,
     balance_after   money_amount NOT NULL,
     wallet_version  bigint NOT NULL,
     created_at      timestamptz NOT NULL,
     CONSTRAINT ledger_direction_value_ck CHECK (direction IN ('DEBIT', 'CREDIT')),
     CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
     CONSTRAINT ledger_balances_nonneg_ck CHECK (balance_before >= 0 AND balance_after >= 0),
     CONSTRAINT ledger_version_ck CHECK (wallet_version >= 1),
     CONSTRAINT ledger_arithmetic_ck CHECK (
       (direction = 'CREDIT' AND balance_after = balance_before + amount)
       OR (direction = 'DEBIT' AND balance_after = balance_before - amount)),
     CONSTRAINT ledger_genesis_ck CHECK (wallet_version > 1 OR (direction = 'CREDIT' AND balance_before = 0)),
     CONSTRAINT ledger_tx_wallet_uq UNIQUE (transaction_id, wallet_id),
     CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
     CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
     CONSTRAINT ledger_tx_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
       REFERENCES wager_transactions (id, wallet_id, currency, amount)
   )`,

  // ---------------------------------------------------------------- outbox
  `CREATE TABLE outbox_messages (
     id                   uuid PRIMARY KEY,
     seq                  bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
     aggregate_id         uuid NOT NULL,
     message_group_id     text NOT NULL,
     event_type           text NOT NULL,
     event_version        integer NOT NULL,
     payload              jsonb NOT NULL,
     attempts             integer NOT NULL DEFAULT 0,
     next_attempt_at      timestamptz NOT NULL DEFAULT now(),
     claim_token          uuid,
     claimed_until        timestamptz,
     published_at         timestamptz,
     last_republished_at  timestamptz,
     last_error           text,
     created_at           timestamptz NOT NULL,
     CONSTRAINT outbox_seq_uq UNIQUE (seq),
     CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
     CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0),
     CONSTRAINT outbox_payload_event_ck CHECK (payload ->> 'eventId' = id::text AND payload ->> 'eventType' = event_type)
   )`,
  `CREATE INDEX outbox_unpublished_idx ON outbox_messages (next_attempt_at, seq) WHERE published_at IS NULL`,

  // ---------------------------------------------------------------- guardas imediatas
  `CREATE FUNCTION wagering_forbid() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION '% em % é proibido', TG_OP, TG_TABLE_NAME
       USING ERRCODE = '23000', CONSTRAINT = TG_ARGV[0];
   END $$`,
  `CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION wagering_forbid('ledger_immutable')`,
  `CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid('ledger_immutable')`,
  `CREATE TRIGGER wtx_no_truncate BEFORE TRUNCATE ON wager_transactions
     FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid('wtx_immutable')`,
  `CREATE TRIGGER wallets_no_truncate BEFORE TRUNCATE ON wallets
     FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid('wallets_no_delete')`,

  `CREATE FUNCTION ledger_chain_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     prev_after numeric;
   BEGIN
     IF NEW.wallet_version = 1 THEN
       RETURN NEW;
     END IF;
     SELECT balance_after INTO prev_after FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
     IF FOUND THEN
       IF NEW.balance_before = prev_after THEN
         RETURN NEW;
       END IF;
     ELSIF NEW.wallet_version = 2 AND NEW.balance_before = 0
       AND NOT EXISTS (SELECT 1 FROM wager_transactions WHERE wallet_id = NEW.wallet_id AND kind = 'OPENING') THEN
       -- Wallet aberta com 0.00: a v1 é um estado sem lançamento.
       RETURN NEW;
     END IF;
     RAISE EXCEPTION 'cadeia do ledger quebrada na wallet % versão %', NEW.wallet_id, NEW.wallet_version
       USING ERRCODE = '23514', CONSTRAINT = 'ledger_chain_ck';
   END $$`,
  `CREATE TRIGGER ledger_chain_guard BEFORE INSERT ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION ledger_chain_guard()`,

  `CREATE FUNCTION wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'wallets não podem ser apagadas' USING ERRCODE = '23000', CONSTRAINT = 'wallets_no_delete';
     END IF;
     IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
       RAISE EXCEPTION 'identidade da wallet é imutável' USING ERRCODE = '23000', CONSTRAINT = 'wallets_identity_immutable';
     END IF;
     IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1
        OR NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'version sobe 1 se e somente se o saldo muda'
         USING ERRCODE = '23514', CONSTRAINT = 'wallets_version_step_ck';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER wallets_guard BEFORE UPDATE OR DELETE ON wallets FOR EACH ROW EXECUTE FUNCTION wallets_guard()`,

  `CREATE FUNCTION wtx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'transações não podem ser apagadas' USING ERRCODE = '23000', CONSTRAINT = 'wtx_immutable';
     END IF;
     IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
       RAISE EXCEPTION 'transação terminal é imutável' USING ERRCODE = '23000', CONSTRAINT = 'wtx_immutable';
     END IF;
     IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
         NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.currency, NEW.amount, NEW.reference_external_transaction_id,
         NEW.initial_status, NEW.accepted_balance, NEW.accepted_wallet_version, NEW.accepted_at, NEW.accept_seq,
         NEW.correlation_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
         OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.currency, OLD.amount, OLD.reference_external_transaction_id,
         OLD.initial_status, OLD.accepted_balance, OLD.accepted_wallet_version, OLD.accepted_at, OLD.accept_seq,
         OLD.correlation_id, OLD.created_at) THEN
       RAISE EXCEPTION 'colunas de negócio e a resposta original são imutáveis' USING ERRCODE = '23000', CONSTRAINT = 'wtx_immutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER wtx_guard BEFORE UPDATE OR DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION wtx_guard()`,

  `CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF (NEW.id, NEW.seq, NEW.aggregate_id, NEW.message_group_id, NEW.event_type, NEW.event_version, NEW.payload, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.seq, OLD.aggregate_id, OLD.message_group_id, OLD.event_type, OLD.event_version, OLD.payload, OLD.created_at)
        OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
       RAISE EXCEPTION 'identidade e payload da outbox são imutáveis; published_at só vai de NULL para um valor'
         USING ERRCODE = '23000', CONSTRAINT = 'outbox_immutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER outbox_guard BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION outbox_guard()`,

  // ---------------------------------------------------------------- checagens diferidas (D17)
  `CREATE FUNCTION wagering_is_real_state(p_wallet uuid, p_balance numeric, p_version bigint) RETURNS boolean
   LANGUAGE sql STABLE AS $$
     SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries
                     WHERE wallet_id = p_wallet AND wallet_version = p_version AND balance_after = p_balance)
         OR (p_version = 1 AND p_balance = 0
             AND NOT EXISTS (SELECT 1 FROM wager_transactions WHERE wallet_id = p_wallet AND kind = 'OPENING'))
   $$`,

  `CREATE FUNCTION wagering_check_wallet_head(p_wallet uuid) RETURNS void LANGUAGE plpgsql AS $$
   DECLARE
     w record;
     head record;
   BEGIN
     SELECT balance, version INTO w FROM wallets WHERE id = p_wallet;
     IF NOT FOUND THEN
       RETURN;
     END IF;
     SELECT balance_after, wallet_version INTO head FROM wallet_ledger_entries
      WHERE wallet_id = p_wallet ORDER BY wallet_version DESC LIMIT 1;
     IF FOUND THEN
       IF w.balance = head.balance_after AND w.version = head.wallet_version THEN
         RETURN;
       END IF;
     ELSIF w.balance = 0 AND w.version = 1
       AND NOT EXISTS (SELECT 1 FROM wager_transactions WHERE wallet_id = p_wallet AND kind = 'OPENING') THEN
       RETURN;
     END IF;
     RAISE EXCEPTION 'wallet % diverge da cabeça do ledger', p_wallet USING ERRCODE = '23514', CONSTRAINT = 'wallet_ledger_head_ck';
   END $$`,

  `CREATE FUNCTION wagering_check_transaction(p_tx uuid) RETURNS void LANGUAGE plpgsql AS $$
   DECLARE
     t record;
     e record;
     r record;
     n integer;
     expected text;
   BEGIN
     SELECT * INTO t FROM wager_transactions WHERE id = p_tx;
     IF NOT FOUND THEN
       RETURN;
     END IF;
     SELECT count(*) INTO n FROM wallet_ledger_entries WHERE transaction_id = p_tx;

     IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN
       IF n <> 1 THEN
         RAISE EXCEPTION 'transação % com efeito precisa de exatamente 1 lançamento (tem %)', p_tx, n
           USING ERRCODE = '23514', CONSTRAINT = 'wtx_ledger_effect_ck';
       END IF;
       SELECT * INTO e FROM wallet_ledger_entries WHERE transaction_id = p_tx;
       IF t.kind IN ('OPENING', 'WIN', 'REFUND') THEN
         expected := 'CREDIT';
       ELSIF t.kind = 'BET' THEN
         expected := 'DEBIT';
       ELSE
         SELECT CASE direction WHEN 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END INTO expected
           FROM wallet_ledger_entries WHERE transaction_id = t.reference_transaction_id;
       END IF;
       IF e.direction IS DISTINCT FROM expected THEN
         RAISE EXCEPTION 'direção % incoerente com % (esperado %)', e.direction, t.kind, expected
           USING ERRCODE = '23514', CONSTRAINT = 'ledger_direction_ck';
       END IF;
       IF (t.result_balance, t.result_wallet_version) IS DISTINCT FROM (e.balance_after, e.wallet_version) THEN
         RAISE EXCEPTION 'snapshot da transação % diverge do próprio lançamento', p_tx
           USING ERRCODE = '23514', CONSTRAINT = 'wtx_snapshot_chain_ck';
       END IF;
     ELSE
       IF n <> 0 THEN
         RAISE EXCEPTION 'transação % (% %) não pode ter lançamento', p_tx, t.kind, t.status
           USING ERRCODE = '23514', CONSTRAINT = 'wtx_ledger_effect_ck';
       END IF;
       IF t.result_balance IS NOT NULL AND (
            NOT wagering_is_real_state(t.wallet_id, t.result_balance, t.result_wallet_version)
            OR t.result_wallet_version > (SELECT version FROM wallets WHERE id = t.wallet_id)) THEN
         RAISE EXCEPTION 'snapshot de resultado da transação % fora da cadeia', p_tx
           USING ERRCODE = '23514', CONSTRAINT = 'wtx_snapshot_chain_ck';
       END IF;
     END IF;

     IF NOT wagering_is_real_state(t.wallet_id, t.accepted_balance, t.accepted_wallet_version) THEN
       RAISE EXCEPTION 'snapshot de aceite da transação % fora da cadeia', p_tx
         USING ERRCODE = '23514', CONSTRAINT = 'wtx_snapshot_chain_ck';
     END IF;

     IF t.reference_transaction_id IS NOT NULL THEN
       SELECT * INTO r FROM wager_transactions WHERE id = t.reference_transaction_id;
       IF r.status <> 'PROCESSED'
          OR (r.provider_id, r.player_id, r.wallet_id, r.currency, r.round_id)
             IS DISTINCT FROM (t.provider_id, t.player_id, t.wallet_id, t.currency, t.round_id)
          OR r.external_transaction_id IS DISTINCT FROM t.reference_external_transaction_id
          OR NOT ((t.kind = 'REFUND' AND r.kind = 'BET')
                  OR (t.kind = 'ROLLBACK' AND r.kind IN ('BET', 'WIN', 'REFUND'))
                  OR (t.kind IN ('WIN', 'LOSS') AND r.kind = 'BET'))
          OR (t.kind IN ('REFUND', 'ROLLBACK') AND r.amount <> t.amount) THEN
         RAISE EXCEPTION 'referência incoerente na transação %', p_tx
           USING ERRCODE = '23514', CONSTRAINT = 'wtx_reference_coherence_ck';
       END IF;
     END IF;
   END $$`,

  `CREATE FUNCTION wagering_trg_wallet_head() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM wagering_check_wallet_head(NEW.id);
     RETURN NULL;
   END $$`,
  `CREATE FUNCTION wagering_trg_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM wagering_check_transaction(NEW.id);
     RETURN NULL;
   END $$`,
  `CREATE FUNCTION wagering_trg_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM wagering_check_wallet_head(NEW.wallet_id);
     PERFORM wagering_check_transaction(NEW.transaction_id);
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER wallets_head_deferred AFTER INSERT OR UPDATE ON wallets
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_trg_wallet_head()`,
  `CREATE CONSTRAINT TRIGGER wtx_consistency_deferred AFTER INSERT OR UPDATE ON wager_transactions
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_trg_transaction()`,
  `CREATE CONSTRAINT TRIGGER ledger_consistency_deferred AFTER INSERT ON wallet_ledger_entries
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_trg_ledger()`,

  // ---------------------------------------------------------------- privilégios (D18)
  `REVOKE ALL ON wallets, wager_transactions, wallet_ledger_entries, outbox_messages FROM PUBLIC`,
  `GRANT USAGE ON SCHEMA public TO wagering_app`,
  `GRANT SELECT, INSERT ON wallets, wager_transactions, wallet_ledger_entries, outbox_messages TO wagering_app`,
  `GRANT UPDATE (balance, version, updated_at) ON wallets TO wagering_app`,
  `GRANT UPDATE (status, failure_code, reference_transaction_id, result_balance, result_wallet_version, decided_at, available_at)
     ON wager_transactions TO wagering_app`,
  `GRANT UPDATE (attempts, next_attempt_at, claim_token, claimed_until, published_at, last_republished_at, last_error)
     ON outbox_messages TO wagering_app`,
];

const down: string[] = [
  `DROP TABLE wallet_ledger_entries`,
  `DROP TABLE outbox_messages`,
  `DROP TABLE wager_transactions`,
  `DROP TABLE wallets`,
  `DROP FUNCTION wagering_trg_ledger()`,
  `DROP FUNCTION wagering_trg_transaction()`,
  `DROP FUNCTION wagering_trg_wallet_head()`,
  `DROP FUNCTION wagering_check_transaction(uuid)`,
  `DROP FUNCTION wagering_check_wallet_head(uuid)`,
  `DROP FUNCTION wagering_is_real_state(uuid, numeric, bigint)`,
  `DROP FUNCTION outbox_guard()`,
  `DROP FUNCTION wtx_guard()`,
  `DROP FUNCTION wallets_guard()`,
  `DROP FUNCTION ledger_chain_guard()`,
  `DROP FUNCTION wagering_forbid()`,
  `DROP DOMAIN hash_v1`,
  `DROP DOMAIN currency_code`,
  `DROP DOMAIN money_amount`,
];

export const M0001_FINANCIAL_SCHEMA = sqlMigration({ name: 'Migration0001FinancialSchema', up, down });
