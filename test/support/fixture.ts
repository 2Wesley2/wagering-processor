import type { SQSClient } from '@aws-sdk/client-sqs';
import { appUrl, createTestDatabase, dropTestDatabase } from './db.ts';
import { stopAllInstances } from './instances.ts';
import { createTestFifoQueue, deleteTestQueue, testSqsClient, type TestQueue } from './sqs.ts';
import { instanceEnv } from './test-env.ts';

export interface Fixture {
  readonly database: string;
  readonly databaseUrl: string;
  readonly sqs: SQSClient;
  readonly inbound: TestQueue;
  readonly dlq: TestQueue;
  readonly events: TestQueue;
  env(extra?: Record<string, string>): Record<string, string>;
  dispose(): Promise<void>;
}

/** Banco isolado + filas isoladas por arquivo de teste (D45). */
export async function createFixture(suffix: string): Promise<Fixture> {
  const sqs = testSqsClient();
  const database = await createTestDatabase(suffix);
  const dlq = await createTestFifoQueue(sqs, `${suffix}-dlq`);
  const inbound = await createTestFifoQueue(sqs, `${suffix}-in`, {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }),
  });
  const events = await createTestFifoQueue(sqs, `${suffix}-ev`);
  const databaseUrl = appUrl(database);
  return {
    database,
    databaseUrl,
    sqs,
    inbound,
    dlq,
    events,
    env: (extra = {}) =>
      instanceEnv({ databaseUrl, inboundQueue: inbound.name, dlq: dlq.name, eventsQueue: events.name, extra }),
    dispose: async () => {
      await stopAllInstances();
      for (const queue of [inbound, dlq, events]) await deleteTestQueue(sqs, queue);
      await dropTestDatabase(database);
      sqs.destroy();
    },
  };
}
