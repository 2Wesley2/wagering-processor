export interface EventuallyOptions {
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly describe: string;
  /** Diagnóstico impresso quando o prazo estoura (estado do banco, da fila, logs). */
  readonly diagnose?: () => unknown;
}

/** Espera uma condição sem sleep fixo; ao estourar, falha com diagnóstico (D55). */
export async function eventually<T>(
  probe: () => Promise<T | undefined | false> | T | undefined | false,
  options: EventuallyOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(options.intervalMs ?? 100);
  }
  const diagnosis = options.diagnose ? await options.diagnose() : undefined;
  throw new Error(
    `eventually: "${options.describe}" não ocorreu em ${options.timeoutMs} ms` +
      (lastError instanceof Error ? `; último erro: ${lastError.message}` : '') +
      (diagnosis === undefined ? '' : `\ndiagnóstico: ${JSON.stringify(diagnosis, null, 2)}`),
  );
}

/** Resolve com o erro de uma promessa rejeitada (ou undefined se ela resolveu). */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}
