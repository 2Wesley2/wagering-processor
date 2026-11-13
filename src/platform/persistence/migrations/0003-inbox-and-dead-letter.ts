import { sqlMigration } from './sql-migration.ts';

/**
 * F5 — inbox do consumidor SQS e registro de dead-letter (D35, D36). As migrations 0001 e 0002
 * ficam intactas; tudo aqui é aditivo e reversível.
 *
 * Inbox (`inbox_messages`): uma linha por mensagem PROCESSADA, gravada na MESMA transação SQL da
 * decisão (transação, saldo, lançamento e outbox). Identidade (consumidor, messageId); o
 * `envelope_hash` separa a reentrega da mesma mensagem (ack) de um messageId reutilizado com outro
 * conteúdo (MESSAGE_ID_PAYLOAD_MISMATCH). Linhas imutáveis.
 *
 * Dead-letter (`dead_letter_messages`): a decisão de descartar é commitada ANTES de qualquer envio
 * ou ack. Identidade (consumidor, dl_key, body_hash): mensagens com o mesmo messageId e corpos
 * diferentes nunca se confundem. Transições de estado guardadas por trigger:
 *   ∅ → PENDING_DLQ (attempt 1)            ∅ → REDRIVE_PENDING (cópia movida pelo broker)
 *   PENDING_DLQ → IN_DLQ                   IN_DLQ → REDRIVE_PENDING (redrive_count + 1)
 *   REDRIVE_PENDING → REDRIVEN             REDRIVEN | REDRIVE_PENDING → PENDING_DLQ (attempt + 1)
 *   PENDING_DLQ | REDRIVEN → REDRIVE_PENDING (cópia movida pelo broker, redrive_count + 1)
 */
const up: string[] = [
  // ---------------------------------------------------------------- inbox
  `CREATE TABLE inbox_messages (
     consumer_name   text NOT NULL,
     message_id      text NOT NULL,
     envelope_hash   text NOT NULL,
     outcome         text NOT NULL,
     transaction_id  uuid,
     processed_at    timestamptz NOT NULL,
     CONSTRAINT inbox_pk PRIMARY KEY (consumer_name, message_id),
     CONSTRAINT inbox_message_id_ck CHECK (length(message_id) BETWEEN 1 AND 200),
     CONSTRAINT inbox_envelope_hash_ck CHECK (envelope_hash ~ '^v1:[0-9a-f]{64}$'),
     CONSTRAINT inbox_outcome_ck CHECK (outcome IN ('PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'REPLAY')),
     CONSTRAINT inbox_transaction_fk FOREIGN KEY (transaction_id) REFERENCES wager_transactions (id)
   )`,
  `CREATE INDEX inbox_transaction_idx ON inbox_messages (transaction_id)`,
  `CREATE FUNCTION inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'linhas da inbox são imutáveis' USING ERRCODE = '23000', CONSTRAINT = 'inbox_immutable';
   END $$`,
  `CREATE TRIGGER inbox_guard BEFORE UPDATE OR DELETE ON inbox_messages FOR EACH ROW EXECUTE FUNCTION inbox_guard()`,

  // ---------------------------------------------------------------- dead-letter
  `CREATE TABLE dead_letter_messages (
     consumer_name     text NOT NULL,
     dl_key            text NOT NULL,
     body_hash         text NOT NULL,
     reason            text NOT NULL,
     sqs_message_id    text,
     state             text NOT NULL,
     attempt           integer NOT NULL,
     redrive_count     integer NOT NULL DEFAULT 0,
     redriven_attempt  integer,
     first_seen_at     timestamptz NOT NULL,
     last_failed_at    timestamptz NOT NULL,
     dlq_sent_at       timestamptz,
     redriven_at       timestamptz,
     CONSTRAINT dead_letter_pk PRIMARY KEY (consumer_name, dl_key, body_hash),
     CONSTRAINT dead_letter_body_hash_ck CHECK (body_hash ~ '^v1:[0-9a-f]{64}$'),
     CONSTRAINT dead_letter_state_ck CHECK (state IN ('PENDING_DLQ', 'IN_DLQ', 'REDRIVE_PENDING', 'REDRIVEN')),
     CONSTRAINT dead_letter_attempt_ck CHECK (attempt >= 1),
     CONSTRAINT dead_letter_redrive_count_ck CHECK (redrive_count >= 0),
     CONSTRAINT dead_letter_redriven_ck CHECK (state <> 'REDRIVEN' OR (redriven_attempt IS NOT NULL AND redriven_at IS NOT NULL))
   )`,
  `CREATE INDEX dead_letter_pending_idx ON dead_letter_messages (last_failed_at) WHERE state = 'PENDING_DLQ'`,
  `CREATE FUNCTION dead_letter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     allowed boolean;
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'registros de dead-letter não são apagados' USING ERRCODE = '23000', CONSTRAINT = 'dead_letter_immutable';
     END IF;
     IF TG_OP = 'INSERT' THEN
       IF NOT ((NEW.state = 'PENDING_DLQ' AND NEW.attempt = 1 AND NEW.redrive_count = 0)
               OR (NEW.state = 'REDRIVE_PENDING' AND NEW.attempt = 1 AND NEW.redrive_count = 1)) THEN
         RAISE EXCEPTION 'estado inicial de dead-letter inválido: %', NEW.state
           USING ERRCODE = '23514', CONSTRAINT = 'dead_letter_transition_ck';
       END IF;
       RETURN NEW;
     END IF;
     IF (NEW.consumer_name, NEW.dl_key, NEW.body_hash, NEW.first_seen_at)
        IS DISTINCT FROM (OLD.consumer_name, OLD.dl_key, OLD.body_hash, OLD.first_seen_at) THEN
       RAISE EXCEPTION 'identidade de dead-letter é imutável' USING ERRCODE = '23000', CONSTRAINT = 'dead_letter_immutable';
     END IF;
     allowed := CASE
       WHEN OLD.state = 'PENDING_DLQ' AND NEW.state = 'IN_DLQ'
         THEN NEW.attempt = OLD.attempt AND NEW.redrive_count = OLD.redrive_count
       WHEN OLD.state IN ('IN_DLQ', 'PENDING_DLQ', 'REDRIVEN') AND NEW.state = 'REDRIVE_PENDING'
         THEN NEW.attempt = OLD.attempt AND NEW.redrive_count = OLD.redrive_count + 1
       WHEN OLD.state = 'REDRIVE_PENDING' AND NEW.state = 'REDRIVEN'
         THEN NEW.attempt = OLD.attempt AND NEW.redrive_count = OLD.redrive_count AND NEW.redriven_attempt = OLD.attempt
       WHEN OLD.state IN ('REDRIVEN', 'REDRIVE_PENDING') AND NEW.state = 'PENDING_DLQ'
         THEN NEW.attempt = OLD.attempt + 1 AND NEW.redrive_count = OLD.redrive_count
       ELSE false
     END;
     IF NOT allowed THEN
       RAISE EXCEPTION 'transição de dead-letter inválida: % → %', OLD.state, NEW.state
         USING ERRCODE = '23514', CONSTRAINT = 'dead_letter_transition_ck';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER dead_letter_guard BEFORE INSERT OR UPDATE OR DELETE ON dead_letter_messages
     FOR EACH ROW EXECUTE FUNCTION dead_letter_guard()`,
  `CREATE FUNCTION dead_letter_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'TRUNCATE proibido em %', TG_TABLE_NAME USING ERRCODE = '0A000';
   END $$`,
  `CREATE TRIGGER inbox_no_truncate BEFORE TRUNCATE ON inbox_messages
     FOR EACH STATEMENT EXECUTE FUNCTION dead_letter_no_truncate()`,
  `CREATE TRIGGER dead_letter_no_truncate BEFORE TRUNCATE ON dead_letter_messages
     FOR EACH STATEMENT EXECUTE FUNCTION dead_letter_no_truncate()`,

  // ---------------------------------------------------------------- privilégios (D18)
  `REVOKE ALL ON inbox_messages, dead_letter_messages FROM PUBLIC`,
  `GRANT SELECT, INSERT ON inbox_messages, dead_letter_messages TO wagering_app`,
  `GRANT UPDATE (reason, sqs_message_id, state, attempt, redrive_count, redriven_attempt, last_failed_at, dlq_sent_at, redriven_at)
     ON dead_letter_messages TO wagering_app`,
  // A app recusa subir com migration pendente (D20): ela lê a lista de migrations aplicadas.
  `GRANT SELECT ON mikro_orm_migrations TO wagering_app`,
];

const down: string[] = [
  `REVOKE SELECT ON mikro_orm_migrations FROM wagering_app`,
  `DROP TABLE dead_letter_messages`,
  `DROP TABLE inbox_messages`,
  `DROP FUNCTION dead_letter_no_truncate()`,
  `DROP FUNCTION dead_letter_guard()`,
  `DROP FUNCTION inbox_guard()`,
];

export const M0003_INBOX_AND_DEAD_LETTER = sqlMigration({ name: 'Migration0003InboxAndDeadLetter', up, down });
