/**
 * Processo filho do CONF-18: fica em long poll contínuo numa fila até receber
 * SIGKILL. Escreve "polling" antes de cada chamada para o teste saber quando matar.
 */
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../../src/platform/sqs/sqs-client.ts';

const queueUrl = process.env['QUEUE_URL'];
const endpoint = process.env['SQS_ENDPOINT'];
if (queueUrl === undefined || endpoint === undefined) process.exit(2);

const client = createSqsClient({
  endpoint,
  region: process.env['AWS_REGION'] ?? 'us-east-1',
  requestTimeoutMs: 30_000,
});
for (;;) {
  process.stdout.write('polling\n');
  await client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 1, MaxNumberOfMessages: 1 }));
}
