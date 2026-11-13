import { describe, expect, test } from 'bun:test';
import { classifySqlState, ERROR_CATALOG, type ErrorCode, REJECTION_CODES } from '../../src/shared/error-catalog.ts';

const TRANSPORT_HTTP: Record<string, number> = { PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415 };

const EXPECTED_HTTP: Record<string, number | undefined> = {
  validation: 400,
  authentication: 401,
  identity: 403,
  not_found: 404,
  conflict: 409,
  business: 422,
  transient: 503,
  permanent: 500,
  queue: undefined,
};

describe('[UT-09] ErrorCatalog e classificação de SQLSTATE', () => {
  test('[UT-09] cada código tem o status HTTP da sua categoria', () => {
    for (const [code, meta] of Object.entries(ERROR_CATALOG)) {
      const http: number | undefined = meta.http;
      const expected = meta.category === 'transport' ? TRANSPORT_HTTP[code] : EXPECTED_HTTP[meta.category];
      expect({ code, http }).toEqual({ code, http: expected });
    }
  });

  test('[UT-09] retryable é true só no 503; só negócio e falha permanente persistem', () => {
    for (const [code, meta] of Object.entries(ERROR_CATALOG)) {
      expect({ code, retryable: meta.retryable }).toEqual({ code, retryable: meta.http === 503 });
      expect({ code, persists: meta.persists }).toEqual({
        code,
        persists: meta.category === 'business' || code === 'PROCESSING_PERMANENT_FAILURE',
      });
    }
  });

  test('[UT-09] ação SQS coerente: negócio → ACK; transitório → RETRY; conflito → DEAD_LETTER', () => {
    for (const meta of Object.values(ERROR_CATALOG)) {
      if (meta.category === 'business') expect(meta.sqs).toBe('ACK');
      if (meta.category === 'transient') expect(meta.sqs).toBe('RETRY');
      if (meta.category === 'conflict') expect(meta.sqs).toBe('DEAD_LETTER');
    }
  });

  test('[UT-09] códigos exigidos pelo enunciado existem e são distintos', () => {
    const required: ErrorCode[] = [
      'INSUFFICIENT_FUNDS',
      'REVERSAL_INSUFFICIENT_FUNDS',
      'REFERENCE_NOT_FOUND',
      'IDEMPOTENCY_KEY_REUSED',
      'CURRENCY_MISMATCH',
    ];
    for (const code of required) expect(Object.hasOwn(ERROR_CATALOG, code)).toBe(true);
    expect(REJECTION_CODES).toContain('INSUFFICIENT_FUNDS');
    expect(REJECTION_CODES).toContain('REVERSAL_INSUFFICIENT_FUNDS');
    expect(REJECTION_CODES).not.toContain('IDEMPOTENCY_KEY_REUSED');
    expect(new Set(Object.keys(ERROR_CATALOG)).size).toBe(Object.keys(ERROR_CATALOG).length);
  });

  test('[UT-09] SQLSTATE → classe (D26)', () => {
    const table: [string | undefined, string][] = [
      ['40001', 'RETRY_UOW'],
      ['40P01', 'RETRY_UOW'],
      ['55P03', 'RETRY_UOW'],
      ['23505', 'UNIQUE_VIOLATION'],
      ['23514', 'INTEGRITY_BUG'],
      ['23503', 'INTEGRITY_BUG'],
      ['57014', 'TIMEOUT'],
      ['08006', 'UNAVAILABLE'],
      ['57P01', 'UNAVAILABLE'],
      ['53300', 'UNAVAILABLE'],
      ['42601', 'UNKNOWN'],
      [undefined, 'UNKNOWN'],
    ];
    for (const [state, sqlStateClass] of table) {
      const got: string = classifySqlState(state);
      expect({ state, cls: got }).toEqual({ state, cls: sqlStateClass });
    }
  });
});
