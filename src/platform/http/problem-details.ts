import type { IncomingMessage } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import { DomainError } from '../../shared/errors.ts';
import { ERROR_CATALOG, type ErrorCode, isErrorCode } from '../../shared/error-catalog.ts';
import { ContextStore } from '../observability/context.ts';
import type { AppLogger } from '../observability/logger.ts';
import { pgErrorInfo } from '../persistence/pg-errors.ts';
import { LOGGER } from '../tokens.ts';

/** Erro de borda HTTP com código do catálogo e campos extras do problem+json. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const MAX_JSON_BODY_BYTES = 16 * 1024;

/** O stream HTTP entrega Buffer (ou string, se houver encoding definido); outro tipo é erro de programação. */
function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('pedaço de corpo HTTP com tipo inesperado');
}

/**
 * Lê o corpo JSON com limite antes do parse (D31: 415 → 413 → JSON). O body
 * parser padrão do Nest fica desligado para estes erros saírem como problem+json.
 */
export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type precisa ser application/json');
  }
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = toBuffer(chunk);
    total += buffer.length;
    if (total <= MAX_JSON_BODY_BYTES) chunks.push(buffer);
    else if (total > 64 * MAX_JSON_BODY_BYTES) break;
  }
  if (total > MAX_JSON_BODY_BYTES || declared > MAX_JSON_BODY_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', `corpo acima de ${MAX_JSON_BODY_BYTES} bytes`);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body;
  } catch {
    throw new AppError('MALFORMED_JSON', 'corpo não é JSON válido');
  }
}

interface ProblemResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
  end(body: string): unknown;
  headersSent?: boolean;
}

interface Classified {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

function classify(exception: unknown): Classified {
  if (exception instanceof AppError) return { code: exception.code, detail: exception.message, extra: exception.extra };
  if (exception instanceof DomainError && isErrorCode(exception.code)) {
    const extra =
      'existingWalletId' in exception && typeof exception.existingWalletId === 'string'
        ? { existingWalletId: exception.existingWalletId }
        : {};
    return { code: exception.code, detail: exception.message, extra };
  }
  if (exception instanceof HttpException) {
    return { code: httpStatusCode(exception.getStatus()), detail: exception.message, extra: {} };
  }
  return classifyDatabaseError(exception);
}

/** Status HTTP gerado pelo próprio Nest (rota inexistente, corpo etc.) → código do catálogo. */
const HTTP_STATUS_CODES: Readonly<Record<number, ErrorCode>> = {
  404: 'ROUTE_NOT_FOUND',
  405: 'ROUTE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

function httpStatusCode(status: number): ErrorCode {
  const mapped = HTTP_STATUS_CODES[status];
  if (mapped !== undefined) return mapped;
  return status < 500 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
}

function classifyDatabaseError(exception: unknown): Classified {
  const { classification } = pgErrorInfo(exception);
  if (classification === 'RETRY_UOW') {
    return { code: 'CONCURRENCY_CONFLICT', detail: 'conflito de concorrência; reenviar com a mesma key', extra: {} };
  }
  if (classification === 'UNAVAILABLE' || classification === 'TIMEOUT' || classification === 'CONNECTION') {
    return { code: 'DATABASE_UNAVAILABLE', detail: 'banco de dados indisponível', extra: {} };
  }
  return { code: 'INTERNAL_ERROR', detail: 'erro interno', extra: {} };
}

/**
 * Filtro único (D31): todo erro sai como application/problem+json (RFC 9457)
 * com `code` do catálogo, `retryable` (só no 503) e `correlationId`.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<ProblemResponse>();
    const request = http.getRequest<{ url?: string; method?: string }>();
    const { code, detail, extra } = classify(exception);
    const meta = ERROR_CATALOG[code];
    const status = meta.http ?? 500;
    const header = response.getHeader('X-Correlation-Id');
    const correlationId = typeof header === 'string' ? header : ContextStore.get().correlationId;
    if (status >= 500) {
      this.logger.error(
        {
          event: 'http.error',
          code,
          method: request.method,
          path: request.url?.split('?')[0],
          error: exception instanceof Error ? `${exception.name}: ${exception.message}` : String(exception),
          sqlState: pgErrorInfo(exception).sqlState,
        },
        'http.error',
      );
    }
    if (response.headersSent === true) return;
    response.status(status);
    response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    if (meta.retryable) response.setHeader('Retry-After', '1');
    response.end(
      JSON.stringify({
        type: `urn:wagering:error:${code}`,
        title: code,
        status,
        code,
        detail,
        retryable: meta.retryable,
        correlationId,
        ...extra,
      }),
    );
  }
}
