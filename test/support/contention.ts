import type pg from 'pg';
import { ownerUrl, withAdmin } from './db.ts';
import { eventually } from './eventually.ts';
import { connect } from '../../src/platform/persistence/pg-admin.ts';

/**
 * Contenção comprovada (D47, D52): um cliente de teste segura o `FOR UPDATE` da wallet, as
 * requisições ficam em espera de lock e o teste só solta depois de ver, em `pg_stat_activity`,
 * backends das instâncias (`application_name = app:<id>`) esperando.
 *
 * O observador conecta como superusuário de teste: um role comum não vê `wait_event_type` das
 * sessões de outros roles (as instâncias usam `wagering_app`).
 */
export interface WalletLock {
  /** Espera até haver backends de pelo menos `instances` instâncias distintas na fila do lock. */
  waitForWaiters(instances: number, timeoutMs?: number): Promise<string[]>;
  /** Espera até haver pelo menos `backends` conexões das instâncias em espera de lock no banco. */
  waitForWaitingBackends(backends: number, timeoutMs?: number): Promise<number>;
  release(): Promise<void>;
}

async function lockWaiters(database: string): Promise<string[]> {
  return withAdmin(async (observer) => {
    const result = await observer.query<{ name: string }>(
      `SELECT application_name AS name FROM pg_stat_activity
        WHERE datname = $1 AND wait_event_type = 'Lock' AND application_name LIKE 'app:%'`,
      [database],
    );
    return result.rows.map((row) => row.name);
  });
}

export async function lockWallet(database: string, walletId: string): Promise<WalletLock> {
  const client: pg.Client = await connect(ownerUrl(database), 'wagering:test-lock-holder');
  await client.query('BEGIN');
  await client.query('SELECT id FROM wallets WHERE id = $1::uuid FOR UPDATE', [walletId]);
  let released = false;
  return {
    async waitForWaiters(instances: number, timeoutMs = 20_000): Promise<string[]> {
      return eventually(
        async () => {
          const names = [...new Set(await lockWaiters(database))].sort((left, right) => left.localeCompare(right));
          return names.length >= instances ? names : undefined;
        },
        { timeoutMs, intervalMs: 50, describe: `${instances} instância(s) esperando o lock da wallet` },
      );
    },
    async waitForWaitingBackends(backends: number, timeoutMs = 20_000): Promise<number> {
      return eventually(
        async () => {
          const count = (await lockWaiters(database)).length;
          return count >= backends ? count : undefined;
        },
        { timeoutMs, intervalMs: 50, describe: `${backends} conexão(ões) esperando lock` },
      );
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await client.query('COMMIT').catch(() => undefined);
      await client.end();
    },
  };
}
