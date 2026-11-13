/**
 * Runbooks V9a/V9b (persistência do MiniStack), contra o serviço isolado
 * `ministack-persist` — nunca contra o emulador da aplicação.
 *   seed [rótulo] : cria FIFO + DLQ, 3 mensagens `<rótulo>-N` (1 deixada em voo com VT longo) e
 *                   1 dedup id (rótulo padrão `seed`).
 *   check : registra o que sobreviveu ao reinício. NÃO força aprovação: imprime o
 *           observado e sai 0 se conseguiu observar (o veredito vai para o README).
 */
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { createSqsClient, errorName } from '../src/platform/sqs/sqs-client.ts';

/**
 * Rótulo da rodada (`seed v9b` / `check v9b`): cada rodada usa filas próprias
 * (`persist-check-<rótulo>-src.fifo`), então mensagens em voo de uma rodada anterior não bloqueiam
 * os grupos FIFO da seguinte. O dedup id da 1ª mensagem também leva o rótulo.
 */
const TAG = /^[a-z0-9-]{1,20}$/.test(process.argv[3] ?? '') ? (process.argv[3] ?? 'seed') : 'seed';
const SRC = `persist-check-${TAG}-src.fifo`;
const DLQ = `persist-check-${TAG}-dlq.fifo`;
const DEDUP = `persist-dedup-${TAG}`;

const sqs = createSqsClient({
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- endpoint local de teste; o MiniStack e o nginx do Compose não usam TLS
  endpoint: process.env['SQS_ENDPOINT'] ?? 'http://ministack-persist:4566',
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  requestTimeoutMs: 5000,
});

async function urlOf(name: string): Promise<string | undefined> {
  try {
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl;
  } catch (error) {
    if (errorName(error).includes('NonExistentQueue') || errorName(error) === 'QueueDoesNotExist') return undefined;
    throw error;
  }
}

async function seed(): Promise<void> {
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: DLQ, Attributes: { FifoQueue: 'true' } }));
  const dlqArn = (
    await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn;
  const sourceQueue = await sqs.send(
    new CreateQueueCommand({
      QueueName: SRC,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '600',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: 5 }),
      },
    }),
  );
  const url = sourceQueue.QueueUrl;
  for (const [i, group] of ['A', 'B', 'C'].entries()) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: `${TAG}-${i}`,
        MessageGroupId: group,
        MessageDeduplicationId: i === 0 ? DEDUP : `${TAG}-${i}`,
      }),
    );
  }
  const inflight = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 1 }));
  console.log(
    JSON.stringify({
      event: 'persist.seeded',
      queue: SRC,
      inflight: inflight.Messages?.map((message) => message.Body) ?? [],
    }),
  );
}

async function check(): Promise<void> {
  const observed: Record<string, unknown> = { at: new Date().toISOString() };
  const url = await urlOf(SRC);
  observed['queueExists'] = url !== undefined;
  observed['dlqExists'] = (await urlOf(DLQ)) !== undefined;
  if (url !== undefined) {
    const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['All'] }));
    observed['attributes'] = {
      VisibilityTimeout: attributes.Attributes?.VisibilityTimeout,
      RedrivePolicy: attributes.Attributes?.RedrivePolicy,
      visible: attributes.Attributes?.ApproximateNumberOfMessages,
      notVisible: attributes.Attributes?.ApproximateNumberOfMessagesNotVisible,
    };
    // Reenvio com o mesmo dedup id: se o cache de dedup sobreviveu, a mensagem é descartada e a
    // contagem da fila não muda (a contagem não depende de grupos FIFO bloqueados).
    const countOf = async (): Promise<number> => {
      const counts = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }),
      );
      return (
        Number(counts.Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(counts.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
      );
    };
    const before = await countOf();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: 'dedup-probe',
        MessageGroupId: 'D',
        MessageDeduplicationId: DEDUP,
      }),
    );
    const after = await countOf();
    observed['dedupProbe'] = { before, after };
    const got = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    observed['receivedNow'] = (got.Messages ?? []).map((message) => ({
      body: message.Body,
      receiveCount: message.Attributes?.ApproximateReceiveCount,
    }));
    observed['dedupCacheSurvived'] = after === before;
  }
  console.log(JSON.stringify({ event: 'persist.observed', ...observed }, null, 2));
}

const mode = process.argv[2];
try {
  if (mode === 'seed') await seed();
  else if (mode === 'check') await check();
  else {
    console.error('uso: bun scripts/persist-check.ts seed|check');
    process.exit(2);
  }
} finally {
  sqs.destroy();
}
