import type { IntegrationEvent } from '../../../shared/integration-event.ts';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import { toTransactionSql } from '../../../platform/persistence/unit-of-work.ts';

/**
 * Grava eventos na outbox DENTRO da transação financeira (§6.5, §11): nada é
 * publicado antes do commit. A publicação (relay) é da F5.
 * MessageGroupId = walletId (ordem por wallet na fila FIFO); id = eventId.
 */
export class SqlOutboxRepository {
  async append(databaseTransaction: DatabaseTransaction, events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    const sql = toTransactionSql(databaseTransaction);
    for (const event of events) {
      const envelope = event.toJSON();
      await sql.run(
        `INSERT INTO outbox_messages (id, aggregate_id, message_group_id, event_type, event_version, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)`,
        [
          event.eventId,
          event.aggregateId,
          event.aggregateId,
          envelope.eventType,
          envelope.version,
          JSON.stringify(envelope),
          event.occurredAt,
        ],
      );
    }
  }
}
