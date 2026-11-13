import type { MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionRecord } from '../../../platform/persistence/records.ts';
import type { TransactionQueries, TransactionRow } from '../application/ports.ts';
import { parseTransactionRow } from './transaction-row.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Leituras de transações com o record do ORM, sempre num fork novo (sem Identity Map entre
 * requisições). Servem ao caminho rápido de idempotência e aos GETs; a decisão financeira relê
 * sob o lock da wallet pelo SQL explícito.
 */
export class OrmTransactionQueries implements TransactionQueries {
  constructor(private readonly orm: MikroORM) {}

  async findById(transactionId: string): Promise<TransactionRow | undefined> {
    if (!UUID_RE.test(transactionId)) return undefined;
    return this.findOne({ id: transactionId });
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<TransactionRow | undefined> {
    return this.findOne({ idempotencyKey });
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRow | undefined> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(
    where: { id: string } | { idempotencyKey: string } | { providerId: string; externalTransactionId: string },
  ): Promise<TransactionRow | undefined> {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, where);
    return record === null ? undefined : parseTransactionRow(record);
  }
}
