import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  type MessageAttributeValue,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ownerUrl } from './db.ts';
import { eventually } from './eventually.ts';
import type { Fixture } from './fixture.ts';
import { LogBook } from './logbook.ts';
import { queueCounts } from './sqs.ts';
import { withClient } from './sql-fixtures.ts';
import { keyOf, type SubmissionBody } from './wagering.ts';

/**
 * Apoio dos testes de mensageria (F5): envelope WagerTransactionRequested (§10), envio à fila de
 * teste, leitura da inbox e do registro de dead-letter, contagem de cópias e execução do
 * `sqs:redrive` como processo separado.
 */
export const CONSUMER_NAME = 'wager-transactions';

/** Ambiente de uma instância que consome a fila (e atende HTTP, para abrir wallets). */
export function consumerEnv(fixture: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return fixture.env({ APP_ROLES: 'api,consumer', ...extra });
}

export interface WagerMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Envelope do §10 a partir de um corpo de submissão; a key padrão é a recomendada pelo §9. */
export function wagerMessage(
  body: SubmissionBody,
  options: { messageId?: string; idempotencyKey?: string } = {},
): WagerMessage {
  return {
    messageId: options.messageId ?? `m-${Bun.randomUUIDv7()}`,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-11-12T12:00:00.000Z',
    data: { ...body, idempotencyKey: options.idempotencyKey ?? keyOf(body) },
  };
}

export interface SendOptions {
  readonly groupId?: string;
  readonly dedupId?: string;
  readonly attributes?: Record<string, MessageAttributeValue>;
  readonly queueUrl?: string;
}

/** Envia à fila de entrada (ou outra). DedupId novo por padrão: duplicatas reais, sem ajuda do FIFO. */
export async function sendMessage(fixture: Fixture, message: WagerMessage | string, options: SendOptions = {}) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  const walletId = typeof message === 'string' ? undefined : message.data['walletId'];
  const result = await fixture.sqs.send(
    new SendMessageCommand({
      QueueUrl: options.queueUrl ?? fixture.inbound.url,
      MessageBody: body,
      MessageGroupId: options.groupId ?? (typeof walletId === 'string' ? walletId : 'tests'),
      MessageDeduplicationId: options.dedupId ?? `t-${Bun.randomUUIDv7()}`,
      ...(options.attributes === undefined ? {} : { MessageAttributes: options.attributes }),
    }),
  );
  return result.MessageId ?? '';
}

export interface InboxRow {
  readonly messageId: string;
  readonly outcome: string;
  readonly transactionId: string | null;
}

export async function inboxRows(database: string, messageId?: string): Promise<InboxRow[]> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<InboxRow>(
      `SELECT message_id AS "messageId", outcome, transaction_id::text AS "transactionId" FROM inbox_messages
        WHERE $1::text IS NULL OR message_id = $1 ORDER BY processed_at`,
      [messageId ?? null],
    );
    return result.rows;
  });
}

export interface DeadLetterRowView {
  readonly dlKey: string;
  readonly state: string;
  readonly attempt: number;
  readonly redriveCount: number;
  readonly reason: string;
}

export async function deadLetterRows(database: string, dlKey?: string): Promise<DeadLetterRowView[]> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<DeadLetterRowView>(
      `SELECT dl_key AS "dlKey", state, attempt, redrive_count AS "redriveCount", reason FROM dead_letter_messages
        WHERE $1::text IS NULL OR dl_key = $1 ORDER BY first_seen_at, attempt`,
      [dlKey ?? null],
    );
    return result.rows;
  });
}

/** Espera o registro de dead-letter chegar ao estado (e tentativa) esperado. */
export async function waitDeadLetter(
  database: string,
  dlKey: string,
  expected: { state: string; attempt?: number },
  timeoutMs = 20_000,
): Promise<DeadLetterRowView> {
  const attemptLabel = expected.attempt === undefined ? '' : ` (tentativa ${expected.attempt})`;
  return eventually(
    async () => {
      const row = (await deadLetterRows(database, dlKey))[0];
      if (row === undefined || row.state !== expected.state) return undefined;
      return expected.attempt === undefined || row.attempt === expected.attempt ? row : undefined;
    },
    {
      timeoutMs,
      describe: `dead-letter ${dlKey} em ${expected.state}${attemptLabel}`,
      diagnose: () => deadLetterRows(database, dlKey),
    },
  );
}

/** Transações gravadas para um (provider, externalTransactionId) e seus efeitos no ledger. */
export async function effectsOfExternal(
  database: string,
  externalTransactionId: string,
  providerId = 'provider-a',
): Promise<{ transactions: number; entries: number; statuses: string[] }> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ status: string; entries: string }>(
      `SELECT t.status, (SELECT count(*) FROM wallet_ledger_entries e WHERE e.transaction_id = t.id)::text AS entries
         FROM wager_transactions t WHERE t.provider_id = $1 AND t.external_transaction_id = $2`,
      [providerId, externalTransactionId],
    );
    return {
      transactions: result.rows.length,
      entries: result.rows.reduce((total, row) => total + Number.parseInt(row.entries, 10), 0),
      statuses: result.rows.map((row) => row.status),
    };
  });
}

/** Número de linhas de negócio (transações fora a OPENING) de uma wallet. */
export async function businessRows(database: string, walletId: string): Promise<number> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM wager_transactions WHERE wallet_id = $1::uuid AND kind <> 'OPENING'`,
      [walletId],
    );
    return Number.parseInt(result.rows[0]?.n ?? '0', 10);
  });
}

/** Cópias numa fila (visíveis + em voo), lidas do emulador. */
export async function copiesIn(sqs: SQSClient, url: string): Promise<number> {
  const counts = await queueCounts(sqs, url);
  return counts.visible + counts.notVisible + counts.delayed;
}

export async function waitCopies(sqs: SQSClient, url: string, expected: number, timeoutMs = 20_000): Promise<void> {
  await eventually(async () => ((await copiesIn(sqs, url)) === expected ? true : undefined), {
    timeoutMs,
    describe: `${expected} cópia(s) em ${url.split('/').pop() ?? url}`,
    diagnose: () => queueCounts(sqs, url),
  });
}

/**
 * Lê as mensagens de uma fila sem consumi-las: recebe com visibilidade curta e devolve a
 * visibilidade (0) logo depois. Inclui atributos de sistema (MessageDeduplicationId).
 */
export async function peekMessages(
  sqs: SQSClient,
  url: string,
  expected: number,
  timeoutMs = 10_000,
): Promise<Message[]> {
  const seen = new Map<string, Message>();
  const deadline = Date.now() + timeoutMs;
  while (seen.size < expected && Date.now() < deadline) {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        VisibilityTimeout: 5,
        MessageSystemAttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );
    for (const message of response.Messages ?? []) {
      if (message.MessageId !== undefined) seen.set(message.MessageId, message);
    }
  }
  for (const message of seen.values()) {
    if (message.ReceiptHandle === undefined) continue;
    await sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: url,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        }),
      )
      .catch(() => undefined);
  }
  return [...seen.values()];
}

/** Recebe e apaga até `expected` mensagens (ou até o prazo); devolve os corpos. */
export async function consumeMessages(
  sqs: SQSClient,
  url: string,
  expected: number,
  timeoutMs = 20_000,
): Promise<string[]> {
  const bodies: string[] = [];
  const deadline = Date.now() + timeoutMs;
  while (bodies.length < expected && Date.now() < deadline) {
    const response = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
    );
    for (const message of response.Messages ?? []) {
      bodies.push(message.Body ?? '');
      if (message.ReceiptHandle !== undefined) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
      }
    }
  }
  return bodies;
}

export interface CliRun {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly logs: LogBook;
  readonly stderr: string;
}

/** Roda `sqs:redrive` como processo separado, com o ambiente da fixture (e FAULT_PLAN, se houver). */
export async function runRedrive(
  fixture: Fixture,
  extra: Record<string, string> = {},
  idleRounds = 2,
): Promise<CliRun> {
  const proc = Bun.spawn(['bun', 'src/cli/sqs-redrive.ts', '--idle-rounds', String(idleRounds)], {
    cwd: process.cwd(),
    env: { ...process.env, ...fixture.env({ INSTANCE_ID: 'redrive', ...extra }) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const logs = new LogBook();
  for (const line of stdout.split('\n')) logs.push(line);
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    logs,
    stderr,
  };
}

/** Roda uma CLI da app (`src/cli/<script>.ts`) com o ambiente da fixture. */
export async function runCli(
  fixture: Fixture,
  script: string,
  args: readonly string[] = [],
  extra: Record<string, string> = {},
): Promise<CliRun> {
  const proc = Bun.spawn(['bun', `src/cli/${script}.ts`, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...fixture.env({ INSTANCE_ID: script, ...extra }) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  const logs = new LogBook();
  for (const line of stdout.split('\n')) logs.push(line);
  return {
    exitCode: proc.exitCode,
    signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    logs,
    stderr,
  };
}

/** FAULT_PLAN de um ponto para um messageId (D47). */
export function faultPlan(
  point: string,
  action: 'kill' | 'pause' | 'fail',
  match: Record<string, string> = {},
): Record<string, string> {
  return {
    FAULT_INJECTION: 'enabled',
    FAULT_PLAN: JSON.stringify([{ point, action, ...(Object.keys(match).length === 0 ? {} : { match }) }]),
  };
}

/** Evento do envelope publicado na fila de eventos (só o eventId importa aos oráculos). */
export function eventIdOf(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null || !('eventId' in parsed) || typeof parsed.eventId !== 'string') {
    throw new Error(`corpo sem eventId: ${body.slice(0, 80)}`);
  }
  return parsed.eventId;
}
