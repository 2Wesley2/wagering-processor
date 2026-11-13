import { DeleteMessageCommand, type Message, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Counter, type Registry } from 'prom-client';
import { z } from 'zod';
import type { UnitOfWork } from '../../../shared/ports.ts';
import { ContextStore } from '../../../platform/observability/context.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import { toTransactionSql } from '../../../platform/persistence/unit-of-work.ts';
import type { QueueDirectory } from '../../../platform/sqs/queue-directory.ts';
import { bodyHashOf } from './message-identity.ts';

export const PROJECTION_CONSUMER = 'wallet-events-projection';

const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  aggregateId: z.uuid(),
  data: z.unknown(),
});

const balanceChangedSchema = z.object({
  walletId: z.uuid(),
  walletVersion: z.number().int().min(1),
  balanceAfter: z.object({ amount: z.string().regex(/^\d{1,15}\.\d{2}$/), currency: z.string() }),
});

export interface WalletEventsProjectionOptions {
  readonly eventsQueue: string;
  readonly waitTimeS: number;
}

/**
 * Consumidor de referência dos eventos de integração (D39), papel `events-projection`. Prova que
 * publicar em duplicata (reenvio do publicador, `outbox:republish`) é seguro: cada eventId é
 * aplicado no máximo uma vez (inbox do consumidor `wallet-events-projection`, mesma transação da
 * projeção) e o saldo projetado só avança para uma `walletVersion` maior. Logs:
 * `projection.received`, `projection.applied` e `projection.duplicate`, sempre com o eventId.
 */
export class WalletEventsProjection {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly received: Counter<'outcome'>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: AppLogger,
    metrics: Registry,
    private readonly options: WalletEventsProjectionOptions,
  ) {
    this.received = new Counter({
      name: 'projection_events_total',
      help: 'Eventos recebidos pela projeção de referência, por resultado',
      labelNames: ['outcome'],
      registers: [metrics],
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info({ event: 'projection.started', consumer: PROJECTION_CONSUMER }, 'projection.started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.loop;
    this.logger.info({ event: 'projection.stopped' }, 'projection.stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.queues.urlOf(this.options.eventsQueue),
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.options.waitTimeS,
          }),
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (!(await this.queues.recover(error).catch(() => false))) {
          this.logger.warn({ event: 'projection.receive_failed', error: describe(error) }, 'projection.receive_failed');
          await Bun.sleep(1000);
        }
        continue;
      }
      for (const message of messages) {
        try {
          await this.handle(message);
        } catch (error) {
          // Sem ack: a fila reentrega depois do VT.
          this.logger.warn({ event: 'projection.failed', error: describe(error) }, 'projection.failed');
        }
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const body = message.Body ?? '';
    const parsed = envelopeSchema.safeParse(safeJson(body));
    if (!parsed.success) {
      this.received.inc({ outcome: 'invalid' });
      this.logger.warn({ event: 'projection.invalid_event' }, 'projection.invalid_event');
      await this.ack(message);
      return;
    }
    const envelope = parsed.data;
    await ContextStore.run({ correlationId: envelope.eventId, walletId: envelope.aggregateId }, async () => {
      this.logger.info(
        { event: 'projection.received', eventId: envelope.eventId, eventType: envelope.eventType },
        'projection.received',
      );
      const applied = await this.unitOfWork.run(async (databaseTransaction) => {
        const sql = toTransactionSql(databaseTransaction);
        const inserted = await sql.all<unknown>(
          `INSERT INTO inbox_messages (consumer_name, message_id, envelope_hash, outcome, transaction_id, processed_at)
           VALUES (?, ?, ?, 'PROCESSED', NULL, clock_timestamp())
           ON CONFLICT (consumer_name, message_id) DO NOTHING RETURNING message_id`,
          [PROJECTION_CONSUMER, envelope.eventId, bodyHashOf(body)],
        );
        if (inserted.length === 0) return false;
        const balance = balanceChangedSchema.safeParse(envelope.data);
        if (envelope.eventType === 'WalletBalanceChanged' && balance.success) {
          await sql.run(
            `INSERT INTO wallet_events_projection (wallet_id, balance, wallet_version, last_event_id, updated_at)
             VALUES (?::uuid, ?::numeric, ?, ?::uuid, clock_timestamp())
             ON CONFLICT (wallet_id) DO UPDATE
                SET balance = EXCLUDED.balance, wallet_version = EXCLUDED.wallet_version,
                    last_event_id = EXCLUDED.last_event_id, updated_at = EXCLUDED.updated_at
              WHERE wallet_events_projection.wallet_version < EXCLUDED.wallet_version`,
            [balance.data.walletId, balance.data.balanceAfter.amount, balance.data.walletVersion, envelope.eventId],
          );
        }
        return true;
      });
      this.received.inc({ outcome: applied ? 'applied' : 'duplicate' });
      this.logger.info(
        { event: applied ? 'projection.applied' : 'projection.duplicate', eventId: envelope.eventId },
        applied ? 'projection.applied' : 'projection.duplicate',
      );
      await this.ack(message);
    });
  }

  private async ack(message: Message): Promise<void> {
    if (message.ReceiptHandle === undefined) return;
    try {
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: await this.queues.urlOf(this.options.eventsQueue),
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    } catch (error) {
      this.logger.warn({ event: 'projection.delete_failed', error: describe(error) }, 'projection.delete_failed');
    }
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
