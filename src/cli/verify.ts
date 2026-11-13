import pg from 'pg';
import { ConfigError, loadConfig } from '../platform/config/config.ts';
import { writeFatalLine } from '../platform/observability/logger.ts';

/**
 * `bun run verify`: invariantes do sistema inteiro, SOMENTE LEITURA (um snapshot REPEATABLE READ
 * READ ONLY, sem locks). Usado nos runbooks V7/V9c depois de quedas. Imprime um JSON com cada
 * checagem e sai com 1 se alguma violação existir. Nada é corrigido.
 */
const VIOLATIONS: readonly { readonly name: string; readonly sql: string; readonly retentionDays?: true }[] = [
  {
    name: 'saldo diferente da soma do ledger',
    sql: `SELECT w.id::text AS subject FROM wallets w
           WHERE w.balance <> COALESCE((SELECT sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END)
                                          FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)`,
  },
  { name: 'saldo negativo', sql: `SELECT id::text AS subject FROM wallets WHERE balance < 0` },
  {
    name: 'wallet diferente do último lançamento',
    sql: `SELECT w.id::text AS subject FROM wallets w
           LEFT JOIN LATERAL (SELECT balance_after, wallet_version FROM wallet_ledger_entries
                               WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) h ON true
           WHERE (h.wallet_version IS NULL AND (w.balance <> 0 OR w.version <> 1))
              OR (h.wallet_version IS NOT NULL AND (w.balance <> h.balance_after OR w.version <> h.wallet_version))`,
  },
  {
    name: 'cadeia do ledger quebrada',
    sql: `SELECT e.id::text AS subject FROM wallet_ledger_entries e
           JOIN wallet_ledger_entries p ON p.wallet_id = e.wallet_id AND p.wallet_version = e.wallet_version - 1
           WHERE p.balance_after <> e.balance_before`,
  },
  {
    name: 'transação com efeito sem exatamente um lançamento',
    sql: `SELECT t.id::text AS subject FROM wager_transactions t
           WHERE t.status = 'PROCESSED' AND t.kind <> 'LOSS'
             AND (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id) <> 1`,
  },
  {
    name: 'lançamento de transação sem efeito',
    sql: `SELECT e.id::text AS subject FROM wallet_ledger_entries e
           JOIN wager_transactions t ON t.id = e.transaction_id
           WHERE t.status <> 'PROCESSED' OR t.kind = 'LOSS'`,
  },
  {
    name: 'BET com mais de uma reversão em vigor (P1 = C)',
    sql: `SELECT b.id::text AS subject FROM wager_transactions b
           WHERE b.kind = 'BET' AND b.status = 'PROCESSED'
             AND (SELECT count(*) FROM wager_reversals r WHERE r.target_id = b.id AND r.undone_by IS NULL) > 1`,
  },
  {
    // Só dentro da retenção da outbox: eventos publicados há mais tempo já foram purgados.
    name: 'transação sem evento na outbox (dentro da retenção)',
    sql: `SELECT t.id::text AS subject FROM wager_transactions t
           WHERE NOT EXISTS (SELECT 1 FROM outbox_messages o WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text)
             AND t.created_at > now() - make_interval(days => $1)`,
    retentionDays: true,
  },
];

const COUNTERS = `SELECT (SELECT count(*) FROM wallets)::text AS wallets,
                         (SELECT count(*) FROM wager_transactions)::text AS transactions,
                         (SELECT count(*) FROM wallet_ledger_entries)::text AS ledger_entries,
                         (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE')::text AS pending_references,
                         (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL)::text AS outbox_unpublished,
                         (SELECT count(*) FROM dead_letter_messages WHERE state IN ('PENDING_DLQ', 'IN_DLQ'))::text AS dead_letters_open`;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    application_name: `verify:${config.instanceId}`,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const violations: { check: string; subjects: string[] }[] = [];
    for (const check of VIOLATIONS) {
      const result = await client.query<{ subject: string }>(
        check.sql,
        check.retentionDays === true ? [config.retention.outboxDays] : [],
      );
      if (result.rows.length > 0) {
        violations.push({ check: check.name, subjects: result.rows.slice(0, 20).map((row) => row.subject) });
      }
    }
    const counters = (await client.query<Record<string, string>>(COUNTERS)).rows[0] ?? {};
    await client.query('COMMIT');
    const consistent = violations.length === 0;
    process.stdout.write(
      `${JSON.stringify({ event: 'verify.done', consistent, checks: VIOLATIONS.length, violations, counters })}\n`,
    );
    if (!consistent) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    const code = error instanceof ConfigError ? error.code : 'verify.failed';
    writeFatalLine(code, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
