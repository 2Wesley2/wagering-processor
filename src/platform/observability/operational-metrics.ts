import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Counter, Gauge, Histogram, type Registry } from 'prom-client';
import { z } from 'zod';
import type { AutocommitSql, UnitOfWorkObserver } from '../persistence/unit-of-work.ts';
import type { QueueDirectory } from '../sqs/queue-directory.ts';

/** Conflitos de lock/serialização e retries da UnitOfWork (D42). */
export function unitOfWorkMetrics(registry: Registry): UnitOfWorkObserver {
  const conflicts = new Counter({
    name: 'db_lock_conflicts_total',
    help: 'Conflitos de concorrência no banco (serialização, deadlock, lock_timeout)',
    labelNames: ['reason'],
    registers: [registry],
  });
  const retries = new Counter({
    name: 'uow_retries_total',
    help: 'Retries da UnitOfWork inteira depois de um conflito retentável',
    labelNames: ['reason'],
    registers: [registry],
  });
  return {
    conflict(reason, retried) {
      conflicts.inc({ reason });
      if (retried) retries.inc({ reason });
    },
  };
}

interface MinimalRequest {
  readonly method?: string;
  readonly url?: string;
}

interface MinimalResponse {
  readonly statusCode: number;
  once(event: 'finish', listener: () => void): unknown;
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

/**
 * Rota com cardinalidade fechada para o label (D42): ids viram `:id` e o externalId da consulta
 * por provedor vira `:externalId`; qualquer outro caminho cai em `other`.
 */
export function routeLabel(url: string): string {
  const path = (url.split('?')[0] ?? '').replace(UUID_SEGMENT, '/:id');
  if (/^\/providers\/[^/]+\/wagering\/transactions\/[^/]+$/.test(path)) {
    return '/providers/:providerId/wagering/transactions/:externalId';
  }
  const known = [
    '/wallets',
    '/wallets/:id',
    '/wallets/:id/ledger',
    '/wallets/:id/reconciliation',
    '/wagering/transactions',
    '/wagering/transactions/:id',
    '/health/live',
    '/health/ready',
    '/metrics',
  ];
  return known.includes(path) ? path : 'other';
}

/** Duração das requisições HTTP por método, rota e status (D42). */
export function httpMetricsMiddleware(registry: Registry) {
  const duration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duração das requisições HTTP',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  return (request: MinimalRequest, response: MinimalResponse, next: () => void): void => {
    const startedAt = performance.now();
    response.once('finish', () => {
      duration.observe(
        {
          method: request.method ?? 'UNKNOWN',
          route: routeLabel(request.url ?? ''),
          status: String(response.statusCode),
        },
        (performance.now() - startedAt) / 1000,
      );
    });
    next();
  };
}

const backlogSchema = z.object({
  outboxPending: z.coerce.number(),
  outboxOldestAgeSeconds: z.coerce.number(),
  pendingReferences: z.coerce.number(),
});

export interface OperationalGaugeSources {
  readonly sql: AutocommitSql;
  readonly sqs: SQSClient;
  readonly queues: QueueDirectory;
  readonly queueNames: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Gauges globais calculados no scrape (D42): backlog da outbox, idade do evento mais antigo à
 * espera, pendências de referência e profundidade das filas. São valores do sistema inteiro
 * (todas as instâncias leem o mesmo banco e as mesmas filas); agregue com `max`. Uma fonte fora do
 * ar não derruba o /metrics: o gauge daquela fonte fica sem valor naquele scrape.
 */
export function registerOperationalGauges(registry: Registry, sources: OperationalGaugeSources): void {
  // O prom-client lê as métricas em paralelo: cada gauge deste grupo aguarda a MESMA coleta
  // (uma por scrape) antes de ser lido.
  const outboxPending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Eventos da outbox ainda não publicados',
    registers: [registry],
    collect: () => collectAll(),
  });
  const outboxOldest = new Gauge({
    name: 'outbox_oldest_pending_age_seconds',
    help: 'Idade do evento mais antigo à espera de publicação',
    registers: [registry],
    collect: () => collectAll(),
  });
  const pendingBacklog = new Gauge({
    name: 'pending_reference_backlog',
    help: 'Transações em PENDING_REFERENCE',
    registers: [registry],
    collect: () => collectAll(),
  });
  const queueMessages = new Gauge({
    name: 'sqs_queue_messages',
    help: 'Mensagens por fila e estado (visible, not_visible, delayed)',
    labelNames: ['queue', 'state'],
    registers: [registry],
    collect: () => collectAll(),
  });

  let refreshing: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    outboxPending.reset();
    outboxOldest.reset();
    pendingBacklog.reset();
    queueMessages.reset();
    await Promise.all([refreshDatabase(), refreshQueues()]);
  };
  const refreshDatabase = async (): Promise<void> => {
    try {
      const rows = await withTimeout(
        sources.sql.all<unknown>(
          `SELECT (SELECT count(*) FROM outbox_messages WHERE published_at IS NULL)::text AS "outboxPending",
                  COALESCE((SELECT extract(epoch FROM clock_timestamp() - min(created_at))
                              FROM outbox_messages WHERE published_at IS NULL), 0)::text AS "outboxOldestAgeSeconds",
                  (SELECT count(*) FROM wager_transactions WHERE status = 'PENDING_REFERENCE')::text AS "pendingReferences"`,
        ),
        sources.timeoutMs,
      );
      const values = backlogSchema.parse(rows[0]);
      outboxPending.set(values.outboxPending);
      outboxOldest.set(values.outboxOldestAgeSeconds);
      pendingBacklog.set(values.pendingReferences);
    } catch {
      // banco fora: sem valor neste scrape
    }
  };
  const refreshQueues = async (): Promise<void> => {
    await Promise.all(
      sources.queueNames.map(async (queue) => {
        try {
          const response = await sources.sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: await sources.queues.urlOf(queue),
              AttributeNames: [
                'ApproximateNumberOfMessages',
                'ApproximateNumberOfMessagesNotVisible',
                'ApproximateNumberOfMessagesDelayed',
              ],
            }),
            { abortSignal: AbortSignal.timeout(sources.timeoutMs) },
          );
          const attributes = response.Attributes ?? {};
          queueMessages.set({ queue, state: 'visible' }, Number(attributes.ApproximateNumberOfMessages ?? 0));
          queueMessages.set(
            { queue, state: 'not_visible' },
            Number(attributes.ApproximateNumberOfMessagesNotVisible ?? 0),
          );
          queueMessages.set({ queue, state: 'delayed' }, Number(attributes.ApproximateNumberOfMessagesDelayed ?? 0));
        } catch {
          // fila fora: sem valor neste scrape
        }
      }),
    );
  };

  const collectAll = async (): Promise<void> => {
    refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    });
    await refreshing;
  };
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    work,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(`timeout de ${timeoutMs} ms`);
    }),
  ]);
}
