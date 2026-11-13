import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  type QueueAttributeName,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { errorName } from './sqs-client.ts';

export interface QueueSpec {
  readonly name: string;
  readonly visibilityTimeoutS: number;
  readonly receiveWaitTimeS: number;
  readonly messageRetentionS: number;
  readonly contentBasedDeduplication: boolean;
  readonly redrive?: { readonly deadLetterQueueName: string; readonly maxReceiveCount: number };
}

export interface QueueProvisionResult {
  readonly name: string;
  readonly url: string;
  readonly arn: string;
  readonly action: 'created' | 'updated' | 'unchanged';
  readonly changed: readonly string[];
}

export class ImmutableQueueAttributeError extends Error {
  constructor(queue: string, attribute: string, actual: string | undefined) {
    super(`fila ${queue}: atributo imutável ${attribute} diverge (atual: ${actual ?? 'ausente'})`);
    this.name = 'ImmutableQueueAttributeError';
  }
}

type Attributes = Partial<Record<QueueAttributeName, string>>;

function normalizeRedrive(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return raw;
  const target = 'deadLetterTargetArn' in parsed ? parsed.deadLetterTargetArn : undefined;
  const maxReceiveCount = 'maxReceiveCount' in parsed ? parsed.maxReceiveCount : undefined;
  const isScalar = typeof maxReceiveCount === 'number' || typeof maxReceiveCount === 'string';
  return JSON.stringify({
    deadLetterTargetArn: typeof target === 'string' ? target : undefined,
    maxReceiveCount: isScalar ? String(maxReceiveCount) : undefined,
  });
}

/**
 * Cria ou converge filas FIFO de forma idempotente (U2): nunca faz purge nem
 * delete. Atributos mutáveis convergem por SetQueueAttributes; um atributo
 * imutável divergente (FifoQueue) é erro.
 */
export class QueueProvisioner {
  constructor(private readonly sqs: SQSClient) {}

  async ensureAll(specs: readonly QueueSpec[]): Promise<QueueProvisionResult[]> {
    const results: QueueProvisionResult[] = [];
    const arns = new Map<string, string>();
    for (const spec of specs) {
      const result = await this.ensure(spec, arns);
      arns.set(result.name, result.arn);
      results.push(result);
    }
    return results;
  }

  private desiredMutable(spec: QueueSpec, arns: ReadonlyMap<string, string>): Attributes {
    const attributes: Attributes = {
      VisibilityTimeout: String(spec.visibilityTimeoutS),
      ReceiveMessageWaitTimeSeconds: String(spec.receiveWaitTimeS),
      MessageRetentionPeriod: String(spec.messageRetentionS),
      ContentBasedDeduplication: spec.contentBasedDeduplication ? 'true' : 'false',
    };
    if (spec.redrive !== undefined) {
      const dlqArn = arns.get(spec.redrive.deadLetterQueueName);
      if (dlqArn === undefined) {
        throw new Error(`DLQ ${spec.redrive.deadLetterQueueName} precisa ser provisionada antes de ${spec.name}`);
      }
      attributes.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(spec.redrive.maxReceiveCount),
      });
    }
    return attributes;
  }

  private async ensure(spec: QueueSpec, arns: ReadonlyMap<string, string>): Promise<QueueProvisionResult> {
    if (!spec.name.endsWith('.fifo')) throw new Error(`fila ${spec.name} deveria ser FIFO (.fifo)`);
    const desired = this.desiredMutable(spec, arns);
    const existingUrl = await this.findUrl(spec.name);

    if (existingUrl === undefined) {
      const created = await this.sqs.send(
        new CreateQueueCommand({ QueueName: spec.name, Attributes: { FifoQueue: 'true', ...desired } }),
      );
      const url = created.QueueUrl;
      if (url === undefined) throw new Error(`CreateQueue não devolveu QueueUrl para ${spec.name}`);
      return { name: spec.name, url, arn: await this.arnOf(url), action: 'created', changed: Object.keys(desired) };
    }

    const current = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: existingUrl, AttributeNames: ['All'] }),
    );
    const attributes: Attributes = current.Attributes ?? {};
    if (attributes.FifoQueue !== 'true')
      throw new ImmutableQueueAttributeError(spec.name, 'FifoQueue', attributes.FifoQueue);

    const diff: Attributes = {};
    // Exceção justificada (Princípio XIII): Object.entries perde o tipo das chaves; `desired` é montado
    // neste arquivo só com chaves QueueAttributeName, então a afirmação não esconde dado externo.
    for (const [key, value] of Object.entries(desired) as [QueueAttributeName, string][]) {
      const actual = key === 'RedrivePolicy' ? normalizeRedrive(attributes[key]) : attributes[key];
      const wanted = key === 'RedrivePolicy' ? normalizeRedrive(value) : value;
      if (actual !== wanted) diff[key] = value;
    }
    const changed = Object.keys(diff);
    if (changed.length > 0) {
      await this.sqs.send(new SetQueueAttributesCommand({ QueueUrl: existingUrl, Attributes: diff }));
    }
    return {
      name: spec.name,
      url: existingUrl,
      arn: attributes.QueueArn ?? (await this.arnOf(existingUrl)),
      action: changed.length > 0 ? 'updated' : 'unchanged',
      changed,
    };
  }

  private async findUrl(name: string): Promise<string | undefined> {
    try {
      const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
      return result.QueueUrl;
    } catch (error) {
      const n = errorName(error);
      if (n === 'QueueDoesNotExist' || n === 'AWS.SimpleQueueService.NonExistentQueue') return undefined;
      throw error;
    }
  }

  private async arnOf(url: string): Promise<string> {
    const result = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }));
    const arn = result.Attributes?.QueueArn;
    if (arn === undefined) throw new Error(`fila sem QueueArn: ${url}`);
    return arn;
  }
}

const FOURTEEN_DAYS_S = 14 * 24 * 60 * 60;

export interface QueueTopologyOptions {
  readonly inboundQueue: string;
  readonly dlq: string;
  readonly eventsQueue: string;
  readonly visibilityTimeoutS: number;
  readonly waitTimeS: number;
  readonly maxReceiveCount: number;
}

/** Topologia do §10/D34, na ordem de criação (a DLQ vem antes da origem). */
export function queueTopology(options: QueueTopologyOptions): QueueSpec[] {
  return [
    {
      name: options.dlq,
      visibilityTimeoutS: options.visibilityTimeoutS,
      receiveWaitTimeS: 0,
      messageRetentionS: FOURTEEN_DAYS_S,
      contentBasedDeduplication: false,
    },
    {
      name: options.inboundQueue,
      visibilityTimeoutS: options.visibilityTimeoutS,
      receiveWaitTimeS: options.waitTimeS,
      messageRetentionS: FOURTEEN_DAYS_S,
      contentBasedDeduplication: false,
      redrive: { deadLetterQueueName: options.dlq, maxReceiveCount: options.maxReceiveCount },
    },
    {
      name: options.eventsQueue,
      visibilityTimeoutS: options.visibilityTimeoutS,
      receiveWaitTimeS: options.waitTimeS,
      messageRetentionS: FOURTEEN_DAYS_S,
      contentBasedDeduplication: false,
    },
  ];
}
