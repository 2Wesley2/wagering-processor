import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { DeduplicationIdError, deduplicationId, republishDeduplicationId } from '../../src/shared/deduplication-id.ts';

/**
 * UT-14: MessageDeduplicationId sempre válido para a AWS (≤ 128 caracteres, alfanuméricos e a
 * pontuação ASCII permitida), estável por tentativa e diferente entre tentativas. O formato
 * esperado é escrito aqui de novo (D58), sem reaproveitar a expressão de src/.
 */
const AWS_DEDUP_ID = /^[A-Za-z0-9!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{1,128}$/;

const LONG_MESSAGE_ID = `m-${'x'.repeat(198)}`;
const SYMBOLS_MESSAGE_ID = 'pedido nº 7 — açaí 🍇\nlinha 2';
const CONSUMER = 'wager-transactions';
const HASH = `v1:${'a'.repeat(64)}`;

describe('[UT-14] construtor de MessageDeduplicationId', () => {
  test('[UT-14] messageId de 200 caracteres e com espaço, acento, emoji e \\n: id válido e curto', () => {
    expect(LONG_MESSAGE_ID).toHaveLength(200);
    for (const messageId of [LONG_MESSAGE_ID, SYMBOLS_MESSAGE_ID, `sqs:${Bun.randomUUIDv7()}`]) {
      const dlq = deduplicationId('dlq', [CONSUMER, messageId, HASH], [['a', 1]]);
      const redrive = deduplicationId(
        'rd',
        [CONSUMER, messageId, HASH],
        [
          ['a', 1],
          ['r', 3],
        ],
      );
      for (const id of [dlq, redrive]) {
        expect(id).toMatch(AWS_DEDUP_ID);
        expect(id.length).toBeLessThanOrEqual(64);
        expect(id).not.toContain(messageId.slice(0, 10));
      }
      expect(dlq).toMatch(/^dlq:[0-9a-f]{40}:a1$/);
      expect(redrive).toMatch(/^rd:[0-9a-f]{40}:a1:r3$/);
    }
  });

  test('[UT-14] mesma tentativa → mesmo id; tentativa, redrive ou execução nova → id novo', () => {
    const parts = [CONSUMER, LONG_MESSAGE_ID, HASH];
    expect(deduplicationId('dlq', parts, [['a', 2]])).toBe(deduplicationId('dlq', parts, [['a', 2]]));
    expect(deduplicationId('dlq', parts, [['a', 2]])).not.toBe(deduplicationId('dlq', parts, [['a', 3]]));
    const redrive = (attempt: number, count: number) =>
      deduplicationId('rd', parts, [
        ['a', attempt],
        ['r', count],
      ]);
    expect(redrive(1, 1)).not.toBe(redrive(1, 2));
    expect(redrive(1, 2)).not.toBe(redrive(2, 2));
    // dl_keys diferentes nunca colidem, inclusive quando a concatenação ingênua coincidiria.
    expect(deduplicationId('dlq', ['ab', 'c'])).not.toBe(deduplicationId('dlq', ['a', 'bc']));
    const eventId = Bun.randomUUIDv7();
    expect(republishDeduplicationId(eventId, 'run1')).toBe(`rp:${eventId}:run1`);
    expect(republishDeduplicationId(eventId, 'run1')).not.toBe(republishDeduplicationId(eventId, 'run2'));
    expect(republishDeduplicationId(eventId, 'run1').length).toBeLessThanOrEqual(128);
  });

  test('[UT-14] entradas inválidas falham alto em vez de produzir um id que a AWS recusaria', () => {
    expect(() => deduplicationId('DLQ', ['x'])).toThrow(DeduplicationIdError);
    expect(() => deduplicationId('dlq', [])).toThrow(DeduplicationIdError);
    expect(() => deduplicationId('dlq', ['x'], [['a', -1]])).toThrow(DeduplicationIdError);
    expect(() => republishDeduplicationId('id com espaço', 'r')).toThrow(DeduplicationIdError);
  });

  test('[UT-14] 100 000 entradas aleatórias (fast-check, seed fixa): formato sempre válido e determinístico', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'binary', maxLength: 220 }), { minLength: 1, maxLength: 4 }),
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        (parts, attempt, redrives) => {
          const id = deduplicationId('rd', parts, [
            ['a', attempt],
            ['r', redrives],
          ]);
          expect(id).toMatch(AWS_DEDUP_ID);
          expect(
            deduplicationId('rd', parts, [
              ['a', attempt],
              ['r', redrives],
            ]),
          ).toBe(id);
        },
      ),
      { seed: 20261112, numRuns: 100_000 },
    );
  });
});
