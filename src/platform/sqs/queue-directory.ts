import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { errorName } from './sqs-client.ts';

const MISSING_QUEUE_ERRORS = new Set(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']);

export function isQueueMissing(error: unknown): boolean {
  return MISSING_QUEUE_ERRORS.has(errorName(error));
}

/**
 * URLs das filas por nome, com cache. Uma fila que some (QueueDoesNotExist, ex.: emulador
 * reiniciado sem estado) invalida o cache e, quando habilitado, dispara o reprovisionamento
 * idempotente da topologia (D35, seção 14 do plano). Nunca faz purge nem delete.
 */
export class QueueDirectory {
  private readonly urls = new Map<string, string>();
  private provisioning: Promise<void> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly provision: (() => Promise<void>) | undefined,
  ) {}

  async urlOf(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached !== undefined) return cached;
    const result = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    const url = result.QueueUrl;
    if (url === undefined) throw new Error(`GetQueueUrl sem URL: ${name}`);
    this.urls.set(name, url);
    return url;
  }

  /** Trata uma fila ausente; verdadeiro quando o erro era de fila ausente (o chamador tenta de novo). */
  async recover(error: unknown): Promise<boolean> {
    if (!isQueueMissing(error)) return false;
    this.urls.clear();
    if (this.provision !== undefined) {
      this.provisioning ??= this.provision().finally(() => {
        this.provisioning = undefined;
      });
      await this.provisioning;
    }
    return true;
  }
}
