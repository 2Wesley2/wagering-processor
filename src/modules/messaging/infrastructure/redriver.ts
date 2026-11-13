import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { deduplicationId } from '../../../shared/deduplication-id.ts';
import type { FaultContext, FaultInjector } from '../../../platform/lifecycle/fault-injection.ts';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { QueueDirectory } from '../../../platform/sqs/queue-directory.ts';
import type { DeadLetterStore } from './dead-letter-store.ts';
import {
  bodyHashOf,
  type DeadLetterKey,
  deadLetterKeyOf,
  DLQ_ATTRIBUTES,
  envelopeMessageIdOf,
} from './message-identity.ts';

export interface RedriveOptions {
  readonly sourceQueue: string;
  readonly dlq: string;
  readonly consumerName: string;
  readonly visibilityTimeoutS: number;
  /** Rodadas seguidas sem mensagem antes de encerrar. */
  readonly idleRounds: number;
}

export interface RedriveReport {
  redriven: number;
  obsolete: number;
  skipped: number;
  /** Cópias novas de uma chave já tratada nesta execução: ficam para a próxima. */
  deferred: number;
}

/**
 * `sqs:redrive` (D36). Para cada cópia lida da DLQ:
 * 1. decide a partir do registro (consumidor, dl_key, body_hash) e do atributo `dlAttempt`
 *    (ausente = cópia movida pelo broker, sempre redrivada) e commita REDRIVE_PENDING;
 * 2. reenvia à origem com DedupId estável por (tentativa, redrive);
 * 3. marca REDRIVEN; 4. apaga a cópia da DLQ.
 * Uma queda entre os passos é retomada rodando o script de novo: o reenvio repetido usa o mesmo
 * DedupId, e uma cópia já redrivada é reconhecida como obsoleta e só apagada.
 *
 * Cada chave (consumidor, dl_key, body_hash) é redrivada no máximo uma vez por execução: uma
 * mensagem que falha de novo volta à DLQ com tentativa nova e fica para a próxima execução (sem
 * isso, uma mensagem inválida circularia sem fim). Cópias obsoletas são apagadas mesmo assim.
 */
export class Redriver {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueDirectory,
    private readonly deadLetters: DeadLetterStore,
    private readonly faults: FaultInjector,
    private readonly logger: AppLogger,
    private readonly options: RedriveOptions,
  ) {}

  async run(): Promise<RedriveReport> {
    const report: RedriveReport = { redriven: 0, obsolete: 0, skipped: 0, deferred: 0 };
    const handled = new Set<string>();
    const dlqUrl = await this.queues.urlOf(this.options.dlq);
    let idle = 0;
    while (idle < this.options.idleRounds) {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: dlqUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
          VisibilityTimeout: this.options.visibilityTimeoutS,
          MessageSystemAttributeNames: ['MessageGroupId'],
          MessageAttributeNames: ['All'],
        }),
      );
      let worked = false;
      for (const message of response.Messages ?? []) {
        if (await this.redriveOne(dlqUrl, message, report, handled)) worked = true;
      }
      idle = worked ? 0 : idle + 1;
    }
    this.logger.info({ event: 'redrive.done', ...report }, 'redrive.done');
    return report;
  }

  /** Verdadeiro quando a cópia foi tratada (redrivada ou apagada como obsoleta). */
  private async redriveOne(
    dlqUrl: string,
    message: Message,
    report: RedriveReport,
    handled: Set<string>,
  ): Promise<boolean> {
    const { MessageId: copyId, ReceiptHandle: receiptHandle } = message;
    if (copyId === undefined || receiptHandle === undefined) return false;
    const body = message.Body ?? '';
    const attributes = message.MessageAttributes ?? {};
    const sourceMessageId = attributes[DLQ_ATTRIBUTES.sourceMessageId]?.StringValue ?? copyId;
    const key: DeadLetterKey = {
      consumerName: attributes[DLQ_ATTRIBUTES.consumerName]?.StringValue ?? this.options.consumerName,
      dlKey: deadLetterKeyOf(body, sourceMessageId, attributes[DLQ_ATTRIBUTES.deadLetterKey]?.StringValue),
      bodyHash: bodyHashOf(body),
    };
    const rawAttempt = attributes[DLQ_ATTRIBUTES.attempt]?.StringValue;
    const dlAttempt = rawAttempt === undefined ? undefined : Number.parseInt(rawAttempt, 10);
    const messageId = envelopeMessageIdOf(body);
    const context: FaultContext = messageId === undefined ? {} : { messageId };

    const attempt =
      dlAttempt !== undefined && Number.isSafeInteger(dlAttempt) && dlAttempt >= 1 ? dlAttempt : undefined;
    const log = { dlKey: key.dlKey, dlAttempt: attempt ?? null, brokerMoved: rawAttempt === undefined };
    const handledKey = JSON.stringify([key.consumerName, key.dlKey, key.bodyHash]);
    if (handled.has(handledKey)) {
      const peek = await this.deadLetters.peekRedrive(key, attempt);
      if (typeof peek !== 'string' && peek.type === 'OBSOLETE')
        return this.obsolete(dlqUrl, receiptHandle, report, log);
      report.deferred += 1;
      this.logger.info({ event: 'redrive.deferred', ...log }, 'redrive.deferred');
      return false;
    }
    const decision = await this.deadLetters.beginRedrive(key, attempt, sourceMessageId);
    if (decision.type === 'SKIP') {
      report.skipped += 1;
      this.logger.info({ event: 'redrive.skipped', ...log, state: decision.state }, 'redrive.skipped');
      return false;
    }
    if (decision.type === 'OBSOLETE') return this.obsolete(dlqUrl, receiptHandle, report, log);
    handled.add(handledKey);
    const deduplication = deduplicationId(
      'rd',
      [key.consumerName, key.dlKey, key.bodyHash],
      [
        ['a', decision.attempt],
        ['r', decision.redriveCount],
      ],
    );
    this.logger.info({ event: 'redrive.sending', ...log, deduplicationId: deduplication }, 'redrive.sending');
    await this.faults.hit('redrive.afterPendingBeforeSend', context);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.urlOf(this.options.sourceQueue),
        // Corpo intacto; a identidade do descarte segue no atributo (o SQS dá MessageId novo).
        MessageBody: body,
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'redrive',
        MessageDeduplicationId: deduplication,
        MessageAttributes: {
          [DLQ_ATTRIBUTES.deadLetterKey]: { DataType: 'String', StringValue: key.dlKey },
          [DLQ_ATTRIBUTES.consumerName]: { DataType: 'String', StringValue: key.consumerName },
        },
      }),
    );
    await this.faults.hit('redrive.afterSendBeforeMark', context);
    await this.deadLetters.markRedriven(key, decision.attempt);
    await this.faults.hit('redrive.afterMarkBeforeDelete', context);
    await this.deleteCopy(dlqUrl, receiptHandle);
    report.redriven += 1;
    this.logger.info(
      {
        event: 'redrive.sent',
        ...log,
        attempt: decision.attempt,
        redriveCount: decision.redriveCount,
        deduplicationId: deduplication,
      },
      'redrive.sent',
    );
    return true;
  }

  private async obsolete(
    dlqUrl: string,
    receiptHandle: string,
    report: RedriveReport,
    log: Record<string, unknown>,
  ): Promise<boolean> {
    await this.deleteCopy(dlqUrl, receiptHandle);
    report.obsolete += 1;
    this.logger.info({ event: 'redrive.obsolete', ...log }, 'redrive.obsolete');
    return true;
  }

  private async deleteCopy(dlqUrl: string, receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: receiptHandle }));
  }
}
