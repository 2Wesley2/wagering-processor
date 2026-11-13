import { sqlMigration } from './sql-migration.ts';

/**
 * F6 — retenção da inbox e da outbox publicada (D18, D38) e a projeção de referência dos eventos
 * (D39). As migrations 0001 a 0003 ficam intactas; tudo aqui é aditivo e reversível.
 *
 * Retenção: o role da app não tem DELETE em `inbox_messages` nem em `outbox_messages`. A única
 * porta é `wagering_purge_retention`, SECURITY DEFINER (roda como dono), que:
 * - recusa prazos menores que 30 dias (inbox) e 7 dias (outbox publicada);
 * - nunca apaga evento da outbox que ainda aguarda publicação (`published_at IS NULL`);
 * - nunca toca tabelas financeiras (wallets, transações, ledger, reversões, agenda);
 * - apaga em lotes, com um advisory lock de transação (uma purga por vez).
 * A guarda da inbox passa a aceitar DELETE só dentro dessa função (variável de transação que ela
 * mesma liga); UPDATE continua proibido.
 *
 * Projeção (`wallet_events_projection`): saldo e versão por wallet a partir de
 * WalletBalanceChanged, aplicada no máximo uma vez por eventId (inbox do consumidor
 * `wallet-events-projection`) e só para versão maior que a gravada.
 */
const up: string[] = [
  // ---------------------------------------------------------------- projeção de referência
  `CREATE TABLE wallet_events_projection (
     wallet_id       uuid PRIMARY KEY,
     balance         money_amount NOT NULL,
     wallet_version  bigint NOT NULL,
     last_event_id   uuid NOT NULL,
     updated_at      timestamptz NOT NULL,
     CONSTRAINT projection_version_ck CHECK (wallet_version >= 1),
     CONSTRAINT projection_balance_ck CHECK (balance >= 0)
   )`,

  // ---------------------------------------------------------------- inbox: DELETE só na purga
  `CREATE OR REPLACE FUNCTION inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' AND current_setting('wagering.retention_purge', true) = 'on' THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'linhas da inbox são imutáveis' USING ERRCODE = '23000', CONSTRAINT = 'inbox_immutable';
   END $$`,

  // ---------------------------------------------------------------- purga por retenção
  `CREATE FUNCTION wagering_purge_retention(p_inbox_days integer, p_outbox_days integer, p_batch integer)
     RETURNS TABLE (inbox_deleted bigint, outbox_deleted bigint)
     LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
   DECLARE
     v_inbox bigint := 0;
     v_outbox bigint := 0;
   BEGIN
     IF p_inbox_days < 30 OR p_outbox_days < 7 OR p_batch < 1 OR p_batch > 10000 THEN
       RAISE EXCEPTION 'retenção mínima: inbox 30 dias, outbox publicada 7 dias (lote 1..10000)'
         USING ERRCODE = '22023';
     END IF;
     IF NOT pg_try_advisory_xact_lock(hashtext('wagering:retention')) THEN
       RETURN QUERY SELECT 0::bigint, 0::bigint;
       RETURN;
     END IF;
     PERFORM set_config('wagering.retention_purge', 'on', true);
     DELETE FROM inbox_messages
      WHERE ctid IN (SELECT ctid FROM inbox_messages
                      WHERE processed_at < clock_timestamp() - make_interval(days => p_inbox_days)
                      LIMIT p_batch);
     GET DIAGNOSTICS v_inbox = ROW_COUNT;
     DELETE FROM outbox_messages
      WHERE ctid IN (SELECT ctid FROM outbox_messages
                      WHERE published_at IS NOT NULL
                        AND published_at < clock_timestamp() - make_interval(days => p_outbox_days)
                      LIMIT p_batch);
     GET DIAGNOSTICS v_outbox = ROW_COUNT;
     PERFORM set_config('wagering.retention_purge', 'off', true);
     RETURN QUERY SELECT v_inbox, v_outbox;
   END $$`,

  // ---------------------------------------------------------------- privilégios (D18)
  `REVOKE ALL ON wallet_events_projection FROM PUBLIC`,
  `GRANT SELECT, INSERT ON wallet_events_projection TO wagering_app`,
  `GRANT UPDATE (balance, wallet_version, last_event_id, updated_at) ON wallet_events_projection TO wagering_app`,
  `REVOKE ALL ON FUNCTION wagering_purge_retention(integer, integer, integer) FROM PUBLIC`,
  `GRANT EXECUTE ON FUNCTION wagering_purge_retention(integer, integer, integer) TO wagering_app`,
];

const down: string[] = [
  `DROP FUNCTION wagering_purge_retention(integer, integer, integer)`,
  `CREATE OR REPLACE FUNCTION inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'linhas da inbox são imutáveis' USING ERRCODE = '23000', CONSTRAINT = 'inbox_immutable';
   END $$`,
  `DROP TABLE wallet_events_projection`,
];

export const M0004_RETENTION_AND_PROJECTION = sqlMigration({ name: 'Migration0004RetentionAndProjection', up, down });
