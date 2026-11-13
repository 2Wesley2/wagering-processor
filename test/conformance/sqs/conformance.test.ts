import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { QueueProvisioner } from '../../../src/platform/sqs/queue-provisioner.ts';
import { errorName } from '../../../src/platform/sqs/sqs-client.ts';
import { eventually } from '../../support/eventually.ts';
import { writeEvidence } from '../../support/evidence.ts';
import { field } from '../../support/http.ts';
import { RESULTS_DIR, requiredEnv, testQueueName } from '../../support/run-context.ts';
import { createTestFifoQueue, deleteTestQueue, queueCounts, testSqsClient, type TestQueue } from '../../support/sqs.ts';
import { CONF_CASES } from './profile.ts';

let sqs: SQSClient;
const created: TestQueue[] = [];
const failedPrereqs: string[] = [];
let seq = 0;

async function createQueue(suffix: string, attributes: Record<string, string> = {}): Promise<TestQueue> {
  const queue = await createTestFifoQueue(sqs, `conf${String(seq++).padStart(2, '0')}-${suffix}`, attributes);
  created.push(queue);
  return queue;
}

async function send(queue: TestQueue, body: string, group = 'g1', dedup: string = crypto.randomUUID()): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queue.url,
      MessageBody: body,
      MessageGroupId: group,
      MessageDeduplicationId: dedup,
    }),
  );
}

async function receive(
  queue: TestQueue,
  options: { max?: number; wait?: number; vt?: number } = {},
): Promise<Message[]> {
  const out = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queue.url,
      MaxNumberOfMessages: options.max ?? 1,
      WaitTimeSeconds: options.wait ?? 0,
      ...(options.vt === undefined ? {} : { VisibilityTimeout: options.vt }),
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      MessageAttributeNames: ['All'],
    }),
  );
  return out.Messages ?? [];
}

function receipt(message: Message | undefined): string {
  if (message?.ReceiptHandle === undefined) throw new Error('mensagem sem ReceiptHandle');
  return message.ReceiptHandle;
}

function expectedOf(id: string): string {
  const expected = CONF_CASES.find((conformanceCase) => conformanceCase.id === id)?.expected;
  if (expected === undefined) throw new Error(`caso sem comportamento esperado no perfil: ${id}`);
  return expected;
}

/** Registra falha de pré-requisito para marcar os dependentes como BLOCKED. */
function conf(id: string, body: () => Promise<void>, timeoutMs = 30_000): void {
  const meta = CONF_CASES.find((conformanceCase) => conformanceCase.id === id);
  if (meta === undefined) throw new Error(`caso sem perfil: ${id}`);
  // eslint-disable-next-line sonarjs/assertions-in-tests -- as asserções de cada CONF-xx ficam no `body` recebido por conf()
  test(
    `[${id}] [${meta.category}] ${meta.title}`,
    async () => {
      try {
        await body();
      } catch (error) {
        if (meta.category === 'P') failedPrereqs.push(id);
        throw error;
      }
    },
    timeoutMs,
  );
}

beforeAll(() => {
  sqs = testSqsClient();
});

afterAll(async () => {
  for (const queue of created) await deleteTestQueue(sqs, queue);
  const blocked = new Set<string>();
  for (const id of failedPrereqs)
    for (const dependent of CONF_CASES.find((conformanceCase) => conformanceCase.id === id)?.dependents ?? [])
      blocked.add(dependent);
  if (blocked.size > 0) {
    mkdirSync(`${RESULTS_DIR}/blocked`, { recursive: true });
    for (const dependent of blocked) {
      writeFileSync(
        `${RESULTS_DIR}/blocked/${dependent === '*' ? 'ALL' : dependent}.json`,
        JSON.stringify({ by: failedPrereqs }),
      );
    }
  }
  sqs.destroy();
});

describe('conformidade do MiniStack (SQS)', () => {
  conf('CONF-00', async () => {
    const base = requiredEnv('MINISTACK_BASE_URL');
    const response = await fetch(`${base}/_ministack/health`);
    expect(response.status).toBe(200);
    const body = await response.text();
    const expectedVersion = requiredEnv('EXPECTED_MINISTACK_VERSION');
    writeEvidence('CONF-00', { status: response.status, body: body.slice(0, 2000), expectedVersion });
    // A versão só é afirmada se o health a expuser; caso contrário o digest fixado no compose é a garantia.
    const match = /"version"\s*:\s*"([^"]+)"/.exec(body);
    if (match !== null) expect(match[1]).toBe(expectedVersion);
  });

  conf('CONF-01', async () => {
    const out = await sqs.send(new ListQueuesCommand({}));
    expect(out.$metadata.httpStatusCode).toBe(200);
  });

  conf('CONF-02', async () => {
    let name = 'none';
    try {
      await sqs.send(new GetQueueUrlCommand({ QueueName: testQueueName('conf-missing') }));
    } catch (error) {
      name = errorName(error);
    }
    writeEvidence('CONF-02', { errorName: name });
    expect(['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue']).toContain(name);
  });

  conf('CONF-03', async () => {
    const dlq = await createQueue('dlq');
    const sourceQueue = await createQueue('src', {
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 3 }),
    });
    const attributes = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: sourceQueue.url, AttributeNames: ['All'] }),
    );
    expect(attributes.Attributes?.FifoQueue).toBe('true');
    const redrive: unknown = JSON.parse(attributes.Attributes?.RedrivePolicy ?? '{}');
    expect(field(redrive, 'deadLetterTargetArn')).toBe(dlq.arn);
    expect(Number(field(redrive, 'maxReceiveCount'))).toBe(3);
  });

  conf('CONF-04', async () => {
    const provisioner = new QueueProvisioner(sqs);
    const dlqName = testQueueName('conf-prov-dlq');
    const srcName = testQueueName('conf-prov-src');
    const specs = (vt: number) => [
      {
        name: dlqName,
        visibilityTimeoutS: vt,
        receiveWaitTimeS: 0,
        messageRetentionS: 1_209_600,
        contentBasedDeduplication: false,
      },
      {
        name: srcName,
        visibilityTimeoutS: vt,
        receiveWaitTimeS: 1,
        messageRetentionS: 1_209_600,
        contentBasedDeduplication: false,
        redrive: { deadLetterQueueName: dlqName, maxReceiveCount: 5 },
      },
    ];
    const first = await provisioner.ensureAll(specs(3));
    for (const result of first) created.push({ name: result.name, url: result.url, arn: result.arn });
    const second = await provisioner.ensureAll(specs(3));
    const third = await provisioner.ensureAll(specs(4));
    writeEvidence('CONF-04', { first, second, third });
    expect(first.map((result) => result.action)).toEqual(['created', 'created']);
    expect(second.map((result) => result.action)).toEqual(['unchanged', 'unchanged']);
    expect(third.map((result) => result.action)).toEqual(['updated', 'updated']);
  });

  conf('CONF-05', async () => {
    const queue = await createQueue('order');
    for (let i = 0; i < 5; i++) await send(queue, `m${i}`);
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [message] = await receive(queue);
      bodies.push(message?.Body ?? '<vazio>');
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: receipt(message) }));
    }
    expect(bodies).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });

  conf('CONF-06', async () => {
    const queue = await createQueue('group', { VisibilityTimeout: '10' });
    await send(queue, 'a1', 'A');
    await send(queue, 'a2', 'A');
    await send(queue, 'b1', 'B');
    const [first] = await receive(queue);
    expect(first?.Body).toBe('a1');
    const next = await receive(queue, { max: 10 });
    // Com a1 em voo, nenhuma outra mensagem do grupo A pode ser entregue.
    expect(next.map((message) => message.Body)).toEqual(['b1']);
  });

  conf('CONF-07', async () => {
    const queue = await createQueue('dedup');
    await send(queue, 'x', 'g', 'same-dedup-id');
    await send(queue, 'x-again', 'g', 'same-dedup-id');
    const got = await receive(queue, { max: 10 });
    expect(got.map((message) => message.Body)).toEqual(['x']);
  });

  conf('CONF-08', async () => {
    const queue = await createQueue('concurrent');
    await Promise.all(Array.from({ length: 50 }, (_, i) => send(queue, `p${i}`, `g${i % 5}`)));
    const seen = new Set<string>();
    await eventually(
      async () => {
        for (const message of await receive(queue, { max: 10 })) {
          seen.add(message.Body ?? '');
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: receipt(message) }));
        }
        return seen.size === 50 ? true : undefined;
      },
      { timeoutMs: 20_000, describe: '50 mensagens distintas recebidas', diagnose: () => ({ seen: seen.size }) },
    );
    expect(seen.size).toBe(50);
  });

  conf('CONF-09', async () => {
    const queue = await createQueue('vt', { VisibilityTimeout: '1' });
    await send(queue, 'r');
    const [first] = await receive(queue);
    expect(first?.Body).toBe('r');
    const again = await eventually(
      async () => {
        const [message] = await receive(queue);
        return message;
      },
      { timeoutMs: 6000, intervalMs: 250, describe: 'reentrega após VT' },
    );
    const count = Number(again.Attributes?.ApproximateReceiveCount ?? '0');
    writeEvidence('CONF-09', { approximateReceiveCount: count });
    expect(count).toBeGreaterThanOrEqual(2);
  });

  conf('CONF-10', async () => {
    const queue = await createQueue('cmv', { VisibilityTimeout: '1' });
    await send(queue, 'c');
    const [message] = await receive(queue);
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue.url,
        ReceiptHandle: receipt(message),
        VisibilityTimeout: 4,
      }),
    );
    const start = Date.now();
    await Bun.sleep(2000); // > VT original (1 s) e < VT estendido (4 s)
    expect(await receive(queue)).toEqual([]);
    const back = await eventually(async () => (await receive(queue))[0], {
      timeoutMs: 6000,
      intervalMs: 250,
      describe: 'volta após 4 s',
    });
    writeEvidence('CONF-10', { returnedAfterMs: Date.now() - start });
    expect(back.Body).toBe('c');
  });

  conf('CONF-11', async () => {
    const queue = await createQueue('cmv0', { VisibilityTimeout: '30' });
    await send(queue, 'z');
    const [message] = await receive(queue);
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue.url,
        ReceiptHandle: receipt(message),
        VisibilityTimeout: 0,
      }),
    );
    const back = await eventually(async () => (await receive(queue))[0], {
      timeoutMs: 2000,
      intervalMs: 100,
      describe: 'CMV(0) devolve na hora',
    });
    expect(back.Body).toBe('z');
  });

  conf('CONF-12', async () => {
    const queue = await createQueue('oldhandle', { VisibilityTimeout: '1' });
    await send(queue, 'h');
    const [first] = await receive(queue);
    const second = await eventually(async () => (await receive(queue))[0], {
      timeoutMs: 6000,
      intervalMs: 250,
      describe: 'reentrega',
    });
    let observed = 'deleted';
    let deleteError: string | undefined;
    try {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queue.url, ReceiptHandle: receipt(first) }));
    } catch (error) {
      observed = 'error';
      deleteError = errorName(error);
    }
    const counts = await queueCounts(sqs, queue.url);
    writeEvidence('CONF-12', {
      observed,
      deleteError,
      countsAfter: counts,
      secondReceiveCount: second.Attributes?.ApproximateReceiveCount,
    });
    expect(observed).toBe(expectedOf('CONF-12'));
  });

  conf('CONF-13', async () => {
    const dlq = await createQueue('rp-dlq');
    const sourceQueue = await createQueue('rp-src', {
      VisibilityTimeout: '1',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 2 }),
    });
    await send(sourceQueue, 'poison');
    const moved = await eventually(
      async () => {
        await receive(sourceQueue); // receives sem delete; a DLQ do MiniStack é preguiçosa (move no receive)
        const [message] = await receive(dlq);
        return message;
      },
      { timeoutMs: 15_000, intervalMs: 300, describe: 'mensagem movida para a DLQ' },
    );
    expect(moved.Body).toBe('poison');
  });

  conf('CONF-14', async () => {
    const queue = await createQueue('longpoll');
    const start = Date.now();
    expect(await receive(queue, { wait: 1 })).toEqual([]);
    const elapsed = Date.now() - start;
    writeEvidence('CONF-14', { elapsedMs: elapsed });
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(3000);
  });

  conf('CONF-15', async () => {
    const queue = await createQueue('pollers', { VisibilityTimeout: '30' });
    const polls = Array.from({ length: 12 }, () => receive(queue, { wait: 2 }));
    await Bun.sleep(300);
    await send(queue, 'one');
    const results = (await Promise.all(polls)).flat();
    expect(results.map((message) => message.Body)).toEqual(['one']);
  });

  conf('CONF-16', async () => {
    const queue = await createQueue('counts', { VisibilityTimeout: '30' });
    await send(queue, 'c1', 'A');
    await send(queue, 'c2', 'B');
    await receive(queue);
    const counts = await queueCounts(sqs, queue.url);
    writeEvidence('CONF-16', { afterSend2Receive1: counts });
    expect(counts.visible + counts.notVisible).toBe(2);
  });

  conf('CONF-17', async () => {
    const queue = await createQueue('attrs');
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.url,
        MessageBody: '{"x":1}',
        MessageGroupId: 'g',
        MessageDeduplicationId: crypto.randomUUID(),
        MessageAttributes: {
          correlationId: { DataType: 'String', StringValue: 'corr-1' },
          dlAttempt: { DataType: 'Number', StringValue: '2' },
        },
      }),
    );
    const [message] = await receive(queue);
    expect(message?.MessageAttributes?.correlationId?.StringValue).toBe('corr-1');
    expect(message?.MessageAttributes?.dlAttempt?.StringValue).toBe('2');
    expect(message?.MD5OfBody).toBe(new Bun.CryptoHasher('md5').update('{"x":1}').digest('hex'));
  });

  conf(
    'CONF-18',
    async () => {
      const queue = await createQueue('orphan', { VisibilityTimeout: '30' });
      const child = Bun.spawn(['bun', 'test/conformance/sqs/long-poll-child.ts'], {
        env: { ...process.env, QUEUE_URL: queue.url },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('polling');
      await Bun.sleep(150);
      child.kill('SIGKILL');
      await child.exited;
      expect(child.signalCode).toBe('SIGKILL');
      // O long poll órfão dura no máximo Wait (1 s). Depois disso nada pode capturar a mensagem.
      await Bun.sleep(1500);
      await send(queue, 'after-orphan');
      const got = await receive(queue, { wait: 1 });
      writeEvidence('CONF-18', { received: got.map((message) => message.Body) });
      expect(got.map((message) => message.Body)).toEqual(['after-orphan']);
    },
    30_000,
  );

  conf('CONF-19', async () => {
    const queue = await createQueue('range');
    let observed = 'accepted';
    try {
      await sqs.send(
        new SetQueueAttributesCommand({ QueueUrl: queue.url, Attributes: { VisibilityTimeout: '50000' } }),
      );
    } catch (error) {
      observed = `rejected:${errorName(error)}`;
    }
    writeEvidence('CONF-19', { observed });
    expect(observed).toBe(expectedOf('CONF-19'));
  });

  conf('CONF-20', async () => {
    const queue = await createQueue('purge');
    await send(queue, 'p1');
    await sqs.send(new PurgeQueueCommand({ QueueUrl: queue.url }));
    let second = 'immediate';
    try {
      await send(queue, 'p2');
      await sqs.send(new PurgeQueueCommand({ QueueUrl: queue.url }));
    } catch (error) {
      second = `rejected:${errorName(error)}`;
    }
    const left = await receive(queue, { max: 10 });
    writeEvidence('CONF-20', { secondPurge: second, left: left.length });
    expect(second).toBe(expectedOf('CONF-20'));
    expect(left).toEqual([]);
  });

  conf('CONF-21', async () => {
    const queue = await createQueue('dedup-long');
    let observed = 'accepted';
    try {
      await send(queue, 'long', 'g', 'x'.repeat(200));
    } catch (error) {
      observed = `rejected:${errorName(error)}`;
    }
    writeEvidence('CONF-21', { observed });
    expect(observed).toBe(expectedOf('CONF-21'));
  });
});
