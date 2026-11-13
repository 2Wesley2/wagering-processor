import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '../../src/shared/canonical-json.ts';
import { commandHash, envelopeHash } from '../../src/modules/wagering/domain/command-hash.ts';

/** Exemplo do §9 do enunciado. */
const example = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

/** JSON canônico do exemplo, escrito à mão (chaves em ordem, sem espaços). */
const EXAMPLE_CANONICAL =
  '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},' +
  '"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

/** Golden vector do plano (D28). */
const GOLDEN = 'v1:629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344';

describe('[UT-07] payloadHash e envelopeHash', () => {
  test('[UT-07] JSON canônico: chaves ordenadas, sem espaços, null ≡ ausente', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: null }, e: undefined })).toBe('{"a":{"d":"x"},"b":1}');
    expect(canonicalJson(example)).toBe(EXAMPLE_CANONICAL);
  });

  test('[UT-07] golden vector do exemplo do §9 (sha256 calculado de forma independente)', () => {
    const independent = `v1:${new Bun.CryptoHasher('sha256').update(EXAMPLE_CANONICAL).digest('hex')}`;
    expect(independent).toBe(GOLDEN);
    expect(commandHash(example)).toBe(GOLDEN);
  });

  test('[UT-07] estável a permutação de chaves, UUID em maiúsculas e referência nula', () => {
    const permuted = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      walletId: example.walletId.toUpperCase(),
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      playerId: example.playerId.toUpperCase(),
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
      referenceExternalTransactionId: null,
    };
    expect(commandHash(permuted)).toBe(GOLDEN);
  });

  test('[UT-07] qualquer campo de negócio diferente muda o hash (conflito, não replay)', () => {
    const variants = [
      { ...example, money: { amount: '25.01', currency: 'BRL' } },
      { ...example, money: { amount: '25.00', currency: 'USD' } },
      { ...example, kind: 'WIN' },
      { ...example, gameId: 'other' },
      { ...example, providerId: 'provider-b' },
      { ...example, referenceExternalTransactionId: 'x' },
    ];
    const hashes = new Set(variants.map((variant) => commandHash(variant)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(GOLDEN)).toBe(false);
  });

  test('[UT-07] envelopeHash ignora messageId e occurredAt e depende de type e data', () => {
    const original = envelopeHash({ type: 'WagerTransactionRequested', data: { ...example, idempotencyKey: 'k' } });
    const reordered = envelopeHash({ data: { idempotencyKey: 'k', ...example }, type: 'WagerTransactionRequested' });
    expect(reordered).toBe(original);
    expect(envelopeHash({ type: 'Other', data: { ...example, idempotencyKey: 'k' } })).not.toBe(original);
    expect(envelopeHash({ type: 'WagerTransactionRequested', data: { ...example, idempotencyKey: 'k2' } })).not.toBe(
      original,
    );
    expect(original).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});
