import { randomInt } from 'node:crypto';

/**
 * Identidade da execução de testes e guardas de isolamento (D45): os testes só
 * criam e apagam bancos `wt_<runId>_*` e filas `t-<runId>-*`.
 */
export const TEST_DB_RE = /^wt_[a-z0-9]{8}_[a-z0-9_]{1,40}$/;
export const TEST_QUEUE_RE = /^t-[a-z0-9]{8}-[A-Za-z0-9_-]{1,60}(\.fifo)?$/;

export function newRunId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += alphabet[randomInt(alphabet.length)] ?? 'x';
  return id;
}

export const RUN_ID: string = process.env['RUN_ID'] ?? newRunId();
export const RESULTS_DIR: string = process.env['RESULTS_DIR'] ?? `/app/test-results/${RUN_ID}`;

export function assertTestDbName(name: string): void {
  if (!TEST_DB_RE.test(name)) throw new Error(`guarda de isolamento: banco fora do padrão de teste: ${name}`);
}

export function assertTestQueueName(name: string): void {
  if (!TEST_QUEUE_RE.test(name)) throw new Error(`guarda de isolamento: fila fora do padrão de teste: ${name}`);
}

export function testDbName(suffix: string): string {
  const name = `wt_${RUN_ID}_${suffix}`;
  assertTestDbName(name);
  return name;
}

export function testQueueName(suffix: string, fifo = true): string {
  const name = `t-${RUN_ID}-${suffix}${fifo ? '.fifo' : ''}`;
  assertTestQueueName(name);
  return name;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`variável de teste ausente: ${name}`);
  return value;
}
