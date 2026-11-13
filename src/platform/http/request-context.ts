import { ContextStore } from '../observability/context.ts';

interface MinimalRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

interface MinimalResponse {
  setHeader(name: string, value: string): unknown;
}

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Aceita ou gera o X-Correlation-Id, devolve-o junto com o X-Instance-Id e
 * propaga o contexto de log pelo AsyncLocalStorage (D41).
 */
export function requestContextMiddleware(instanceId: string) {
  return (request: MinimalRequest, response: MinimalResponse, next: () => void): void => {
    const incoming = request.headers['x-correlation-id'];
    const correlationId = typeof incoming === 'string' && CORRELATION_ID.test(incoming) ? incoming : Bun.randomUUIDv7();
    response.setHeader('X-Correlation-Id', correlationId);
    response.setHeader('X-Instance-Id', instanceId);
    ContextStore.run({ correlationId }, next);
  };
}
