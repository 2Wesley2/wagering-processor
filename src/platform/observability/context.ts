import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação que todo log carrega (§12). Nunca valores financeiros. */
export interface LogContext {
  correlationId?: string;
  causationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const ContextStore = {
  run<T>(context: LogContext, callback: () => T): T {
    return storage.run({ ...context }, callback);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
  set(patch: LogContext): void {
    const current = storage.getStore();
    if (current !== undefined) Object.assign(current, patch);
  },
};
