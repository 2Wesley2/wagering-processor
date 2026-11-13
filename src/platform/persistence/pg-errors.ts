import { classifySqlState, type SqlStateClass } from '../../shared/error-catalog.ts';

export interface PgErrorInfo {
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;
  readonly classification: SqlStateClass | 'CONNECTION';
}

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);

/** Lê uma propriedade string de um erro sem afirmação de tipo (pg e MikroORM copiam campos do driver). */
function stringProperty(error: object, key: string): string | undefined {
  const value: unknown = Reflect.get(error, key);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Extrai SQLSTATE e constraint de um erro do pg ou de uma DriverException do
 * MikroORM (que copia os campos do erro do driver). Erros de socket viram CONNECTION.
 */
export function pgErrorInfo(error: unknown): PgErrorInfo {
  if (typeof error !== 'object' || error === null)
    return { sqlState: undefined, constraint: undefined, classification: 'UNKNOWN' };
  const code = stringProperty(error, 'code');
  const constraint = stringProperty(error, 'constraint');
  if (code !== undefined && /^[0-9A-Z]{5}$/.test(code))
    return { sqlState: code, constraint, classification: classifySqlState(code) };
  if (code !== undefined && CONNECTION_CODES.has(code))
    return { sqlState: undefined, constraint, classification: 'CONNECTION' };
  const message = stringProperty(error, 'message') ?? '';
  if (
    // Mensagens do driver `pg` quando a conexão já caiu (inclusive encerrada pelo servidor, 25P03):
    // o cliente fica "not queryable" e a próxima consulta falha sem SQLSTATE.
    /Connection terminated|connection timeout|timeout exceeded when trying to connect|Query read timeout|not queryable|Client was closed/i.test(
      message,
    )
  ) {
    return { sqlState: undefined, constraint, classification: 'CONNECTION' };
  }
  const cause = 'cause' in error ? error.cause : undefined;
  if (cause !== undefined && cause !== error) {
    const inner = pgErrorInfo(cause);
    if (inner.classification !== 'UNKNOWN') return inner;
  }
  return { sqlState: undefined, constraint, classification: 'UNKNOWN' };
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const info = pgErrorInfo(error);
  return info.sqlState === '23505' && info.constraint === constraint;
}
