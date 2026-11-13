import { describe, expect, test } from 'bun:test';
import {
  parseIdempotencyKey,
  parseSqsEnvelope,
  parseSubmitTransaction,
} from '../../src/modules/wagering/contracts/submit-transaction.ts';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const codeOf = (input: unknown) => {
  const result = parseSubmitTransaction(input);
  return result.ok ? 'ok' : result.code;
};

describe('[UT-10] contratos zod (HTTP e SQS)', () => {
  test('[UT-10] exemplo do §9 é aceito; UUID normalizado e referência nula vira ausente', () => {
    const result = parseSubmitTransaction({
      ...body,
      playerId: body.playerId.toUpperCase(),
      referenceExternalTransactionId: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.playerId).toBe(body.playerId);
      expect(result.value.referenceExternalTransactionId).toBeUndefined();
      expect(result.value.money).toEqual({ amount: '25.00', currency: 'BRL' });
    }
  });

  test('[UT-10] códigos específicos para valor, moeda e kind; VALIDATION_ERROR no resto', () => {
    expect(codeOf({ ...body, money: { amount: 25, currency: 'BRL' } })).toBe('INVALID_AMOUNT');
    expect(codeOf({ ...body, money: { amount: '25', currency: 'BRL' } })).toBe('INVALID_AMOUNT');
    expect(codeOf({ ...body, money: { amount: '-1.00', currency: 'BRL' } })).toBe('INVALID_AMOUNT');
    expect(codeOf({ ...body, money: { amount: '1.00', currency: 'EUR' } })).toBe('UNSUPPORTED_CURRENCY');
    expect(codeOf({ ...body, kind: 'OPENING' })).toBe('KIND_NOT_ALLOWED');
    expect(codeOf({ ...body, kind: 'JACKPOT' })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, extra: true })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, money: { ...body.money, extra: 1 } })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, providerId: '__internal__' })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, playerId: 'not-a-uuid' })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, roundId: '' })).toBe('VALIDATION_ERROR');
    expect(codeOf({ ...body, roundId: 'has space' })).toBe('VALIDATION_ERROR');
    expect(codeOf(null)).toBe('VALIDATION_ERROR');
  });

  test('[UT-10] Idempotency-Key: obrigatória, única, ASCII visível, até 255', () => {
    expect(parseIdempotencyKey(undefined)).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_MISSING' });
    expect(parseIdempotencyKey('')).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_MISSING' });
    expect(parseIdempotencyKey(['a', 'b'])).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(parseIdempotencyKey('a b')).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(parseIdempotencyKey('x'.repeat(256))).toMatchObject({ ok: false, code: 'IDEMPOTENCY_KEY_INVALID' });
    expect(parseIdempotencyKey('provider-a:transaction-123')).toEqual({
      ok: true,
      value: 'provider-a:transaction-123',
    });
  });

  test('[UT-10] envelope SQS do §10', () => {
    const envelope = {
      messageId: 'msg-123',
      type: 'WagerTransactionRequested',
      occurredAt: '2026-07-29T15:00:00.000Z',
      data: { ...body, idempotencyKey: 'provider-a:transaction-123' },
    };
    const ok = parseSqsEnvelope(JSON.stringify(envelope));
    expect(ok).toMatchObject({
      ok: true,
      value: { messageId: 'msg-123', idempotencyKey: 'provider-a:transaction-123' },
    });

    expect(parseSqsEnvelope('{not json')).toMatchObject({ ok: false, code: 'MALFORMED_JSON' });
    expect(parseSqsEnvelope(JSON.stringify({ ...envelope, type: 'Other' }))).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_MESSAGE_TYPE',
    });
    expect(parseSqsEnvelope('x'.repeat(16 * 1024 + 1))).toMatchObject({ ok: false, code: 'MESSAGE_TOO_LARGE' });
    const noKey = { ...envelope, data: body };
    expect(parseSqsEnvelope(JSON.stringify(noKey))).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(parseSqsEnvelope(JSON.stringify({ ...envelope, extra: 1 }))).toMatchObject({
      ok: false,
      code: 'VALIDATION_ERROR',
    });
    expect(
      parseSqsEnvelope(JSON.stringify({ ...envelope, data: { ...envelope.data, kind: 'OPENING' } })),
    ).toMatchObject({
      ok: false,
      code: 'KIND_NOT_ALLOWED',
    });
  });
});
