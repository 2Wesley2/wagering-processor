import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { api, field } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { invariantIssues, openWallet, submission, submit, type TestWallet, walletState } from '../support/wagering.ts';

/**
 * IT-12: matriz 400/403/404/413/415 do POST /wagering/transactions, sem efeito colateral; um
 * mismatch é corrigível reenviando com a mesma key (nada foi gravado).
 */
let fixture: Fixture;
let app: Instance;
let wallet: TestWallet;

beforeAll(async () => {
  fixture = await createFixture('it12');
  app = startInstance({ id: 'it12-1', env: fixture.env() });
  await waitReady(app);
  wallet = await openWallet(app.baseUrl, '100.00');
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const post = (body: unknown, key: string | undefined) => submit(app.baseUrl, body, key);

describe('[IT-12] matriz de erros de contrato, identidade e endereçamento', () => {
  test('[IT-12] cada caso tem status e código próprios e nada é gravado', async () => {
    const valid = submission(wallet);
    const cases: [string, unknown, string | undefined, number, string][] = [
      ['sem key', valid, undefined, 400, 'IDEMPOTENCY_KEY_MISSING'],
      ['key com espaço', valid, 'key inválida', 400, 'IDEMPOTENCY_KEY_INVALID'],
      ['key com 256 caracteres', valid, 'k'.repeat(256), 400, 'IDEMPOTENCY_KEY_INVALID'],
      ['valor com 1 casa', { ...valid, money: { amount: '10.5', currency: 'BRL' } }, 'c-1', 400, 'INVALID_AMOUNT'],
      ['valor number', { ...valid, money: { amount: 10, currency: 'BRL' } }, 'c-2', 400, 'INVALID_AMOUNT'],
      [
        'moeda fora da lista',
        { ...valid, money: { amount: '10.00', currency: 'EUR' } },
        'c-3',
        400,
        'UNSUPPORTED_CURRENCY',
      ],
      ['OPENING', { ...valid, kind: 'OPENING' }, 'c-4', 400, 'KIND_NOT_ALLOWED'],
      ['kind desconhecido', { ...valid, kind: 'JACKPOT' }, 'c-5', 400, 'VALIDATION_ERROR'],
      ['REFUND sem referência', { ...valid, kind: 'REFUND' }, 'c-6', 400, 'REFERENCE_REQUIRED'],
      ['BET com referência', { ...valid, referenceExternalTransactionId: 'x-1' }, 'c-7', 400, 'REFERENCE_NOT_ALLOWED'],
      [
        'autorreferência',
        { ...valid, kind: 'REFUND', referenceExternalTransactionId: valid.externalTransactionId },
        'c-8',
        400,
        'SELF_REFERENCE',
      ],
      ['BET 0.00', { ...valid, money: { amount: '0.00', currency: 'BRL' } }, 'c-9', 400, 'INVALID_AMOUNT'],
      ['campo desconhecido', { ...valid, bonus: true }, 'c-10', 400, 'VALIDATION_ERROR'],
      ['provider interno', { ...valid, providerId: '__internal__' }, 'c-11', 400, 'VALIDATION_ERROR'],
      ['provider não reconhecido', { ...valid, providerId: 'provider-z' }, 'c-12', 403, 'PROVIDER_NOT_RECOGNIZED'],
      ['wallet inexistente', { ...valid, walletId: Bun.randomUUIDv7() }, 'c-13', 404, 'WALLET_NOT_FOUND'],
      ['wallet de outro player', { ...valid, playerId: Bun.randomUUIDv7() }, 'c-14', 400, 'WALLET_PLAYER_MISMATCH'],
      ['moeda da wallet', { ...valid, money: { amount: '10.00', currency: 'USD' } }, 'c-15', 400, 'CURRENCY_MISMATCH'],
    ];
    for (const [name, body, key, status, code] of cases) {
      const response = await post(body, key);
      expect({ name, status: response.status, code: field(response.body, 'code') }).toEqual({ name, status, code });
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    const transport: [string, Parameters<typeof api>[3], number, string][] = [
      [
        'JSON malformado',
        { raw: '{"kind": ', headers: { 'content-type': 'application/json', 'idempotency-key': 't-1' } },
        400,
        'MALFORMED_JSON',
      ],
      [
        'mídia errada',
        { raw: 'x', headers: { 'content-type': 'text/plain', 'idempotency-key': 't-2' } },
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      ],
      [
        'corpo acima de 16 KiB',
        {
          raw: JSON.stringify({ pad: 'x'.repeat(17 * 1024) }),
          headers: { 'content-type': 'application/json', 'idempotency-key': 't-3' },
        },
        413,
        'PAYLOAD_TOO_LARGE',
      ],
    ];
    for (const [name, options, status, code] of transport) {
      const response = await api(app.baseUrl, 'POST', '/wagering/transactions', options);
      expect({ name, status: response.status, code: field(response.body, 'code') }).toEqual({ name, status, code });
    }
    expect(await walletState(fixture.database, wallet.walletId)).toEqual({
      balance: '100.00',
      version: '1',
      entries: '1',
      debits: '0',
      transactions: '0',
      outbox: '2',
    });
  });

  test('[IT-12] mismatch corrigido e reenviado com a mesma key → 200 (nada tinha sido gravado)', async () => {
    const body = submission(wallet, { amount: '10.00' });
    const wrong = await post({ ...body, playerId: Bun.randomUUIDv7() }, 'fix-me-it12');
    expect(wrong.status).toBe(400);
    const fixed = await post(body, 'fix-me-it12');
    expect([fixed.status, field(fixed.body, 'idempotentReplay'), field(fixed.body, 'balance')]).toEqual([
      200,
      false,
      { amount: '90.00', currency: 'BRL' },
    ]);
  });
});
