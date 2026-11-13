import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MikroORM } from '@mikro-orm/postgresql';
import { createTestDatabase, dropTestDatabase, ownerUrl } from '../support/db.ts';
import { writeEvidence } from '../support/evidence.ts';

/**
 * SPK-01 (informativo): MikroORM 7 + driver pg sob Bun 1.4. Verifica o que a
 * UnitOfWork da F2 vai assumir: uma transação usa UMA conexão (mesmo backend pid),
 * o contexto do AsyncLocalStorage sobrevive aos awaits do driver e o rollback
 * desfaz a escrita. Não é requisito do §13; falha aqui aciona o plano B.
 * Conecta como dono do banco: o role da app não cria tabelas nem tabelas
 * temporárias (REVOKE TEMPORARY), e aqui o objeto é o ORM, não os privilégios.
 */
let database: string;
let orm: MikroORM;

beforeAll(async () => {
  database = await createTestDatabase('spk01');
  orm = await MikroORM.init({
    clientUrl: ownerUrl(database),
    entities: [],
    discovery: { warnWhenNoEntities: false },
    allowGlobalContext: false,
    debug: false,
  });
});

afterAll(async () => {
  await orm.close(true);
  await dropTestDatabase(database);
});

describe('[SPK-01] spike MikroORM 7 + ALS + pg', () => {
  test('[SPK-01] transação com conexão única, ALS preservado e rollback efetivo', async () => {
    const als = new AsyncLocalStorage<{ correlationId: string }>();
    const entityManager = orm.em.fork();
    const observed = await als.run({ correlationId: 'spk-1' }, () =>
      entityManager.transactional(async (transactionalEntityManager) => {
        const a = await transactionalEntityManager.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        await transactionalEntityManager.execute('CREATE TEMP TABLE spk (v numeric) ON COMMIT DROP');
        await transactionalEntityManager.execute("INSERT INTO spk VALUES ('999999999999999.99')");
        const numericRows = await transactionalEntityManager.execute<{ v: string }[]>('SELECT v FROM spk');
        const b = await transactionalEntityManager.execute<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
        return { pidA: a[0]?.pid, pidB: b[0]?.pid, value: numericRows[0]?.v, ctx: als.getStore()?.correlationId };
      }),
    );
    writeEvidence('SPK-01', observed);
    expect(observed.pidA).toBe(observed.pidB);
    expect(observed.ctx).toBe('spk-1');
    // numeric volta como string, sem perda (D15): nenhum parser numérico no caminho.
    expect(observed.value).toBe('999999999999999.99');

    const rolledBack = await orm.em
      .fork()
      .transactional(async (transactionalEntityManager) => {
        await transactionalEntityManager.execute('CREATE TABLE spk_rb (id int)');
        throw new Error('rollback proposital');
      })
      .then(
        () => 'committed',
        () => 'rolled_back',
      );
    expect(rolledBack).toBe('rolled_back');
    const exists = await orm.em
      .fork()
      .execute<{ n: string }[]>("SELECT count(*)::text AS n FROM pg_class WHERE relname = 'spk_rb'");
    expect(exists[0]?.n).toBe('0');
  });
});
