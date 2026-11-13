/**
 * Verificador global de invariantes (D53, D58), independente da aplicação: SQL próprio, sem
 * importar nada de src/ (verificado por QG-08). Toda aritmética de dinheiro é feita pelo
 * PostgreSQL (numeric). Recebe uma função de consulta para não depender de driver.
 */
export type QueryRows = (sql: string) => Promise<readonly Record<string, unknown>[]>;

const CHECKS: readonly { readonly name: string; readonly sql: string }[] = [
  {
    name: 'saldo ≠ saldo reconstruído pelo ledger',
    sql: `SELECT w.id::text AS subject FROM wallets w
           WHERE w.balance <> COALESCE((SELECT sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END)
                                          FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)`,
  },
  {
    name: 'saldo negativo',
    sql: `SELECT id::text AS subject FROM wallets WHERE balance < 0`,
  },
  {
    name: 'wallet diverge do último lançamento',
    sql: `SELECT w.id::text AS subject FROM wallets w
           LEFT JOIN LATERAL (SELECT e.balance_after, e.wallet_version FROM wallet_ledger_entries e
                               WHERE e.wallet_id = w.id ORDER BY e.wallet_version DESC LIMIT 1) head ON true
           WHERE (head.wallet_version IS NULL AND (w.balance <> 0 OR w.version <> 1))
              OR (head.wallet_version IS NOT NULL AND (w.balance <> head.balance_after OR w.version <> head.wallet_version))`,
  },
  {
    name: 'versões do ledger com buraco ou cadeia quebrada',
    sql: `SELECT e.id::text AS subject FROM wallet_ledger_entries e
           JOIN wallet_ledger_entries p ON p.wallet_id = e.wallet_id AND p.wallet_version = e.wallet_version - 1
           WHERE p.balance_after <> e.balance_before
          UNION ALL
          SELECT w.id::text FROM wallets w
           WHERE (SELECT count(*) FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)
                 <> (SELECT COALESCE(max(e.wallet_version), 0) - COALESCE(min(e.wallet_version), 1) + 1
                       FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)`,
  },
  {
    name: 'transação com efeito sem exatamente 1 lançamento',
    sql: `SELECT t.id::text AS subject FROM wager_transactions t
           WHERE t.status = 'PROCESSED' AND t.kind <> 'LOSS'
             AND (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id) <> 1`,
  },
  {
    name: 'transação sem efeito (LOSS, REJECTED, pendente) com lançamento',
    sql: `SELECT t.id::text AS subject FROM wager_transactions t
           WHERE (t.status <> 'PROCESSED' OR t.kind = 'LOSS')
             AND EXISTS (SELECT 1 FROM wallet_ledger_entries e WHERE e.transaction_id = t.id)`,
  },
  {
    name: 'lançamento sem transação PROCESSED',
    sql: `SELECT e.id::text AS subject FROM wallet_ledger_entries e
           LEFT JOIN wager_transactions t ON t.id = e.transaction_id
           WHERE t.id IS NULL OR t.status <> 'PROCESSED'`,
  },
  // P1 = C (I5b/I5c, D53): calculado só com wager_transactions, sem usar a tabela de reversões.
  {
    name: 'crédito líquido das reversões de uma BET fora de {0, valor da BET}',
    sql: `SELECT b.id::text AS subject FROM wager_transactions b
           WHERE b.kind = 'BET' AND b.status = 'PROCESSED'
             AND COALESCE((SELECT sum(t.amount) FROM wager_transactions t
                            WHERE t.reference_transaction_id = b.id AND t.status = 'PROCESSED' AND t.kind IN ('REFUND', 'ROLLBACK')), 0)
               - COALESCE((SELECT sum(u.amount) FROM wager_transactions u JOIN wager_transactions r ON r.id = u.reference_transaction_id
                            WHERE r.reference_transaction_id = b.id AND r.kind = 'REFUND' AND r.status = 'PROCESSED'
                              AND u.kind = 'ROLLBACK' AND u.status = 'PROCESSED'), 0)
               NOT IN (0, b.amount)`,
  },
  {
    name: 'estorno de WIN ou de REFUND aplicado mais de uma vez',
    sql: `SELECT r.id::text AS subject FROM wager_transactions r
           WHERE r.kind IN ('WIN', 'REFUND') AND r.status = 'PROCESSED'
             AND (SELECT count(*) FROM wager_transactions u
                   WHERE u.reference_transaction_id = r.id AND u.kind = 'ROLLBACK' AND u.status = 'PROCESSED') > 1`,
  },
  {
    // P2 = (c): uma BET não fica, ao mesmo tempo, revertida em vigor e premiada por WIN em vigor.
    name: 'BET revertida em vigor e com WIN em vigor',
    sql: `SELECT b.id::text AS subject FROM wager_transactions b
           WHERE b.kind = 'BET' AND b.status = 'PROCESSED'
             AND EXISTS (SELECT 1 FROM wager_transactions t
                          WHERE t.reference_transaction_id = b.id AND t.status = 'PROCESSED' AND t.kind IN ('REFUND', 'ROLLBACK')
                            AND NOT EXISTS (SELECT 1 FROM wager_transactions u
                                             WHERE u.reference_transaction_id = t.id AND u.kind = 'ROLLBACK' AND u.status = 'PROCESSED'))
             AND EXISTS (SELECT 1 FROM wager_transactions w
                          WHERE w.reference_transaction_id = b.id AND w.kind = 'WIN' AND w.status = 'PROCESSED'
                            AND NOT EXISTS (SELECT 1 FROM wager_transactions u
                                             WHERE u.reference_transaction_id = w.id AND u.kind = 'ROLLBACK' AND u.status = 'PROCESSED'))`,
  },
  {
    name: 'transação decidida sem evento na outbox',
    // Transações preparadas por fixtures SQL (correlation_id 'sql-fixture') não passam pelo caso de
    // uso e, por desenho, não têm eventos; todas as outras precisam ter.
    sql: `SELECT t.id::text AS subject FROM wager_transactions t
           WHERE t.correlation_id <> 'sql-fixture'
             AND NOT EXISTS (SELECT 1 FROM outbox_messages o WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text)`,
  },
];

/** Lista de violações no formato "nome: id"; vazia quando todas as invariantes valem. */
export async function verifyInvariants(query: QueryRows): Promise<string[]> {
  const issues: string[] = [];
  for (const check of CHECKS) {
    for (const row of await query(check.sql)) issues.push(`${check.name}: ${String(row['subject'])}`);
  }
  return issues;
}
