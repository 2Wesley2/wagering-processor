import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import type { MikroORM } from '@mikro-orm/postgresql';
import pg from 'pg';
import { NoopFaultInjector } from '../../src/platform/lifecycle/fault-injection.ts';
import { WalletRecord } from '../../src/platform/persistence/records.ts';
import {
  toTransactionSql,
  createOrm,
  MikroOrmUnitOfWork,
  OutsideTransactionError,
} from '../../src/platform/persistence/unit-of-work.ts';
import type { DatabaseTransaction } from '../../src/shared/ports.ts';
import { Money } from '../../src/shared/money.ts';
import { SqlReconciliationReader } from '../../src/modules/wallet/infrastructure/sql-reconciliation-reader.ts';
import { OrmWalletQueries } from '../../src/modules/wallet/infrastructure/wallet-read-model.ts';
import { appUrl, createTestDatabase, dropTestDatabase } from '../support/db.ts';
import { rejectionOf } from '../support/eventually.ts';
import { movementSql, openWalletSql, withClient } from '../support/sql-fixtures.ts';

let database: string;
let orm: MikroORM;

beforeAll(async () => {
  database = await createTestDatabase('it0608');
  orm = await createOrm({ databaseUrl: appUrl(database), poolMax: 4, applicationName: 'it0608' });
});
afterAll(async () => {
  await orm.close(true);
  await dropTestDatabase(database);
});

describe('[IT-06] dinheiro exato pelo driver e pelo ORM', () => {
  test('[IT-06] numeric volta como string; soma no banco é exata', async () => {
    const rows = await withClient(
      appUrl(database),
      async (client) =>
        (
          await client.query<{ s: unknown; t: string }>(
            "SELECT ('0.10'::money_amount + '0.20'::money_amount) AS s, pg_typeof('1.00'::money_amount)::text AS t",
          )
        ).rows,
    );
    expect(rows[0]).toEqual({ s: '0.30', t: 'money_amount' });
    // Exceção justificada: @types/pg tipa o parser como `any`; o retorno é conferido logo abaixo.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const parseNumeric: (value: string) => unknown = pg.types.getTypeParser(1700);
    expect(parseNumeric('123.45')).toBe('123.45');
  });

  test('[IT-06] nenhum código de src/ troca o parser de numeric', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('src/**/*.ts').scan({ cwd: process.cwd() })) {
      if (/setTypeParser|types\.setTypeParser/.test(await Bun.file(file).text())) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test('[IT-06] ida e volta do valor máximo pelo record do ORM, pelo ledger e pela reconciliação', async () => {
    const { walletId } = await withClient(appUrl(database), (client) =>
      openWalletSql(client, { balance: '999999999999999.99' }),
    );
    const queries = new OrmWalletQueries(orm);
    const wallet = await queries.findById(walletId);
    expect(wallet?.balance).toEqual({ amount: '999999999999999.99', currency: 'BRL' });
    const [entry] = await queries.ledgerAfter(walletId, 0, 10);
    expect(entry?.balanceAfter).toEqual({ amount: '999999999999999.99', currency: 'BRL' });
    const facts = await new SqlReconciliationReader(orm).read(walletId);
    expect(facts?.calculatedBalance).toBe('999999999999999.99');
    expect(Money.parseStored(wallet?.balance.amount ?? '', 'BRL').toString()).toBe('999999999999999.99');
  });

  test('[IT-06] soma de muitos centavos permanece exata (sem float)', async () => {
    const { walletId } = await withClient(appUrl(database), (client) => openWalletSql(client, { balance: '0.10' }));
    await withClient(appUrl(database), async (client) => {
      for (let i = 0; i < 9; i++) await movementSql(client, walletId, { kind: 'WIN', amount: '0.10' });
      await movementSql(client, walletId, { kind: 'WIN', amount: '0.20' });
    });
    const facts = await new SqlReconciliationReader(orm).read(walletId);
    expect([facts?.storedBalance, facts?.calculatedBalance]).toEqual(['1.20', '1.20']);
  });
});

describe('[IT-08] UnitOfWork: conexão única, guarda de transação e Identity Map', () => {
  const uow = () =>
    new MikroOrmUnitOfWork(
      orm,
      { lockTimeoutMs: 10_000, statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 60_000, maxAttempts: 3 },
      new NoopFaultInjector(),
    );

  test('[IT-08] todos os comandos da unidade usam a mesma conexão (pg_backend_pid) e os timeouts locais', async () => {
    const seen = await uow().run(async (databaseTransaction) => {
      const sql = toTransactionSql(databaseTransaction);
      const a = await sql.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const timeouts = await sql.one<{ lock: string; stmt: string }>(
        "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS stmt",
      );
      const b = await sql.one<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return { a: a?.pid, b: b?.pid, timeouts };
    });
    expect(seen.a).toBe(seen.b);
    expect(seen.timeouts).toEqual({ lock: '10s', stmt: '15s' });
  });

  test('[IT-08] escrever fora da unidade lança (handle vazado ou falso)', async () => {
    let leaked: DatabaseTransaction | undefined;
    await uow().run(async (databaseTransaction) => {
      leaked = databaseTransaction;
      await Promise.resolve();
    });
    expect(await rejectionOf(toTransactionSql(leaked ?? { kind: 'tx' }).run('SELECT 1'))).toBeInstanceOf(
      OutsideTransactionError,
    );
    expect(() => toTransactionSql({ kind: 'tx' })).toThrow(OutsideTransactionError);
  });

  test('[IT-08] erro dentro da unidade desfaz tudo', async () => {
    const { walletId } = await withClient(appUrl(database), (client) => openWalletSql(client, { balance: '10.00' }));
    const attempt = uow().run(async (databaseTransaction) => {
      await toTransactionSql(databaseTransaction).run('UPDATE wallets SET updated_at = now() WHERE id = ?', [walletId]);
      throw new Error('falha proposital');
    });
    expect(String(await rejectionOf(attempt))).toContain('falha proposital');
    const facts = await new SqlReconciliationReader(orm).read(walletId);
    expect(facts?.storedBalance).toBe('10.00');
  });

  test('[IT-08] Identity Map de um fork fica obsoleto; por isso o caminho financeiro usa SELECT … FOR UPDATE num fork novo', async () => {
    const { walletId } = await withClient(appUrl(database), (client) => openWalletSql(client, { balance: '10.00' }));
    const fork = orm.em.fork();
    const first = await fork.findOne(WalletRecord, { id: walletId });
    expect(first?.balance).toBe('10.00');
    await withClient(appUrl(database), (client) => movementSql(client, walletId, { kind: 'WIN', amount: '5.00' }));
    const cached = await fork.findOne(WalletRecord, { id: walletId });
    expect(cached?.balance).toBe('10.00');
    const fresh = await orm.em.fork().findOne(WalletRecord, { id: walletId });
    expect(fresh?.balance).toBe('15.00');
    const locked = await uow().run((databaseTransaction) =>
      toTransactionSql(databaseTransaction).one<{ b: string }>(
        'SELECT balance::text AS b FROM wallets WHERE id = ? FOR UPDATE',
        [walletId],
      ),
    );
    expect(locked?.b).toBe('15.00');
  });
});
