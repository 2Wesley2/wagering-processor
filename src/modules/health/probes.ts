import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import pg from 'pg';

export type ProbeStatus = 'up' | 'down';

/** Porta do health check: o controller depende só disto (PgProbe e SqsProbe implementam). */
export interface HealthProbe {
  check(): Promise<ProbeStatus>;
}

/**
 * Checagem do PostgreSQL com conexão dedicada (pool de 1) e timeouts no cliente:
 * um banco congelado não prende o health check (D43, D25).
 */
export class PgProbe implements HealthProbe {
  private readonly pool: pg.Pool;
  private closed = false;

  constructor(databaseUrl: string, timeoutMs: number, instanceId: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
      idleTimeoutMillis: 10_000,
      application_name: `health:${instanceId}`,
    });
    // Erros de conexões ociosas não podem derrubar o processo.
    this.pool.on('error', () => undefined);
  }

  async check(): Promise<ProbeStatus> {
    if (this.closed) return 'down';
    try {
      await this.pool.query('SELECT 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

/** Checagem do SQS: a fila de entrada precisa existir e responder dentro do prazo. */
export class SqsProbe implements HealthProbe {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
    private readonly timeoutMs: number,
  ) {}

  async check(): Promise<ProbeStatus> {
    try {
      const abortSignal = AbortSignal.timeout(this.timeoutMs);
      if (this.queueUrl === undefined) {
        const found = await this.client.send(new GetQueueUrlCommand({ QueueName: this.queueName }), { abortSignal });
        this.queueUrl = found.QueueUrl;
      }
      await this.client.send(new GetQueueAttributesCommand({ QueueUrl: this.queueUrl, AttributeNames: ['QueueArn'] }), {
        abortSignal,
      });
      return 'up';
    } catch {
      this.queueUrl = undefined;
      return 'down';
    }
  }
}
