/**
 * Backoffs (D38, D40, D35). `random` é injetado (U[0,1)) para os testes serem
 * determinísticos. Valores em milissegundos; nunca dinheiro.
 */
export type RandomSource = () => number;

function exponential(attempts: number, baseMs: number, capMs: number): number {
  const exponent = Math.min(Math.max(attempts, 0), 30);
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/** Outbox: min(5 min, 1 s·2^n) + jitter de até 20 % do atraso. Nunca descarta. */
export function outboxBackoffMs(attempts: number, random: RandomSource): number {
  const delay = exponential(attempts, 1000, 300_000);
  return delay + Math.floor(delay * 0.2 * random());
}

/** Agenda de PENDING_REFERENCE: min(60 s, 1 s·2^n)·U(0.5, 1). */
export function pendingReferenceBackoffMs(attempts: number, random: RandomSource): number {
  const delay = exponential(attempts, 1000, 60_000);
  return Math.floor(delay * (0.5 + 0.5 * random()));
}

/** Consumidor SQS: visibilidade de retry por ApproximateReceiveCount, limitada ao VT máximo da AWS. */
export function sqsRetryVisibilityS(receiveCount: number, random: RandomSource): number {
  const delayMs = exponential(Math.max(receiveCount - 1, 0), 1000, 300_000);
  return Math.min(43_200, Math.max(1, Math.floor((delayMs * (0.5 + 0.5 * random())) / 1000)));
}
