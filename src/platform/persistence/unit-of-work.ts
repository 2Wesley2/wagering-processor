import { IsolationLevel } from '@mikro-orm/core';
import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { DatabaseTransaction, UnitOfWork } from '../../shared/ports.ts';
import type { FaultContext, FaultInjector } from '../lifecycle/fault-injection.ts';
import { ContextStore } from '../observability/context.ts';
import { pgErrorInfo } from './pg-errors.ts';
import { READ_ENTITIES } from './records.ts';

/** Jitter de 0 a 19 ms entre tentativas; vem do gerador criptográfico (não há uso de segurança aqui). */
function retryJitterMs(): number {
  return (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) % 20;
}

export class OutsideTransactionError extends Error {
  constructor() {
    super('TxSql usado fora de uma transação ativa (D19)');
    this.name = 'OutsideTransactionError';
  }
}

/**
 * Único acesso a SQL cru do caminho financeiro (D19). Cada chamada confere que a
 * EntityManager ainda está dentro da transação: escrever fora da UoW lança.
 * Placeholders são `?` (MikroORM).
 */
export class TransactionSql implements DatabaseTransaction {
  readonly kind = 'tx';
  private closed = false;

  constructor(private readonly entityManager: EntityManager) {}

  async all<T>(sql: string, parameters: readonly unknown[] = []): Promise<T[]> {
    this.assertOpen();
    return this.entityManager.execute<T[]>(sql, [...parameters], 'all');
  }

  async one<T>(sql: string, parameters: readonly unknown[] = []): Promise<T | undefined> {
    const rows = await this.all<T>(sql, parameters);
    return rows[0];
  }

  /** Executa um comando e devolve o número de linhas afetadas. */
  async run(sql: string, parameters: readonly unknown[] = []): Promise<number> {
    this.assertOpen();
    const result = await this.entityManager.execute<{ affectedRows: number }>(sql, [...parameters], 'run');
    return result.affectedRows;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed || !this.entityManager.isInTransaction()) throw new OutsideTransactionError();
  }
}

/**
 * SQL em autocommit FORA do caminho financeiro: só para claims curtos de agenda com
 * `FOR UPDATE SKIP LOCKED` e lease (D24, D38, D40), que não tocam wallets nem dinheiro. Cada
 * comando é uma transação própria; nada aqui participa da UnitOfWork.
 */
export class AutocommitSql {
  constructor(private readonly orm: MikroORM) {}

  async all<T>(sql: string, parameters: readonly unknown[] = []): Promise<T[]> {
    return this.orm.em.fork({ clear: true }).execute<T[]>(sql, [...parameters], 'all');
  }

  /** Executa um comando e devolve o número de linhas afetadas. */
  async run(sql: string, parameters: readonly unknown[] = []): Promise<number> {
    const result = await this.orm.em
      .fork({ clear: true })
      .execute<{ affectedRows: number }>(sql, [...parameters], 'run');
    return result.affectedRows;
  }
}

/** Contexto do ponto de falha da UoW: o messageId da entrega SQS em curso, quando houver (D47). */
function faultContext(): FaultContext {
  const messageId = ContextStore.get().messageId;
  return messageId === undefined ? {} : { messageId };
}

export function toTransactionSql(transactionSql: DatabaseTransaction): TransactionSql {
  if (!(transactionSql instanceof TransactionSql)) throw new OutsideTransactionError();
  return transactionSql;
}

/** Métricas da UnitOfWork (D42): conflitos de lock/serialização e retries da unidade inteira. */
export interface UnitOfWorkObserver {
  conflict(reason: 'serialization' | 'deadlock' | 'lock_timeout', retried: boolean): void;
}

const CONFLICT_REASONS: Readonly<Record<string, 'serialization' | 'deadlock' | 'lock_timeout'>> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
};

export interface UnitOfWorkOptions {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  /** Sessão ociosa dentro da transação (processo congelado) é encerrada pelo servidor (D25). */
  readonly idleInTransactionTimeoutMs: number;
  readonly maxAttempts: number;
}

/**
 * UnitOfWork com MikroORM (D19, D26): um fork limpo por tentativa, READ COMMITTED,
 * timeouts locais, e retry da unidade inteira em 40001/40P01/55P03. Outros erros
 * (inclusive 23505) sobem para o caso de uso classificar.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions,
    private readonly faults: FaultInjector,
    private readonly observer?: UnitOfWorkObserver,
  ) {}

  async run<T>(work: (transactionSql: DatabaseTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(work);
      } catch (error) {
        const info = pgErrorInfo(error);
        const retry = info.classification === 'RETRY_UOW' && attempt < this.options.maxAttempts;
        const reason = info.sqlState === undefined ? undefined : CONFLICT_REASONS[info.sqlState];
        if (reason !== undefined) this.observer?.conflict(reason, retry);
        if (!retry) throw error;
        await Bun.sleep(10 * attempt + retryJitterMs());
      }
    }
  }

  private async once<T>(work: (transactionSql: DatabaseTransaction) => Promise<T>): Promise<T> {
    const entityManager = this.orm.em.fork({ clear: true });
    return entityManager.transactional(
      async (transactionalEntityManager) => {
        const transactionSql = new TransactionSql(transactionalEntityManager);
        try {
          await transactionSql.all(
            `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true),
                    set_config('idle_in_transaction_session_timeout', ?, true)`,
            [
              `${this.options.lockTimeoutMs}ms`,
              `${this.options.statementTimeoutMs}ms`,
              `${this.options.idleInTransactionTimeoutMs}ms`,
            ],
          );
          const result = await work(transactionSql);
          await this.faults.hit('uow.beforeCommit', faultContext());
          return result;
        } finally {
          transactionSql.close();
        }
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }
}

export interface OrmOptions {
  readonly databaseUrl: string;
  readonly poolMax: number;
  readonly applicationName: string;
  /** Lado do cliente (D25): desiste de uma consulta sem resposta e de uma conexão que não abre. */
  readonly queryTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export async function createOrm(options: OrmOptions): Promise<MikroORM> {
  const url = new URL(options.databaseUrl);
  url.searchParams.set('application_name', options.applicationName);
  return MikroORM.init({
    clientUrl: url.toString(),
    entities: READ_ENTITIES,
    allowGlobalContext: false,
    debug: false,
    pool: { min: 0, max: options.poolMax },
    // Repassado ao Pool do `pg` pelo driver do MikroORM 7. O application_name vai aqui também:
    // o MikroORM não repassa parâmetros de query do clientUrl ao pool.
    driverOptions: {
      keepAlive: true,
      application_name: options.applicationName,
      ...(options.queryTimeoutMs === undefined ? {} : { query_timeout: options.queryTimeoutMs }),
      ...(options.connectTimeoutMs === undefined ? {} : { connectionTimeoutMillis: options.connectTimeoutMs }),
    },
  });
}
