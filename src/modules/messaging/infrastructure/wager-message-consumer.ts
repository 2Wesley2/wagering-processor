import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import { Counter, type Registry } from 'prom-client';
import { type ErrorCode, errorMeta, isErrorCode } from '../../../shared/error-catalog.ts';
import { DomainError } from '../../../shared/errors.ts';
import { deduplicationId } from '../../../shared/deduplication-id.ts';
import type { FaultContext, FaultInjector } from '../../../platform/lifecycle/fault-injection.ts';
import { ContextStore } from '../../../platform/observability/context.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import { pgErrorInfo } from '../../../platform/persistence/pg-errors.ts';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';
import type { QueueDirectory } from '../../../platform/sqs/queue-directory.ts';
import {
  DuplicateDeliveryError,
  type SubmitWagerTransaction,
} from '../../wagering/application/submit-wager-transaction.ts';
import { parseSqsEnvelope } from '../../wagering/contracts/submit-transaction.ts';
import { envelopeHash } from '../../wagering/domain/command-hash.ts';
import type { DeadLetterRow, DeadLetterStore } from './dead-letter-store.ts';
import {
  bodyHashOf,
  type DeadLetterKey,
  deadLetterKeyOf,
  DLQ_ATTRIBUTES,
  envelopeMessageIdOf,
} from './message-identity.ts';

export interface WagerMessageConsumerOptions {
  readonly consumerName: string;
  readonly inboundQueue: string;
  readonly dlq: string;
  readonly pollers: number;
  readonly waitTimeS: number;
  readonly visibilityTimeoutS: number;
  readonly retryBaseS: number;
  readonly retryMaxS: number;
  readonly deadLetterStuckAfterMs: number;
  /** Pausa da recepção quando o PostgreSQL está fora (circuit breaker, D35). */
  readonly breakerOpenMs: number;
}

export interface WagerMessageConsumerDependencies {
  readonly sqs: SQSClient;
  readonly queues: QueueDirectory;
  readonly sql: AutocommitSql;
  readonly deadLetters: DeadLetterStore;
  readonly submission: SubmitWagerTransaction;
  readonly faults: FaultInjector;
  readonly logger: AppLogger;
  readonly metrics: Registry;
}

/** Uma entrega recebida da fila de origem. */
interface Delivery {
  readonly sqsMessageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
  readonly groupId: string | undefined;
  readonly key: DeadLetterKey;
  /** messageId do envelope, quando legível (identidade nos logs e nos pontos de falha). */
  readonly messageId: string | undefined;
}

interface InFlight {
  readonly delivery: Delivery;
  done: Promise<void>;
  heartbeat: ReturnType<typeof setInterval> | undefined;
}

type Outcome =
  | { readonly type: 'ACK'; readonly result: string }
  | { readonly type: 'RETRY'; readonly reason: string; readonly cause?: unknown }
  | { readonly type: 'SETTLED' };

const inboxRowSchema = z.object({ envelopeHash: z.string() });

/**
 * Consumidor da fila de entrada (D35). Cada poller pede uma mensagem por vez (long poll); a
 * mensagem passa pelo MESMO caso de uso do HTTP, com a inbox na mesma transação SQL da decisão.
 * O ack (DeleteMessage) só acontece depois do commit.
 *
 * - Duplicata (inbox com o mesmo hash) → ack sem efeito; mesmo messageId com outro conteúdo →
 *   dead-letter MESSAGE_ID_PAYLOAD_MISMATCH.
 * - Negócio (REJECTED) → commit e ack. Transitório → sem ack; a visibilidade é adiada com backoff e,
 *   esgotado o maxReceiveCount, a RedrivePolicy do broker move a mensagem.
 * - Permanente e conflito → protocolo de dead-letter: a decisão é commitada, a cópia vai para a DLQ
 *   (DedupId estável por tentativa), o registro vira IN_DLQ e só então a origem é apagada. Uma
 *   reentrega retoma o protocolo do passo em que parou, sem reprocessar o negócio.
 */
export class WagerMessageConsumer {
  private running = false;
  private pollers: Promise<void>[] = [];
  private readonly inFlight = new Map<string, InFlight>();
  private readonly messagesTotal: Counter<'queue' | 'result'>;
  private readonly redeliveries: Counter<'queue'>;
  private breakerOpenUntil = 0;
  private readonly deadLettersTotal: Counter<'reason'>;
  private readonly stuckTotal: Counter;

  constructor(
    private readonly dependencies: WagerMessageConsumerDependencies,
    private readonly options: WagerMessageConsumerOptions,
  ) {
    const registers = [dependencies.metrics];
    this.messagesTotal = new Counter({
      name: 'sqs_messages_total',
      help: 'Mensagens da fila de entrada por fila e resultado',
      labelNames: ['queue', 'result'],
      registers,
    });
    this.redeliveries = new Counter({
      name: 'sqs_redeliveries_total',
      help: 'Entregas com ApproximateReceiveCount > 1 (reentregas)',
      labelNames: ['queue'],
      registers,
    });
    this.deadLettersTotal = new Counter({
      name: 'dlq_messages_total',
      help: 'Mensagens descartadas para a DLQ pelo consumidor, por motivo',
      labelNames: ['reason'],
      registers,
    });
    this.stuckTotal = new Counter({
      name: 'dead_letter_pending_stuck_total',
      help: 'Descartes em PENDING_DLQ acima do limite (o envio à DLQ não está concluindo)',
      registers,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollers = Array.from({ length: this.options.pollers }, (_, index) => this.poll(index));
    this.dependencies.logger.info(
      { event: 'consumer.started', pollers: this.options.pollers, consumer: this.options.consumerName },
      'consumer.started',
    );
  }

  /**
   * Encerramento (D37): para de emitir polls (o long poll corrente termina sozinho em ≤ Wait),
   * espera as mensagens em voo até `drainMs` e devolve a visibilidade (0) das que sobrarem.
   */
  async stop(drainMs: number): Promise<void> {
    if (!this.running) return;
    const { logger } = this.dependencies;
    this.running = false;
    logger.info({ event: 'pollers.stopped', inFlight: this.inFlight.size }, 'pollers.stopped');
    logger.info({ event: 'inflight.draining', count: this.inFlight.size, drainMs }, 'inflight.draining');
    // Os pollers terminam o long poll corrente (≤ Wait) e a mensagem que estiverem tratando.
    const finished = Promise.all(this.pollers);
    const timedOut = await Promise.race([finished.then(() => false), Bun.sleep(drainMs).then(() => true)]);
    for (const entry of this.inFlight.values()) {
      clearInterval(entry.heartbeat);
      await this.changeVisibility(entry.delivery, 0);
      logger.info({ event: 'visibility.returned', sqsMessageId: entry.delivery.sqsMessageId }, 'visibility.returned');
    }
    if (!timedOut) logger.info({ event: 'inflight.completed' }, 'inflight.completed');
  }

  private async poll(index: number): Promise<void> {
    const { sqs, queues, logger } = this.dependencies;
    while (this.running) {
      if (await this.waitWhileBreakerOpen()) continue;
      let messages: Message[];
      try {
        const queueUrl = await queues.urlOf(this.options.inboundQueue);
        // O long poll corrente nunca é abortado (o emulador não cancela poll de cliente morto, D37).
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: this.options.waitTimeS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
            MessageAttributeNames: ['All'],
          }),
        );
        messages = response.Messages ?? [];
      } catch (error) {
        if (await queues.recover(error).catch(() => false)) continue;
        logger.warn(
          { event: 'consumer.receive_failed', poller: index, error: describe(error) },
          'consumer.receive_failed',
        );
        await Bun.sleep(1000);
        continue;
      }
      for (const message of messages) await this.dispatch(message);
    }
  }

  /** Uma mensagem recebida: processa (em voo) ou, se a drenagem já começou, devolve à fila. */
  private async dispatch(message: Message): Promise<void> {
    const delivery = deliveryOf(message, this.options.consumerName);
    if (delivery === undefined) return;
    if (!this.running) {
      await this.changeVisibility(delivery, 0);
      this.dependencies.logger.info(
        { event: 'visibility.returned', sqsMessageId: delivery.sqsMessageId },
        'visibility.returned',
      );
      return;
    }
    const entry: InFlight = { delivery, done: Promise.resolve(), heartbeat: undefined };
    this.inFlight.set(delivery.sqsMessageId, entry);
    entry.done = this.process(entry).finally(() => this.inFlight.delete(delivery.sqsMessageId));
    await entry.done;
  }

  private async process(entry: InFlight): Promise<void> {
    const { delivery } = entry;
    const correlationId = delivery.messageId ?? delivery.sqsMessageId;
    const context = delivery.messageId === undefined ? {} : { messageId: delivery.messageId };
    await ContextStore.run({ ...context, correlationId, causationId: correlationId }, async () => {
      const { logger, faults } = this.dependencies;
      logger.info(
        { event: 'consumer.received', sqsMessageId: delivery.sqsMessageId, receiveCount: delivery.receiveCount },
        'consumer.received',
      );
      const outcome = await this.outcomeOf(entry, correlationId);
      const queue = this.options.inboundQueue;
      this.messagesTotal.inc({ queue, result: outcome.type === 'ACK' ? outcome.result : outcome.type.toLowerCase() });
      if (delivery.receiveCount > 1) this.redeliveries.inc({ queue });
      if (outcome.type === 'RETRY' && isDatabaseDown(outcome.cause)) this.openBreaker();
      else if (outcome.type !== 'RETRY') this.closeBreaker();
      if (outcome.type === 'ACK') {
        // Se a instância cair antes do ack, a inbox já gravada evita reaplicar a operação.
        await faults.hit('consumer.afterCommitBeforeAck', faultContextOf(delivery));
        await this.deleteSource(delivery);
        logger.info({ event: 'consumer.acked', result: outcome.result }, 'consumer.acked');
      } else if (outcome.type === 'RETRY') {
        const delayS = this.retryDelayS(delivery.receiveCount);
        await this.changeVisibility(delivery, delayS);
        logger.warn(
          { event: 'consumer.retry_scheduled', reason: outcome.reason, delayS, receiveCount: delivery.receiveCount },
          'consumer.retry_scheduled',
        );
      }
    });
  }

  /** Trata a entrega com heartbeat de visibilidade; qualquer erro inesperado vira retry (sem ack). */
  private async outcomeOf(entry: InFlight, correlationId: string): Promise<Outcome> {
    const { delivery } = entry;
    try {
      // Antes do heartbeat: uma mensagem segurada aqui deixa o VT vencer (reentrega, IT-23).
      await this.dependencies.faults.hit('consumer.afterReceive', faultContextOf(delivery));
    } catch (error) {
      return { type: 'RETRY', reason: describe(error), cause: error };
    }
    entry.heartbeat = this.startHeartbeat(delivery);
    try {
      return await this.handle(delivery, correlationId);
    } catch (error) {
      return { type: 'RETRY', reason: describe(error), cause: error };
    } finally {
      clearInterval(entry.heartbeat);
    }
  }

  private async handle(delivery: Delivery, correlationId: string): Promise<Outcome> {
    const { deadLetters, logger } = this.dependencies;
    // Descarte já decidido para ESTE corpo: retoma o protocolo sem reprocessar o negócio.
    const existing = await deadLetters.lookup(delivery.key);
    if (existing !== undefined && (existing.state === 'PENDING_DLQ' || existing.state === 'IN_DLQ')) {
      logger.info(
        { event: 'dlq.resume', state: existing.state, attempt: existing.attempt, receiveCount: delivery.receiveCount },
        'dlq.resume',
      );
      this.alertIfStuck(existing);
      return this.completeDeadLetter(delivery, existing);
    }

    const parsed = parseSqsEnvelope(delivery.body);
    if (!parsed.ok) return this.deadLetter(delivery, parsed.code);
    const message = parsed.value;
    const hash = envelopeHashOfBody(delivery.body);

    const inboxHash = await this.inboxHashOf(message.messageId);
    if (inboxHash !== undefined) return this.duplicateOrMismatch(delivery, inboxHash, hash);

    try {
      const result = await this.dependencies.submission.execute({
        command: message.command,
        idempotencyKey: message.idempotencyKey,
        correlationId,
        inbox: { consumerName: this.options.consumerName, messageId: message.messageId, envelopeHash: hash },
      });
      ContextStore.set({ transactionId: result.response.transactionId, walletId: message.command.walletId });
      logger.info(
        {
          event: 'consumer.processed',
          status: result.response.status,
          idempotentReplay: result.idempotentReplay,
          receiveCount: delivery.receiveCount,
        },
        'consumer.processed',
      );
      return { type: 'ACK', result: result.idempotentReplay ? 'replay' : result.response.status.toLowerCase() };
    } catch (error) {
      if (error instanceof DuplicateDeliveryError) {
        const committed = await this.inboxHashOf(message.messageId);
        if (committed !== undefined) return this.duplicateOrMismatch(delivery, committed, hash);
        return { type: 'RETRY', reason: 'duplicate_delivery_without_inbox' };
      }
      return this.classifyFailure(delivery, error);
    }
  }

  private async duplicateOrMismatch(delivery: Delivery, committedHash: string, hash: string): Promise<Outcome> {
    if (committedHash !== hash) return this.deadLetter(delivery, 'MESSAGE_ID_PAYLOAD_MISMATCH');
    this.dependencies.logger.info(
      { event: 'consumer.duplicate', receiveCount: delivery.receiveCount },
      'consumer.duplicate',
    );
    return { type: 'ACK', result: 'duplicate' };
  }

  /** Classes de erro do ErrorCatalog (D11) e do PostgreSQL (D26) → ação no consumidor. */
  private async classifyFailure(delivery: Delivery, error: unknown): Promise<Outcome> {
    const code = codeOf(error);
    if (code !== undefined) {
      const action = errorMeta(code).sqs;
      if (action === 'DLQ' || action === 'DEAD_LETTER') return this.deadLetter(delivery, code);
      if (action === 'ACK') return { type: 'ACK', result: 'business' };
      return { type: 'RETRY', reason: code };
    }
    // 23xxx no commit é bug (integridade); não adianta reentregar.
    if (pgErrorInfo(error).classification === 'INTEGRITY_BUG') return this.deadLetter(delivery, 'INTERNAL_ERROR');
    // Qualquer outro erro (banco fora, conflito esgotado, falha desconhecida): sem ack.
    return { type: 'RETRY', reason: describe(error), cause: error };
  }

  /** PostgreSQL fora: nenhuma mensagem é pedida enquanto o breaker estiver aberto. */
  private async waitWhileBreakerOpen(): Promise<boolean> {
    const remaining = this.breakerOpenUntil - Date.now();
    if (remaining <= 0) return false;
    await Bun.sleep(Math.min(250, remaining));
    return true;
  }

  private openBreaker(): void {
    const wasClosed = Date.now() >= this.breakerOpenUntil;
    this.breakerOpenUntil = Date.now() + this.options.breakerOpenMs;
    if (wasClosed) {
      this.dependencies.logger.warn(
        { event: 'consumer.breaker_open', openMs: this.options.breakerOpenMs },
        'consumer.breaker_open',
      );
    }
  }

  private closeBreaker(): void {
    if (this.breakerOpenUntil === 0) return;
    this.breakerOpenUntil = 0;
    this.dependencies.logger.info({ event: 'consumer.breaker_closed' }, 'consumer.breaker_closed');
  }

  private async deadLetter(delivery: Delivery, reason: string): Promise<Outcome> {
    const row = await this.dependencies.deadLetters.open(delivery.key, reason, delivery.sqsMessageId);
    this.deadLettersTotal.inc({ reason });
    this.dependencies.logger.warn(
      { event: 'consumer.dead_letter', reason, state: row.state, attempt: row.attempt },
      'consumer.dead_letter',
    );
    return this.completeDeadLetter(delivery, row);
  }

  /** Passos 3 a 5 do protocolo (D35), retomáveis em qualquer ponto. */
  private async completeDeadLetter(delivery: Delivery, row: DeadLetterRow): Promise<Outcome> {
    const { faults, deadLetters, logger } = this.dependencies;
    if (row.state === 'PENDING_DLQ') {
      const context = faultContextOf(delivery);
      await faults.hit('consumer.afterDeadLetterCommitBeforeSend', context);
      await faults.hit('consumer.dlqSendFails', context);
      const deduplication = await this.sendToDlq(delivery, row);
      await faults.hit('consumer.afterDlqSendBeforeDelete', context);
      await deadLetters.markInDlq(delivery.key, row.attempt);
      logger.info(
        { event: 'dlq.sent', attempt: row.attempt, reason: row.reason, deduplicationId: deduplication },
        'dlq.sent',
      );
    }
    await this.deleteSource(delivery);
    return { type: 'SETTLED' };
  }

  /** Envia a cópia à DLQ e devolve o MessageDeduplicationId usado (estável por tentativa). */
  private async sendToDlq(delivery: Delivery, row: DeadLetterRow): Promise<string> {
    const { sqs, queues } = this.dependencies;
    const deduplication = deduplicationId(
      'dlq',
      [delivery.key.consumerName, delivery.key.dlKey, delivery.key.bodyHash],
      [['a', row.attempt]],
    );
    const send = async () =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: await queues.urlOf(this.options.dlq),
          MessageBody: delivery.body,
          MessageGroupId: delivery.groupId ?? 'poison',
          MessageDeduplicationId: deduplication,
          MessageAttributes: {
            [DLQ_ATTRIBUTES.reason]: { DataType: 'String', StringValue: row.reason },
            [DLQ_ATTRIBUTES.consumerName]: { DataType: 'String', StringValue: delivery.key.consumerName },
            [DLQ_ATTRIBUTES.receiveCount]: { DataType: 'Number', StringValue: String(delivery.receiveCount) },
            [DLQ_ATTRIBUTES.attempt]: { DataType: 'Number', StringValue: String(row.attempt) },
            [DLQ_ATTRIBUTES.sourceMessageId]: { DataType: 'String', StringValue: delivery.sqsMessageId },
            [DLQ_ATTRIBUTES.deadLetterKey]: { DataType: 'String', StringValue: delivery.key.dlKey },
          },
        }),
      );
    try {
      await send();
    } catch (error) {
      if (!(await queues.recover(error))) throw error;
      await send();
    }
    return deduplication;
  }

  private alertIfStuck(row: DeadLetterRow): void {
    if (row.state !== 'PENDING_DLQ' || row.pendingForMs < this.options.deadLetterStuckAfterMs) return;
    this.stuckTotal.inc();
    this.dependencies.logger.warn(
      { event: 'dead_letter_pending_stuck', attempt: row.attempt, pendingForMs: row.pendingForMs },
      'dead_letter_pending_stuck',
    );
  }

  private async inboxHashOf(messageId: string): Promise<string | undefined> {
    const rows = await this.dependencies.sql.all<unknown>(
      `SELECT envelope_hash AS "envelopeHash" FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [this.options.consumerName, messageId],
    );
    return rows[0] === undefined ? undefined : inboxRowSchema.parse(rows[0]).envelopeHash;
  }

  private startHeartbeat(delivery: Delivery): ReturnType<typeof setInterval> {
    const everyMs = Math.max(1000, Math.floor((this.options.visibilityTimeoutS * 1000) / 3));
    return setInterval(() => {
      void this.changeVisibility(delivery, this.options.visibilityTimeoutS);
    }, everyMs);
  }

  private retryDelayS(receiveCount: number): number {
    const exponent = Math.max(0, Math.min(receiveCount - 1, 16));
    return Math.min(this.options.retryMaxS, this.options.retryBaseS * 2 ** exponent);
  }

  /** Falhas de visibilidade e de delete não são fatais (o emulador recusa handle antigo, D35). */
  private async changeVisibility(delivery: Delivery, seconds: number): Promise<void> {
    try {
      await this.dependencies.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: await this.dependencies.queues.urlOf(this.options.inboundQueue),
          ReceiptHandle: delivery.receiptHandle,
          VisibilityTimeout: seconds,
        }),
      );
    } catch (error) {
      this.dependencies.logger.debug(
        { event: 'consumer.visibility_failed', error: describe(error) },
        'consumer.visibility_failed',
      );
    }
  }

  private async deleteSource(delivery: Delivery): Promise<void> {
    try {
      await this.dependencies.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: await this.dependencies.queues.urlOf(this.options.inboundQueue),
          ReceiptHandle: delivery.receiptHandle,
        }),
      );
    } catch (error) {
      this.dependencies.logger.warn(
        { event: 'consumer.delete_failed', error: describe(error) },
        'consumer.delete_failed',
      );
    }
  }
}

function deliveryOf(message: Message, consumerName: string): Delivery | undefined {
  const { MessageId: sqsMessageId, ReceiptHandle: receiptHandle } = message;
  if (sqsMessageId === undefined || receiptHandle === undefined) return undefined;
  const body = message.Body ?? '';
  const receiveCount = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
  return {
    sqsMessageId,
    receiptHandle,
    body,
    receiveCount: Number.isSafeInteger(receiveCount) && receiveCount >= 1 ? receiveCount : 1,
    groupId: message.Attributes?.MessageGroupId,
    key: {
      consumerName,
      dlKey: deadLetterKeyOf(
        body,
        sqsMessageId,
        message.MessageAttributes?.[DLQ_ATTRIBUTES.deadLetterKey]?.StringValue,
      ),
      bodyHash: bodyHashOf(body),
    },
    messageId: envelopeMessageIdOf(body),
  };
}

function envelopeHashOfBody(body: string): string {
  // O corpo já passou pelo contrato (JSON objeto com type e data).
  const json: unknown = JSON.parse(body);
  if (typeof json !== 'object' || json === null || !('type' in json) || !('data' in json)) {
    throw new Error('envelope sem type/data depois do contrato');
  }
  return envelopeHash({ type: json.type, data: json.data });
}

/** PostgreSQL fora ou lento demais (conexão, timeout, indisponível): abre o breaker. */
function isDatabaseDown(error: unknown): boolean {
  if (error === undefined) return false;
  const classification = pgErrorInfo(error).classification;
  return classification === 'UNAVAILABLE' || classification === 'CONNECTION' || classification === 'TIMEOUT';
}

function faultContextOf(delivery: Delivery): FaultContext {
  return delivery.messageId === undefined ? {} : { messageId: delivery.messageId };
}

function codeOf(error: unknown): ErrorCode | undefined {
  return error instanceof DomainError && isErrorCode(error.code) ? error.code : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
