import { QueueProvisioner, queueTopology } from '../platform/sqs/queue-provisioner.ts';
import { createSqsClient, waitForSqs } from '../platform/sqs/sqs-client.ts';

function log(level: 'info' | 'fatal', event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ level, time: new Date().toISOString(), event, ...data })}\n`);
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`variável obrigatória ausente: ${name}`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) throw new Error(`variável inválida: ${name}=${raw}`);
  return value;
}

/** Job one-shot e idempotente: cria ou converge DLQ, fila de entrada e fila de eventos. */
export async function initQueuesMain(): Promise<void> {
  const client = createSqsClient({
    endpoint: env('SQS_ENDPOINT'),
    region: env('AWS_REGION', 'us-east-1'),
    requestTimeoutMs: 5000,
  });
  try {
    await waitForSqs(client, 60_000);
    const specs = queueTopology({
      inboundQueue: env('SQS_INBOUND_QUEUE', 'wager-transactions.fifo'),
      dlq: env('SQS_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueue: env('SQS_EVENTS_QUEUE', 'wagering-events.fifo'),
      visibilityTimeoutS: intEnv('SQS_VISIBILITY_TIMEOUT_S', 30),
      waitTimeS: intEnv('SQS_WAIT_TIME_S', 10),
      maxReceiveCount: intEnv('SQS_MAX_RECEIVE_COUNT', 8),
    });
    const results = await new QueueProvisioner(client).ensureAll(specs);
    for (const result of results) {
      log('info', 'init_queues.queue', { name: result.name, action: result.action, changed: result.changed });
    }
    log('info', 'init_queues.done', { queues: results.length });
  } finally {
    client.destroy();
  }
}

if (import.meta.main) {
  initQueuesMain().then(
    () => process.exit(0),
    (error: unknown) => {
      log('fatal', 'init_queues.failed', {
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      process.exit(1);
    },
  );
}
