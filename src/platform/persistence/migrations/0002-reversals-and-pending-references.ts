import { sqlMigration } from './sql-migration.ts';

/**
 * F4 — reversões (P1 = C, P2 = (c)) e pendências de referência (D40). A migration 0001 fica
 * intacta; tudo aqui é aditivo e reversível.
 *
 * P1 = C (ARCHITECTURE.md §1): no máximo uma reversão aplicada por (alvo, tipo), contando as
 * desfeitas (`rev_target_kind_uq`), e no máximo uma reversão em vigor por alvo
 * (`rev_one_effective_uq`, índice parcial em `undone_by IS NULL`). Só um REFUND pode ser desfeito
 * (por um ROLLBACK, que grava `undone_by`). Vínculos com a transação, a referência e os dois
 * lançamentos são FKs diferidas: a tabela não consegue descrever uma reversão que não aconteceu.
 *
 * P2 = (c): WIN/LOSS não podem ser aplicados sobre BET com reversão em vigor
 * (`wtx_reversed_bet_settlement_ck`), e uma BET com WIN em vigor (não estornado) não pode ser
 * revertida (`rev_settled_bet_ck`). São guardas imediatas: valem no instante da decisão, como a
 * política, e não reavaliam decisões antigas.
 *
 * Pendências: `pending_deadline_at` (aceite + TTL, relógio do PostgreSQL) e a agenda
 * `pending_reference_checks` (uma linha por PENDING_REFERENCE, apagada na resolução).
 *
 * Dados da F3 (atualização de um banco existente):
 * - reversões PROCESSED já gravadas entram em `wager_reversals`, com `undone_by` dos REFUNDs que
 *   um ROLLBACK desfez; se algum dado violar P1/P2, a migration FALHA (índices e guardas), nada
 *   é corrigido em silêncio;
 * - PENDING_REFERENCE existentes recebem prazo = aceite + 30 minutos (o TTL padrão de produção) e
 *   uma linha na agenda, para o worker resolvê-las ou rejeitá-las pela regra de prazo.
 */
const up: string[] = [
  // Num banco com dados da F3, o UPDATE e os INSERTs de preenchimento disparam as checagens
  // diferidas da 0001; um ALTER TABLE seguinte falharia com eventos de trigger pendentes (55006).
  // Durante a migration as checagens rodam ao fim de cada comando (só nesta transação).
  `SET CONSTRAINTS ALL IMMEDIATE`,
  // ---------------------------------------------------------------- prazo das pendências
  `ALTER TABLE wager_transactions ADD COLUMN pending_deadline_at timestamptz`,
  `UPDATE wager_transactions SET pending_deadline_at = accepted_at + interval '30 minutes'
    WHERE initial_status = 'PENDING_REFERENCE' AND status = 'PENDING_REFERENCE'`,
  `ALTER TABLE wager_transactions ADD CONSTRAINT wtx_wait_deadline_ck
     CHECK ((initial_status = 'PENDING_REFERENCE') = (pending_deadline_at IS NOT NULL))`,

  // ---------------------------------------------------------------- vínculos usados pelas FKs das reversões
  `ALTER TABLE wager_transactions ADD CONSTRAINT wtx_key5_uq UNIQUE (id, kind, wallet_id, currency, amount)`,
  `ALTER TABLE wager_transactions ADD CONSTRAINT wtx_ref_link_uq UNIQUE (id, reference_transaction_id)`,
  `ALTER TABLE wallet_ledger_entries ADD CONSTRAINT ledger_tx_dir_amt_uq UNIQUE (transaction_id, wallet_id, direction, amount)`,

  // ---------------------------------------------------------------- reversões (P1 = C)
  `CREATE TABLE wager_reversals (
     reversal_id       uuid PRIMARY KEY,
     reversal_kind     text NOT NULL,
     direction         text NOT NULL,
     target_id         uuid NOT NULL,
     target_kind       text NOT NULL,
     target_direction  text NOT NULL,
     wallet_id         uuid NOT NULL,
     currency          currency_code NOT NULL,
     amount            money_amount NOT NULL,
     undone_by         uuid,
     created_at        timestamptz NOT NULL,
     CONSTRAINT rev_pair_ck CHECK ((reversal_kind, target_kind) IN
       (('REFUND', 'BET'), ('ROLLBACK', 'BET'), ('ROLLBACK', 'WIN'), ('ROLLBACK', 'REFUND'))),
     CONSTRAINT rev_direction_ck CHECK (direction IN ('DEBIT', 'CREDIT') AND target_direction IN ('DEBIT', 'CREDIT')
       AND direction <> target_direction),
     CONSTRAINT rev_target_direction_ck CHECK ((target_kind = 'BET') = (target_direction = 'DEBIT')),
     CONSTRAINT rev_undo_kind_ck CHECK (undone_by IS NULL OR reversal_kind = 'REFUND'),
     CONSTRAINT rev_undone_by_uq UNIQUE (undone_by),
     CONSTRAINT rev_link_uq UNIQUE (reversal_id, target_id),
     CONSTRAINT rev_target_kind_uq UNIQUE (target_id, reversal_kind),
     CONSTRAINT rev_reference_fk FOREIGN KEY (reversal_id, target_id)
       REFERENCES wager_transactions (id, reference_transaction_id) DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT rev_reversal_tx_fk FOREIGN KEY (reversal_id, reversal_kind, wallet_id, currency, amount)
       REFERENCES wager_transactions (id, kind, wallet_id, currency, amount) DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT rev_target_tx_fk FOREIGN KEY (target_id, target_kind, wallet_id, currency, amount)
       REFERENCES wager_transactions (id, kind, wallet_id, currency, amount) DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT rev_reversal_ledger_fk FOREIGN KEY (reversal_id, wallet_id, direction, amount)
       REFERENCES wallet_ledger_entries (transaction_id, wallet_id, direction, amount) DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT rev_target_ledger_fk FOREIGN KEY (target_id, wallet_id, target_direction, amount)
       REFERENCES wallet_ledger_entries (transaction_id, wallet_id, direction, amount) DEFERRABLE INITIALLY DEFERRED,
     CONSTRAINT rev_undone_by_fk FOREIGN KEY (undone_by, reversal_id)
       REFERENCES wager_reversals (reversal_id, target_id) DEFERRABLE INITIALLY DEFERRED
   )`,
  `CREATE UNIQUE INDEX rev_one_effective_uq ON wager_reversals (target_id) WHERE undone_by IS NULL`,

  // undone_by só vai de NULL para um valor; a linha não muda nem é apagada.
  `CREATE FUNCTION wager_reversals_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'reversões não podem ser apagadas' USING ERRCODE = '23000', CONSTRAINT = 'rev_immutable';
     END IF;
     IF (NEW.reversal_id, NEW.reversal_kind, NEW.direction, NEW.target_id, NEW.target_kind, NEW.target_direction,
         NEW.wallet_id, NEW.currency, NEW.amount, NEW.created_at)
        IS DISTINCT FROM
        (OLD.reversal_id, OLD.reversal_kind, OLD.direction, OLD.target_id, OLD.target_kind, OLD.target_direction,
         OLD.wallet_id, OLD.currency, OLD.amount, OLD.created_at)
        OR (OLD.undone_by IS NOT NULL AND NEW.undone_by IS DISTINCT FROM OLD.undone_by) THEN
       RAISE EXCEPTION 'reversão é imutável; undone_by só vai de NULL para um valor'
         USING ERRCODE = '23000', CONSTRAINT = 'rev_immutable';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER rev_guard BEFORE UPDATE OR DELETE ON wager_reversals FOR EACH ROW EXECUTE FUNCTION wager_reversals_guard()`,
  `CREATE TRIGGER rev_no_truncate BEFORE TRUNCATE ON wager_reversals
     FOR EACH STATEMENT EXECUTE FUNCTION wagering_forbid('rev_immutable')`,

  // P2 = (c), lado da reversão: BET com WIN em vigor (sem ROLLBACK aplicado) não é revertida.
  `CREATE FUNCTION wager_reversals_settled_bet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.target_kind = 'BET' AND EXISTS (
          SELECT 1 FROM wager_transactions w
           WHERE w.reference_transaction_id = NEW.target_id AND w.kind = 'WIN' AND w.status = 'PROCESSED'
             AND NOT EXISTS (SELECT 1 FROM wager_reversals u WHERE u.target_id = w.id)) THEN
       RAISE EXCEPTION 'BET % tem WIN em vigor e não pode ser revertida (P2)', NEW.target_id
         USING ERRCODE = '23514', CONSTRAINT = 'rev_settled_bet_ck';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER rev_settled_bet_guard BEFORE INSERT ON wager_reversals
     FOR EACH ROW EXECUTE FUNCTION wager_reversals_settled_bet_guard()`,

  // P2 = (c), lado do WIN/LOSS: não se aplica sobre BET com reversão em vigor.
  `CREATE FUNCTION wtx_reversed_bet_settlement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.status = 'PROCESSED' AND NEW.kind IN ('WIN', 'LOSS') AND NEW.reference_transaction_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM wager_reversals r
                     WHERE r.target_id = NEW.reference_transaction_id AND r.undone_by IS NULL) THEN
       RAISE EXCEPTION 'WIN/LOSS sobre BET com reversão em vigor (P2)'
         USING ERRCODE = '23514', CONSTRAINT = 'wtx_reversed_bet_settlement_ck';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER wtx_settlement_guard BEFORE INSERT OR UPDATE OF status ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wtx_reversed_bet_settlement_guard()`,

  // ---------------------------------------------------------------- agenda de pendências (D40)
  `CREATE TABLE pending_reference_checks (
     transaction_id  uuid PRIMARY KEY,
     wallet_id       uuid NOT NULL,
     attempts        integer NOT NULL DEFAULT 0,
     next_check_at   timestamptz NOT NULL,
     claim_token     uuid,
     claimed_until   timestamptz,
     last_error      text,
     created_at      timestamptz NOT NULL,
     CONSTRAINT prc_attempts_ck CHECK (attempts >= 0),
     CONSTRAINT prc_claim_ck CHECK ((claim_token IS NULL) = (claimed_until IS NULL)),
     CONSTRAINT prc_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id)
   )`,
  `CREATE INDEX prc_due_idx ON pending_reference_checks (next_check_at)`,
  `CREATE INDEX prc_wallet_idx ON pending_reference_checks (wallet_id)`,

  // ---------------------------------------------------------------- dados da F3
  // Primeiro as reversões cujo alvo não é BET (ROLLBACK de WIN ou de REFUND): o guarda de P2
  // consulta os estornos de WIN ao inserir as reversões de BET, no segundo comando.
  `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                wallet_id, currency, amount, undone_by, created_at)
   SELECT t.id, t.kind, e.direction, r.id, r.kind, re.direction, t.wallet_id, t.currency, t.amount, NULL, t.created_at
     FROM wager_transactions t
     JOIN wager_transactions r ON r.id = t.reference_transaction_id
     JOIN wallet_ledger_entries e ON e.transaction_id = t.id
     JOIN wallet_ledger_entries re ON re.transaction_id = r.id
    WHERE t.status = 'PROCESSED' AND t.kind IN ('REFUND', 'ROLLBACK') AND r.kind <> 'BET'
    ORDER BY t.accept_seq`,
  `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                wallet_id, currency, amount, undone_by, created_at)
   SELECT t.id, t.kind, e.direction, r.id, r.kind, re.direction, t.wallet_id, t.currency, t.amount,
          (SELECT u.id FROM wager_transactions u
            WHERE u.kind = 'ROLLBACK' AND u.status = 'PROCESSED' AND u.reference_transaction_id = t.id),
          t.created_at
     FROM wager_transactions t
     JOIN wager_transactions r ON r.id = t.reference_transaction_id
     JOIN wallet_ledger_entries e ON e.transaction_id = t.id
     JOIN wallet_ledger_entries re ON re.transaction_id = r.id
    WHERE t.status = 'PROCESSED' AND t.kind IN ('REFUND', 'ROLLBACK') AND r.kind = 'BET'
    ORDER BY t.accept_seq`,
  `INSERT INTO pending_reference_checks (transaction_id, wallet_id, next_check_at, created_at)
   SELECT id, wallet_id, now(), now() FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,

  // ---------------------------------------------------------------- checagem diferida de cobertura
  // Toda reversão PROCESSED tem sua linha; o ROLLBACK de um REFUND marca o REFUND como desfeito;
  // uma transação está na agenda se e somente se está PENDING_REFERENCE.
  `CREATE FUNCTION wagering_check_reversal_coverage(p_tx uuid) RETURNS void LANGUAGE plpgsql AS $$
   DECLARE
     t record;
     target_kind text;
   BEGIN
     SELECT * INTO t FROM wager_transactions WHERE id = p_tx;
     IF NOT FOUND THEN
       RETURN;
     END IF;
     IF t.status = 'PROCESSED' AND t.kind IN ('REFUND', 'ROLLBACK') THEN
       IF NOT EXISTS (SELECT 1 FROM wager_reversals WHERE reversal_id = p_tx) THEN
         RAISE EXCEPTION 'reversão % sem registro em wager_reversals', p_tx
           USING ERRCODE = '23514', CONSTRAINT = 'rev_coverage_ck';
       END IF;
       SELECT kind INTO target_kind FROM wager_transactions WHERE id = t.reference_transaction_id;
       IF t.kind = 'ROLLBACK' AND target_kind = 'REFUND'
          AND NOT EXISTS (SELECT 1 FROM wager_reversals WHERE reversal_id = t.reference_transaction_id AND undone_by = p_tx) THEN
         RAISE EXCEPTION 'ROLLBACK % não marcou o REFUND como desfeito', p_tx
           USING ERRCODE = '23514', CONSTRAINT = 'rev_undo_link_ck';
       END IF;
     END IF;
     IF (t.status = 'PENDING_REFERENCE') <> EXISTS (SELECT 1 FROM pending_reference_checks WHERE transaction_id = p_tx) THEN
       RAISE EXCEPTION 'agenda de pendências incoerente com a transação %', p_tx
         USING ERRCODE = '23514', CONSTRAINT = 'prc_coverage_ck';
     END IF;
   END $$`,
  `CREATE FUNCTION wagering_trg_reversal_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     PERFORM wagering_check_reversal_coverage(NEW.id);
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER wtx_reversal_coverage_deferred AFTER INSERT OR UPDATE ON wager_transactions
     DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wagering_trg_reversal_coverage()`,

  // ---------------------------------------------------------------- privilégios (D18)
  `REVOKE ALL ON wager_reversals, pending_reference_checks FROM PUBLIC`,
  `GRANT SELECT, INSERT ON wager_reversals TO wagering_app`,
  `GRANT UPDATE (undone_by) ON wager_reversals TO wagering_app`,
  `GRANT SELECT, INSERT, DELETE ON pending_reference_checks TO wagering_app`,
  `GRANT UPDATE (attempts, next_check_at, claim_token, claimed_until, last_error) ON pending_reference_checks TO wagering_app`,
];

const down: string[] = [
  `DROP TRIGGER wtx_reversal_coverage_deferred ON wager_transactions`,
  `DROP FUNCTION wagering_trg_reversal_coverage()`,
  `DROP FUNCTION wagering_check_reversal_coverage(uuid)`,
  `DROP TABLE pending_reference_checks`,
  `DROP TRIGGER wtx_settlement_guard ON wager_transactions`,
  `DROP FUNCTION wtx_reversed_bet_settlement_guard()`,
  `DROP TABLE wager_reversals`,
  `DROP FUNCTION wager_reversals_settled_bet_guard()`,
  `DROP FUNCTION wager_reversals_guard()`,
  `ALTER TABLE wallet_ledger_entries DROP CONSTRAINT ledger_tx_dir_amt_uq`,
  `ALTER TABLE wager_transactions DROP CONSTRAINT wtx_ref_link_uq`,
  `ALTER TABLE wager_transactions DROP CONSTRAINT wtx_key5_uq`,
  `ALTER TABLE wager_transactions DROP CONSTRAINT wtx_wait_deadline_ck`,
  `ALTER TABLE wager_transactions DROP COLUMN pending_deadline_at`,
];

export const M0002_REVERSALS_AND_PENDING_REFERENCES = sqlMigration({
  name: 'Migration0002ReversalsAndPendingReferences',
  up,
  down,
});
