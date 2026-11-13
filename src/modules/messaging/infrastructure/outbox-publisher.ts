import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Counter, Histogram, type Registry } from 'prom-client';
import { z } from 'zod';
import type { FaultInjector } from '../../../platform/lifecycle/fault-injection.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';
import type { QueueDirectory } from '../../../platform/sqs/queue-directory.ts';
import { assertDeduplicationId } from '../../../shared/deduplication-id.ts';

export interface OutboxPublisherOptions {
  readonly eventsQueue: string;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly backoffMs: (attempts: number) => number;
}

export interface OutboxPublisherDependencies {
  readonly sql: AutocommitSql;
  readonly sqs: SQSClient;
  readonly queues: QueueDirectory;
  readonly faults: FaultInjector;
  readonly logger: AppLogger;
  readonly metrics: Registry;
}

const claimedSchema = z.object({
  id: z.string(),
  seq: z.coerce.number(),
  groupId: z.string(),
  eventType: z.string(),
  correlationId: z.string().nullable(),
  payload: z.string(),
  createdAtMs: z.coerce.number(),
});
type Claimed = z.infer<typeof claimedSchema>;

/**
 * Relay da outbox (D38), papel `outbox-publisher`. Várias instâncias competem sem eleição de líder:
 * o claim é curto, em autocommit, com `FOR UPDATE SKIP LOCKED`, lease e `claim_token`. O envio
 * acontece fora de qualquer transação; `published_at` é marcado só para os itens aceitos pela fila,
 * sem fencing (um reenvio por lease vencido é absorvido pela deduplicação FIFO na janela de 5 min
 * e, fora dela, pelo eventId no consumidor). O fencing vale para reagendar e liberar o claim.
 * MessageDeduplicationId = eventId (UUID): nunca muda, nem num reenvio.
 */
export class OutboxPublisher {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private readonly published: Counter;
  private readonly failures: Counter;
  private readonly lag: Histogram;

  constructor(
    private readonly dependencies: OutboxPublisherDependencies,
    private readonly options: OutboxPublisherOptions,
  ) {
    this.published = new Counter({
      name: 'outbox_published_total',
      help: 'Eventos da outbox aceitos pela fila de eventos',
      registers: [dependencies.metrics],
    });
    this.lag = new Histogram({
      name: 'outbox_publish_lag_seconds',
      help: 'Tempo entre a gravação do evento (commit) e a confirmação da fila',
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900],
      registers: [dependencies.metrics],
    });
    this.failures = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Eventos da outbox recusados pela fila (reagendados com backoff)',
      registers: [dependencies.metrics],
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.dependencies.logger.info({ event: 'outbox_publisher.started' }, 'outbox_publisher.started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.dependencies.logger.info({ event: 'outbox_publisher.stopped' }, 'outbox_publisher.stopped');
  }

  /** Uma rodada: reivindica um lote, publica e marca. Devolve quantos eventos foram aceitos. */
  async tick(): Promise<number> {
    const token = Bun.randomUUIDv7();
    const claimed = await this.claim(token);
    if (claimed.length === 0) return 0;
    for (const item of claimed)
      await this.dependencies.faults.hit('outbox.afterClaimBeforePublish', { eventId: item.id });

    let successful: string[];
    const failed = new Map<string, string>();
    try {
      ({ successful } = await this.send(claimed, failed));
    } catch (error) {
      if (await this.dependencies.queues.recover(error).catch(() => false)) {
        ({ successful } = await this.send(claimed, failed));
      } else {
        successful = [];
        for (const item of claimed) failed.set(item.id, describe(error));
      }
    }
    for (const eventId of successful) await this.dependencies.faults.hit('outbox.afterPublishBeforeMark', { eventId });
    await this.markPublished(successful);
    const now = Date.now();
    for (const item of claimed) {
      if (successful.includes(item.id)) this.lag.observe(Math.max(0, now - item.createdAtMs) / 1000);
    }
    for (const [eventId, reason] of failed) await this.scheduleRetry(eventId, token, reason);
    this.published.inc(successful.length);
    if (failed.size > 0) {
      this.failures.inc(failed.size);
      this.dependencies.logger.warn({ event: 'outbox.publish_failed', count: failed.size }, 'outbox.publish_failed');
    }
    return successful.length;
  }

  private async claim(token: string): Promise<Claimed[]> {
    const rows = await this.dependencies.sql.all<unknown>(
      `UPDATE outbox_messages o
          SET claim_token = ?::uuid, claimed_until = clock_timestamp() + make_interval(secs => ?::numeric / 1000)
        WHERE o.id IN (SELECT id FROM outbox_messages
                        WHERE published_at IS NULL AND next_attempt_at <= clock_timestamp()
                          AND (claimed_until IS NULL OR claimed_until < clock_timestamp())
                        ORDER BY seq
                        LIMIT ?
                          FOR UPDATE SKIP LOCKED)
        RETURNING o.id::text AS id, o.seq::text AS seq, o.message_group_id AS "groupId", o.event_type AS "eventType",
                  o.payload ->> 'correlationId' AS "correlationId", o.payload::text AS payload,
                  (extract(epoch FROM o.created_at) * 1000)::bigint::text AS "createdAtMs"`,
      [token, this.options.leaseMs, this.options.batchSize],
    );
    return rows.map((row) => claimedSchema.parse(row)).sort((left, right) => left.seq - right.seq);
  }

  private async send(claimed: readonly Claimed[], failed: Map<string, string>): Promise<{ successful: string[] }> {
    const { sqs, queues } = this.dependencies;
    const response = await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await queues.urlOf(this.options.eventsQueue),
        Entries: claimed.map((item, index) => ({
          Id: String(index),
          MessageBody: item.payload,
          MessageGroupId: item.groupId,
          MessageDeduplicationId: assertDeduplicationId(item.id),
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: item.eventType },
            ...(item.correlationId === null
              ? {}
              : { correlationId: { DataType: 'String', StringValue: item.correlationId } }),
          },
        })),
      }),
    );
    const byIndex = (id: string | undefined) => (id === undefined ? undefined : claimed[Number.parseInt(id, 10)]);
    const successful: string[] = [];
    for (const entry of response.Successful ?? []) {
      const item = byIndex(entry.Id);
      if (item !== undefined) successful.push(item.id);
    }
    for (const entry of response.Failed ?? []) {
      const item = byIndex(entry.Id);
      if (item !== undefined) failed.set(item.id, `${entry.Code ?? 'Failed'}: ${entry.Message ?? ''}`);
    }
    return { successful };
  }

  /** Sem fencing: só os itens aceitos, e `published_at` só de NULL para um valor (trigger). */
  private async markPublished(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const placeholders = eventIds.map(() => '?::uuid').join(', ');
    await this.dependencies.sql.run(
      `UPDATE outbox_messages SET published_at = clock_timestamp(), claim_token = NULL, claimed_until = NULL
        WHERE id IN (${placeholders}) AND published_at IS NULL`,
      [...eventIds],
    );
  }

  /** Com fencing: só quem ainda detém o claim reagenda. */
  private async scheduleRetry(eventId: string, token: string, reason: string): Promise<void> {
    const attempts = await this.dependencies.sql.all<unknown>(
      'SELECT attempts FROM outbox_messages WHERE id = ?::uuid',
      [eventId],
    );
    const current = z.object({ attempts: z.coerce.number() }).safeParse(attempts[0]);
    const delayMs = this.options.backoffMs(current.success ? current.data.attempts : 0);
    await this.dependencies.sql.run(
      `UPDATE outbox_messages
          SET attempts = attempts + 1, next_attempt_at = clock_timestamp() + make_interval(secs => ?::numeric / 1000),
              claim_token = NULL, claimed_until = NULL, last_error = left(?, 500)
        WHERE id = ?::uuid AND claim_token = ?::uuid AND published_at IS NULL`,
      [delayMs, reason, eventId, token],
    );
  }

  private async run(): Promise<void> {
    while (this.running) {
      let published = 0;
      try {
        published = await this.tick();
      } catch (error) {
        this.dependencies.logger.warn(
          { event: 'outbox_publisher.tick_failed', error: describe(error) },
          'outbox_publisher.tick_failed',
        );
      }
      if (!this.running) break;
      // Lote cheio: há mais trabalho; senão espera o intervalo.
      if (published >= this.options.batchSize) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollIntervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
