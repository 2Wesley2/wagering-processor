import { describe, expect, test } from 'bun:test';
import { outboxBackoffMs, pendingReferenceBackoffMs, sqsRetryVisibilityS } from '../../src/shared/backoff.ts';
import { effectiveDeadline } from '../../src/modules/wagering/domain/pending-deadline.ts';

const timeAt = (iso: string) => new Date(`2026-11-11T12:${iso}.000Z`);

describe('[UT-08] backoff e prazo efetivo em cadeia', () => {
  test('[UT-08] outbox: 1 s·2^n até 5 min, jitter de até 20 %', () => {
    expect([0, 1, 3, 8, 9, 30].map((n) => outboxBackoffMs(n, () => 0))).toEqual([
      1000, 2000, 8000, 256_000, 300_000, 300_000,
    ]);
    expect(outboxBackoffMs(3, () => 0.5)).toBe(8800);
    expect(outboxBackoffMs(9, () => 0.999)).toBeLessThan(360_000);
  });

  test('[UT-08] agenda de pendências: min(60 s, 1 s·2^n)·U(0.5, 1)', () => {
    expect(pendingReferenceBackoffMs(0, () => 0)).toBe(500);
    expect(pendingReferenceBackoffMs(0, () => 0.5)).toBe(750);
    expect(pendingReferenceBackoffMs(4, () => 0)).toBe(8000);
    expect(pendingReferenceBackoffMs(10, () => 0)).toBe(30_000);
    expect(pendingReferenceBackoffMs(10, () => 0.999_999)).toBeLessThanOrEqual(60_000);
  });

  test('[UT-08] retry SQS: visibilidade cresce com ApproximateReceiveCount e respeita 1 s ≤ v ≤ 43200 s', () => {
    expect(sqsRetryVisibilityS(1, () => 0)).toBe(1);
    expect(sqsRetryVisibilityS(5, () => 0)).toBe(8);
    expect(sqsRetryVisibilityS(50, () => 0.999_999)).toBeLessThanOrEqual(300);
  });

  test('[UT-08] prazo efetivo: referência pendente aceita antes do prazo estende; aceita depois não', () => {
    const deadlineP = timeAt('00:30');
    expect(effectiveDeadline(deadlineP, undefined)).toEqual(deadlineP);
    // R não pendente: prazo próprio.
    expect(effectiveDeadline(deadlineP, { acceptedAt: timeAt('00:10'), wasPending: false })).toEqual(deadlineP);
    // R pendente aceita às :10 com prazo efetivo :40 → P herda :40.
    expect(
      effectiveDeadline(deadlineP, {
        acceptedAt: timeAt('00:10'),
        wasPending: true,
        effectiveDeadline: timeAt('00:40'),
      }),
    ).toEqual(timeAt('00:40'));
    // R pendente com prazo anterior ao de P → fica o de P.
    expect(
      effectiveDeadline(deadlineP, {
        acceptedAt: timeAt('00:10'),
        wasPending: true,
        effectiveDeadline: timeAt('00:20'),
      }),
    ).toEqual(deadlineP);
    // R aceita depois do prazo de P → não estende.
    expect(
      effectiveDeadline(deadlineP, {
        acceptedAt: timeAt('00:31'),
        wasPending: true,
        effectiveDeadline: timeAt('01:00'),
      }),
    ).toEqual(deadlineP);
  });
});
