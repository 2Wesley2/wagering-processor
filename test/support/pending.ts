import { ownerUrl } from './db.ts';
import { eventually } from './eventually.ts';
import type { Fixture } from './fixture.ts';
import { withClient } from './sql-fixtures.ts';

/** Ambiente de uma instância só de worker (papel `pending-reference-worker`, sem tráfego HTTP de negócio). */
export function workerEnv(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return fixture.env({ APP_ROLES: 'pending-reference-worker', ...extra });
}

/** Ambiente de API com o worker ligado no mesmo processo. */
export function apiWithWorkerEnv(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return fixture.env({ APP_ROLES: 'api,pending-reference-worker', ...extra });
}

export interface StoredTransaction {
  readonly status: string;
  readonly failureCode: string | null;
  readonly resultBalance: string | null;
  readonly resultWalletVersion: string | null;
  readonly initialStatus: string;
  readonly acceptedBalance: string;
  /** Comparações de instantes feitas pelo PostgreSQL (sem relógio do teste). */
  readonly availableBeforeOrAtDeadline: boolean | null;
  readonly decidedAfterDeadline: boolean | null;
  readonly availableEqualsDeadline: boolean | null;
  readonly inAgenda: boolean;
}

export async function storedTransaction(database: string, transactionId: string): Promise<StoredTransaction> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<Record<string, unknown>>(
      `SELECT status, failure_code, result_balance::text AS result_balance, result_wallet_version::text AS result_version,
              initial_status, accepted_balance::text AS accepted_balance,
              available_at <= pending_deadline_at AS available_before_deadline,
              decided_at > pending_deadline_at AS decided_after_deadline,
              available_at = pending_deadline_at AS available_equals_deadline,
              EXISTS (SELECT 1 FROM pending_reference_checks c WHERE c.transaction_id = t.id) AS in_agenda
         FROM wager_transactions t WHERE id = $1::uuid`,
      [transactionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`transação ${transactionId} não existe`);
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
    return {
      status: text(row['status']) ?? '',
      failureCode: text(row['failure_code']),
      resultBalance: text(row['result_balance']),
      resultWalletVersion: text(row['result_version']),
      initialStatus: text(row['initial_status']) ?? '',
      acceptedBalance: text(row['accepted_balance']) ?? '',
      availableBeforeOrAtDeadline: flag(row['available_before_deadline']),
      decidedAfterDeadline: flag(row['decided_after_deadline']),
      availableEqualsDeadline: flag(row['available_equals_deadline']),
      inAgenda: row['in_agenda'] === true,
    };
  });
}

/**
 * Fixa o prazo de uma pendência por SQL (dono do schema; o role da app não tem UPDATE nessa
 * coluna). `expression` é SQL avaliado pelo PostgreSQL, relativo a colunas gravadas — o teste
 * nunca usa o próprio relógio para decidir prazo (D55).
 */
export async function setDeadline(database: string, transactionId: string, expression: string): Promise<void> {
  await withClient(ownerUrl(database), async (client) => {
    await client.query(`UPDATE wager_transactions SET pending_deadline_at = ${expression} WHERE id = $1::uuid`, [
      transactionId,
    ]);
  });
}

/** Instante de aceite de uma transação, como texto ISO do PostgreSQL (para montar prazos relativos). */
export async function acceptedAtOf(database: string, transactionId: string): Promise<string> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ at: string }>(
      `SELECT to_char(accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
         FROM wager_transactions WHERE id = $1::uuid`,
      [transactionId],
    );
    const at = result.rows[0]?.at;
    if (at === undefined) throw new Error(`transação ${transactionId} não existe`);
    return at;
  });
}

/** Espera até nenhuma das transações estar PENDING_REFERENCE. */
export async function waitResolved(
  database: string,
  transactionIds: readonly string[],
  timeoutMs = 20_000,
): Promise<void> {
  await eventually(
    async () => {
      for (const id of transactionIds) {
        if ((await storedTransaction(database, id)).status === 'PENDING_REFERENCE') return undefined;
      }
      return true;
    },
    { timeoutMs, intervalMs: 100, describe: `${transactionIds.length} pendência(s) resolvida(s) pelo worker` },
  );
}
