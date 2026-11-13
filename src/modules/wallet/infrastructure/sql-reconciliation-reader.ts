import type { MikroORM } from '@mikro-orm/postgresql';
import type { ReconciliationFacts, ReconciliationReader } from '../application/ports.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface FactsRow {
  currency: string;
  stored: string;
  version: string;
  calculated: string;
  entries: string;
  head_balance: string | null;
  head_version: string | null;
  has_opening: boolean;
  chain_breaks: string;
  orphan_entries: string;
  missing_entries: string;
}

/**
 * Reconciliação (D22): um único snapshot REPEATABLE READ READ ONLY, sem locks.
 * A soma é feita no banco em numeric e devolvida como texto (escala 2).
 */
export class SqlReconciliationReader implements ReconciliationReader {
  constructor(private readonly orm: MikroORM) {}

  async read(walletId: string): Promise<ReconciliationFacts | undefined> {
    if (!UUID_RE.test(walletId)) return undefined;
    const entityManager = this.orm.em.fork();
    const row = await entityManager.transactional(async (transactionalEntityManager) => {
      await transactionalEntityManager.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', [], 'run');
      const rows = await transactionalEntityManager.execute<FactsRow[]>(
        `SELECT w.currency,
                w.balance::text AS stored,
                w.version::text AS version,
                round(coalesce((SELECT sum(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END)
                                  FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0), 2)::text AS calculated,
                (SELECT count(*) FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)::text AS entries,
                h.balance_after::text AS head_balance,
                h.wallet_version::text AS head_version,
                EXISTS (SELECT 1 FROM wager_transactions t WHERE t.wallet_id = w.id AND t.kind = 'OPENING') AS has_opening,
                (SELECT count(*) FROM wallet_ledger_entries e
                   LEFT JOIN wallet_ledger_entries p ON p.wallet_id = e.wallet_id AND p.wallet_version = e.wallet_version - 1
                  WHERE e.wallet_id = w.id AND e.wallet_version > 1
                    AND ((p.id IS NULL AND NOT (e.wallet_version = 2 AND e.balance_before = 0)) OR p.balance_after <> e.balance_before)
                )::text AS chain_breaks,
                (SELECT count(*) FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
                  WHERE e.wallet_id = w.id AND (t.status <> 'PROCESSED' OR t.kind = 'LOSS'))::text AS orphan_entries,
                (SELECT count(*) FROM wager_transactions t
                  WHERE t.wallet_id = w.id AND t.status = 'PROCESSED' AND t.kind <> 'LOSS'
                    AND NOT EXISTS (SELECT 1 FROM wallet_ledger_entries e WHERE e.transaction_id = t.id))::text AS missing_entries
           FROM wallets w
           LEFT JOIN LATERAL (SELECT balance_after, wallet_version FROM wallet_ledger_entries
                               WHERE wallet_id = w.id ORDER BY wallet_version DESC LIMIT 1) h ON true
          WHERE w.id = ?`,
        [walletId],
        'all',
      );
      return rows[0];
    });
    if (row === undefined) return undefined;
    return {
      currency: row.currency,
      storedBalance: row.stored,
      storedVersion: Number.parseInt(row.version, 10),
      calculatedBalance: row.calculated,
      entries: Number.parseInt(row.entries, 10),
      headBalance: row.head_balance ?? undefined,
      headVersion: row.head_version === null ? undefined : Number.parseInt(row.head_version, 10),
      hasOpening: row.has_opening,
      chainBreaks: Number.parseInt(row.chain_breaks, 10),
      orphanEntries: Number.parseInt(row.orphan_entries, 10),
      missingEntries: Number.parseInt(row.missing_entries, 10),
    };
  }
}
