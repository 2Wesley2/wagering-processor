import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { republishDeduplicationId } from '../../../shared/deduplication-id.ts';
import type { FaultInjector } from '../../../platform/lifecycle/fault-injection.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';
import type { QueueDirectory } from '../../../platform/sqs/queue-directory.ts';

export interface RepublishFilter {
  readonly since: Date;
  readonly until?: Date;
  readonly aggregateId?: string;
  readonly eventId?: string;
}

export interface RepublishReport {
  readonly runId: string;
  readonly selected: number;
  readonly republished: number;
  readonly failed: number;
}

const rowSchema = z.object({
  id: z.string(),
  seq: z.coerce.number(),
  groupId: z.string(),
  eventType: z.string(),
  correlationId: z.string().nullable(),
  payload: z.string(),
});
type Row = z.infer<typeof rowSchema>;

const MAX_ATTEMPTS = 5;

/**
 * `outbox:republish` (D38): reenvia, por decisão de um operador, eventos JÁ PUBLICADOS que ainda
 * estão na outbox (a retenção apaga os publicados há mais de `RETENTION_OUTBOX_DAYS`, padrão 7
 * dias). Eventos que ainda aguardam publicação ficam com o publicador.
 *
 * - O eventId (no corpo) nunca muda: o consumidor deduplica por ele.
 * - MessageDeduplicationId = `rp:<eventId>:<runId>`, com runId novo por execução: o FIFO não
 *   descarta o reenvio (nem dentro da janela de 5 min da publicação original) e, dentro da mesma
 *   execução, as tentativas repetem o mesmo id (o FIFO absorve um reenvio da própria execução).
 * - Registra `last_republished_at` dos eventos aceitos.
 */
export class OutboxRepublisher {
  constructor(
    private readonly sql: AutocommitSql,
    private readonly sqs: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly faults: FaultInjector,
    private readonly logger: AppLogger,
    private readonly eventsQueue: string,
  ) {}

  async run(filter: RepublishFilter, runId: string = Bun.randomUUIDv7()): Promise<RepublishReport> {
    const rows = await this.select(filter);
    let republished = 0;
    let failed = 0;
    for (let index = 0; index < rows.length; index += 10) {
      const result = await this.sendBatch(rows.slice(index, index + 10), runId);
      republished += result.sent.length;
      failed += result.failed;
      await this.markRepublished(result.sent);
    }
    const report = { runId, selected: rows.length, republished, failed };
    this.logger.info({ event: 'outbox.republished', ...report }, 'outbox.republished');
    return report;
  }

  private async select(filter: RepublishFilter): Promise<Row[]> {
    const rows = await this.sql.all<unknown>(
      `SELECT id::text AS id, seq::text AS seq, message_group_id AS "groupId", event_type AS "eventType",
              payload ->> 'correlationId' AS "correlationId", payload::text AS payload
         FROM outbox_messages
        WHERE published_at IS NOT NULL
          AND created_at >= ?::timestamptz
          AND (?::timestamptz IS NULL OR created_at < ?::timestamptz)
          AND (?::uuid IS NULL OR aggregate_id = ?::uuid)
          AND (?::uuid IS NULL OR id = ?::uuid)
        ORDER BY seq`,
      [
        filter.since.toISOString(),
        filter.until?.toISOString() ?? null,
        filter.until?.toISOString() ?? null,
        filter.aggregateId ?? null,
        filter.aggregateId ?? null,
        filter.eventId ?? null,
        filter.eventId ?? null,
      ],
    );
    return rows.map((row) => rowSchema.parse(row));
  }

  /** Um lote com até MAX_ATTEMPTS tentativas; cada evento mantém o MESMO DedupId nesta execução. */
  private async sendBatch(batch: readonly Row[], runId: string): Promise<{ sent: string[]; failed: number }> {
    let pending = [...batch];
    const sent: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && pending.length > 0; attempt++) {
      const accepted = await this.attempt(pending, runId);
      for (const row of pending) {
        this.logger.info(
          {
            event: 'outbox.republish_attempt',
            eventId: row.id,
            attempt,
            deduplicationId: republishDeduplicationId(row.id, runId),
            accepted: accepted.has(row.id),
          },
          'outbox.republish_attempt',
        );
      }
      sent.push(...pending.filter((row) => accepted.has(row.id)).map((row) => row.id));
      pending = pending.filter((row) => !accepted.has(row.id));
      if (pending.length > 0) await Bun.sleep(200 * attempt);
    }
    return { sent, failed: pending.length };
  }

  /** Uma tentativa de envio; devolve os eventIds aceitos pela fila. */
  private async attempt(pending: readonly Row[], runId: string): Promise<Set<string>> {
    const accepted = new Set<string>();
    try {
      for (const row of pending) await this.faults.hit('republish.beforeSend', { eventId: row.id });
      const response = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: await this.queues.urlOf(this.eventsQueue),
          Entries: pending.map((row, index) => ({
            Id: String(index),
            MessageBody: row.payload,
            MessageGroupId: row.groupId,
            MessageDeduplicationId: republishDeduplicationId(row.id, runId),
            MessageAttributes: {
              eventType: { DataType: 'String', StringValue: row.eventType },
              republishRunId: { DataType: 'String', StringValue: runId },
              ...(row.correlationId === null
                ? {}
                : { correlationId: { DataType: 'String', StringValue: row.correlationId } }),
            },
          })),
        }),
      );
      for (const entry of response.Successful ?? []) {
        const row = pending[Number.parseInt(entry.Id ?? '', 10)];
        if (row !== undefined) accepted.add(row.id);
      }
    } catch (error) {
      await this.queues.recover(error).catch(() => false);
    }
    return accepted;
  }

  private async markRepublished(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await this.sql.run(
      `UPDATE outbox_messages SET last_republished_at = clock_timestamp()
        WHERE id IN (${eventIds.map(() => '?::uuid').join(', ')})`,
      [...eventIds],
    );
  }
}
