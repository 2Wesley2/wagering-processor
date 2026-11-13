import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  TransactionContractError,
  WagerTransaction,
} from '../../src/modules/wagering/domain/wager-transaction.ts';
import { AT, brl, HASH, pending, stored } from '../support/factories.ts';

function contractCode(attempt: () => unknown): string {
  try {
    attempt();
    return 'ok';
  } catch (error) {
    if (error instanceof TransactionContractError) return error.code;
    throw error;
  }
}

describe('[UT-04] WagerTransaction: criação por kind, transições e direção no ledger', () => {
  test('[UT-04] exigências de referência e valor por kind', () => {
    expect(contractCode(() => pending('BET', '10.00'))).toBe('ok');
    expect(contractCode(() => pending('BET', '10.00', { referenceExternalId: 'x' }))).toBe('REFERENCE_NOT_ALLOWED');
    expect(contractCode(() => pending('REFUND', '10.00'))).toBe('REFERENCE_REQUIRED');
    expect(contractCode(() => pending('ROLLBACK', '10.00'))).toBe('REFERENCE_REQUIRED');
    expect(contractCode(() => pending('WIN', '10.00'))).toBe('ok');
    expect(contractCode(() => pending('WIN', '10.00', { referenceExternalId: 'bet-1' }))).toBe('ok');
    expect(contractCode(() => pending('LOSS', '0.00', { referenceExternalId: 'bet-1' }))).toBe('ok');
    expect(contractCode(() => pending('WIN', '0.00'))).toBe('INVALID_AMOUNT');
    expect(contractCode(() => pending('BET', '0.00'))).toBe('INVALID_AMOUNT');
    expect(contractCode(() => pending('REFUND', '10.00', { externalId: 'r1', referenceExternalId: 'r1' }))).toBe(
      'SELF_REFERENCE',
    );
    expect(contractCode(() => pending('OPENING', '10.00'))).toBe('KIND_NOT_ALLOWED');
    expect(contractCode(() => pending('BET', '10.00', { providerId: '__internal__' }))).toBe('KIND_NOT_ALLOWED');
  });

  test('[UT-04] nasce PENDING; transições válidas a partir de PENDING', () => {
    const processed = pending('BET', '10.00');
    expect(processed.status).toBe('PENDING');
    processed.markProcessed(undefined, AT);
    expect([processed.status, processed.isTerminal()]).toEqual(['PROCESSED', true]);

    const rejected = pending('BET', '10.00');
    rejected.reject('INSUFFICIENT_FUNDS', AT);
    expect([rejected.status, rejected.failureCode]).toEqual(['REJECTED', 'INSUFFICIENT_FUNDS']);

    const failed = pending('BET', '10.00');
    failed.fail('PROCESSING_PERMANENT_FAILURE', AT);
    expect([failed.status, failed.failureCode]).toEqual(['FAILED', 'PROCESSING_PERMANENT_FAILURE']);

    const awaiting = pending('REFUND', '10.00', { referenceExternalId: 'bet-1' });
    awaiting.markPendingReference();
    awaiting.markPendingReference();
    expect(awaiting.status).toBe('PENDING_REFERENCE');
    awaiting.markProcessed('id-bet-1', AT);
    expect([awaiting.status, awaiting.referenceTransactionId]).toEqual(['PROCESSED', 'id-bet-1']);
  });

  test('[UT-04] PENDING_REFERENCE pode ir para REJECTED e FAILED', () => {
    const a = stored('REFUND', '10.00', 'PENDING_REFERENCE', { referenceExternalId: 'b' });
    a.reject('REFERENCE_NOT_FOUND', AT);
    expect(a.status).toBe('REJECTED');
    const b = stored('REFUND', '10.00', 'PENDING_REFERENCE', { referenceExternalId: 'b' });
    b.fail('PROCESSING_PERMANENT_FAILURE', AT);
    expect(b.status).toBe('FAILED');
  });

  test('[UT-04] todo estado terminal recusa qualquer transição', () => {
    for (const status of ['PROCESSED', 'REJECTED', 'FAILED'] as const) {
      const transitions: (() => void)[] = [
        () => stored('REFUND', '1.00', status, { referenceExternalId: 'b' }).markProcessed('x', AT),
        () => stored('REFUND', '1.00', status, { referenceExternalId: 'b' }).markPendingReference(),
        () => stored('REFUND', '1.00', status, { referenceExternalId: 'b' }).reject('INSUFFICIENT_FUNDS', AT),
        () => stored('REFUND', '1.00', status, { referenceExternalId: 'b' }).fail('PROCESSING_PERMANENT_FAILURE', AT),
      ];
      for (const transition of transitions) expect(transition).toThrow(InvalidTransactionStateError);
    }
  });

  test('[UT-04] direção no ledger por kind; ROLLBACK é o inverso da referência', () => {
    expect(pending('BET', '1.00').ledgerDirectionFor()).toBe('DEBIT');
    expect(pending('WIN', '1.00').ledgerDirectionFor()).toBe('CREDIT');
    expect(pending('LOSS', '1.00').ledgerDirectionFor()).toBeNull();
    expect(pending('REFUND', '1.00', { referenceExternalId: 'b' }).ledgerDirectionFor()).toBe('CREDIT');
    const rollback = pending('ROLLBACK', '1.00', { referenceExternalId: 'x' });
    expect(rollback.ledgerDirectionFor(stored('BET', '1.00', 'PROCESSED'))).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(stored('WIN', '1.00', 'PROCESSED'))).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(stored('REFUND', '1.00', 'PROCESSED', { referenceExternalId: 'b' }))).toBe(
      'DEBIT',
    );
  });

  test('[UT-04] consultas: affectsBalance, requiresReference, matchesPayload', () => {
    expect(pending('LOSS', '0.00').affectsBalance()).toBe(false);
    expect(pending('BET', '1.00').affectsBalance()).toBe(true);
    expect(pending('ROLLBACK', '1.00', { referenceExternalId: 'b' }).requiresReference()).toBe(true);
    expect(pending('WIN', '1.00').requiresReference()).toBe(false);
    expect(pending('BET', '1.00').matchesPayload(HASH)).toBe(true);
    expect(pending('BET', '1.00').matchesPayload(`v1:${'b'.repeat(64)}`)).toBe(false);
  });

  test('[UT-04] OPENING interna nasce PROCESSED com provider reservado', () => {
    const opening = WagerTransaction.createOpening({
      id: 'o1',
      walletId: 'w1',
      playerId: 'p1',
      money: brl('100.00'),
      payloadHash: HASH,
      createdAt: AT,
    });
    expect([opening.kind, opening.status, opening.providerId, opening.idempotencyKey]).toEqual([
      'OPENING',
      'PROCESSED',
      '__internal__',
      'internal:opening:w1',
    ]);
    expect(opening.ledgerDirectionFor()).toBe('CREDIT');
  });
});
