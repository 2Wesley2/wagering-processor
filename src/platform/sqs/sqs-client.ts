import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';

export interface SqsClientOptions {
  readonly endpoint: string;
  readonly region: string;
  /** Deve ser maior que WaitTimeSeconds × 1000 quando o cliente fizer long poll. */
  readonly requestTimeoutMs: number;
  readonly maxAttempts?: number;
}

/**
 * Cliente SQS apontando para o emulador. Endpoint explícito e
 * useQueueUrlAsEndpoint=false: o host devolvido no QueueUrl é ignorado.
 * Credenciais e região vêm do ambiente (valores fictícios no compose).
 */
export function createSqsClient(options: SqsClientOptions): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region,
    useQueueUrlAsEndpoint: false,
    maxAttempts: options.maxAttempts ?? 3,
    requestHandler: { requestTimeout: options.requestTimeoutMs, connectionTimeout: 2000 },
  });
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}

/** Espera a API SQS responder (ListQueues) até o prazo. */
export async function waitForSqs(client: SQSClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client.send(new ListQueuesCommand({ MaxResults: 1 }), { abortSignal: AbortSignal.timeout(2000) });
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(500);
    }
  }
  throw new Error(`SQS não respondeu em ${timeoutMs} ms: ${errorName(lastError)}`);
}
