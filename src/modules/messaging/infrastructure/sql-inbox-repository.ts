import type { InboxDelivery, InboxOutcome, InboxStore } from '../../wagering/application/ports.ts';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import { toTransactionSql } from '../../../platform/persistence/unit-of-work.ts';

/**
 * Inbox do consumidor (D35), sempre DENTRO da transação da decisão. `ON CONFLICT DO NOTHING`
 * serializa entregas concorrentes do mesmo messageId: a segunda espera o commit da primeira e
 * não grava nada (o caso de uso desfaz a tentativa inteira).
 */
export class SqlInboxRepository implements InboxStore {
  async record(
    databaseTransaction: DatabaseTransaction,
    delivery: InboxDelivery,
    outcome: InboxOutcome,
    transactionId: string,
  ): Promise<boolean> {
    const rows = await toTransactionSql(databaseTransaction).all<unknown>(
      `INSERT INTO inbox_messages (consumer_name, message_id, envelope_hash, outcome, transaction_id, processed_at)
       VALUES (?, ?, ?, ?, ?::uuid, clock_timestamp())
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [delivery.consumerName, delivery.messageId, delivery.envelopeHash, outcome, transactionId],
    );
    return rows.length === 1;
  }
}
