import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type QueueAttributeName,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/platform/sqs/sqs-client.ts';
import { assertTestQueueName, requiredEnv, testQueueName } from './run-context.ts';

export function testSqsClient(requestTimeoutMs = 30_000): SQSClient {
  return createSqsClient({
    endpoint: requiredEnv('SQS_ENDPOINT'),
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    requestTimeoutMs,
    maxAttempts: 1,
  });
}

export interface TestQueue {
  readonly name: string;
  readonly url: string;
  readonly arn: string;
}

export async function createTestFifoQueue(
  client: SQSClient,
  suffix: string,
  attributes: Partial<Record<QueueAttributeName, string>> = {},
): Promise<TestQueue> {
  const name = testQueueName(suffix);
  const created = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', VisibilityTimeout: '3', ...attributes },
    }),
  );
  const url = created.QueueUrl;
  if (url === undefined) throw new Error(`CreateQueue sem URL: ${name}`);
  const queueAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
  );
  const arn = queueAttributes.Attributes?.QueueArn;
  if (arn === undefined) throw new Error(`fila sem ARN: ${name}`);
  return { name, url, arn };
}

export async function deleteTestQueue(client: SQSClient, queue: { name: string; url: string }): Promise<void> {
  assertTestQueueName(queue.name);
  try {
    await client.send(new DeleteQueueCommand({ QueueUrl: queue.url }));
  } catch {
    // já removida
  }
}

export interface QueueCounts {
  readonly visible: number;
  readonly notVisible: number;
  readonly delayed: number;
}

export async function queueCounts(client: SQSClient, url: string): Promise<QueueCounts> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }),
  );
  const a = result.Attributes ?? {};
  return {
    visible: Number.parseInt(a.ApproximateNumberOfMessages ?? '0', 10),
    notVisible: Number.parseInt(a.ApproximateNumberOfMessagesNotVisible ?? '0', 10),
    delayed: Number.parseInt(a.ApproximateNumberOfMessagesDelayed ?? '0', 10),
  };
}
