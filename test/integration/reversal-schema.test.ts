import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type pg from 'pg';
import { appUrl, createTestDatabase, dropTestDatabase, ownerUrl } from '../support/db.ts';
import {
  failureOf,
  HASH,
  inTx,
  movementInOpenTx,
  movementSql,
  openWalletSql,
  withClient,
} from '../support/sql-fixtures.ts';

/**
 * RV-IT-01 e RV-IT-05: o que o schema da migration 0002 aceita e recusa em `wager_reversals`
 * (P1 = C), com dados preparados DIRETAMENTE em SQL pelo role da aplicação e COMMIT explícito
 * (as FKs e a cobertura são diferidas). Não exercita o caso de uso nem o worker.
 */
let database: string;
let url: string;

beforeAll(async () => {
  database = await createTestDatabase('rvsch');
  url = appUrl(database);
});
afterAll(async () => {
  await dropTestDatabase(database);
});

interface ReversalRow {
  reversal_id: string;
  reversal_kind: string;
  direction: string;
  target_id: string;
  target_kind: string;
  target_direction: string;
  wallet_id: string;
  amount: string;
  undone_by?: string;
}

async function insertRow(client: pg.Client, row: ReversalRow): Promise<void> {
  await client.query(
    `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                  wallet_id, currency, amount, undone_by, created_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, $5, $6, $7::uuid, 'BRL', $8::numeric, $9::uuid, now())`,
    [
      row.reversal_id,
      row.reversal_kind,
      row.direction,
      row.target_id,
      row.target_kind,
      row.target_direction,
      row.wallet_id,
      row.amount,
      row.undone_by ?? null,
    ],
  );
}

/** Reversão PROCESSED completa (transação, saldo, lançamento) + a linha de reversão, com ajustes na linha. */
async function refundWithRow(
  client: pg.Client,
  walletId: string,
  bet: { txId: string; externalId: string },
  patch: Partial<ReversalRow> = {},
  externalId = `r-${Bun.randomUUIDv7()}`,
): Promise<string> {
  const refund = await movementInOpenTx(client, walletId, {
    kind: 'WIN',
    kindOverride: 'REFUND',
    amount: '10.00',
    direction: 'CREDIT',
    externalId,
    referenceTxId: bet.txId,
    referenceExternalId: bet.externalId,
  });
  await insertRow(client, {
    reversal_id: refund.txId,
    reversal_kind: 'REFUND',
    direction: 'CREDIT',
    target_id: bet.txId,
    target_kind: 'BET',
    target_direction: 'DEBIT',
    wallet_id: walletId,
    amount: '10.00',
    ...patch,
  });
  return refund.txId;
}

async function betInWallet(client: pg.Client, balance = '100.00') {
  const { walletId } = await openWalletSql(client, { balance });
  const externalId = `b-${Bun.randomUUIDv7()}`;
  const bet = await movementSql(client, walletId, { kind: 'BET', amount: '10.00', externalId });
  return { walletId, bet: { txId: bet.txId, externalId } };
}

describe('[RV-IT-01] restrições de wager_reversals (P1 = C) no schema', () => {
  test('[RV-IT-01] reversão completa e coerente é aceita no COMMIT', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      expect(await failureOf(() => inTx(client, () => refundWithRow(client, walletId, bet)))).toBe('ok');
    });
  });

  test('[RV-IT-01] mesmo tipo duas vezes sobre o alvo → rev_target_kind_uq; segunda reversão em vigor → rev_one_effective_uq', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      await inTx(client, () => refundWithRow(client, walletId, bet));
      expect(await failureOf(() => inTx(client, () => refundWithRow(client, walletId, bet)))).toEqual({
        code: '23505',
        constraint: 'rev_target_kind_uq',
      });
      expect(
        await failureOf(() =>
          inTx(client, async () => {
            const rollback = await movementInOpenTx(client, walletId, {
              kind: 'WIN',
              kindOverride: 'ROLLBACK',
              amount: '10.00',
              direction: 'CREDIT',
              referenceTxId: bet.txId,
              referenceExternalId: bet.externalId,
            });
            await insertRow(client, {
              reversal_id: rollback.txId,
              reversal_kind: 'ROLLBACK',
              direction: 'CREDIT',
              target_id: bet.txId,
              target_kind: 'BET',
              target_direction: 'DEBIT',
              wallet_id: walletId,
              amount: '10.00',
            });
          }),
        ),
      ).toEqual({ code: '23505', constraint: 'rev_one_effective_uq' });
    });
  });

  test('[RV-IT-01] par (reversão, alvo) fora da regra 3 → rev_pair_ck; undone_by em ROLLBACK → rev_undo_kind_ck', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      expect(
        await failureOf(() =>
          inTx(client, () => refundWithRow(client, walletId, bet, { target_kind: 'WIN', target_direction: 'DEBIT' })),
        ),
      ).toEqual({ code: '23514', constraint: 'rev_pair_ck' });
      expect(
        await failureOf(() =>
          inTx(client, () =>
            refundWithRow(client, walletId, bet, {
              reversal_kind: 'ROLLBACK',
              undone_by: Bun.randomUUIDv7(),
            }),
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'rev_undo_kind_ck' });
    });
  });

  test('[RV-IT-01] REFUND desfeito por ROLLBACK: undone_by gravado uma vez; depois a linha não muda nem é apagada', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      const refundExternalId = `r-${Bun.randomUUIDv7()}`;
      const refundId = await inTx(client, () => refundWithRow(client, walletId, bet, {}, refundExternalId));
      const undo = await inTx(client, async () => {
        const rollback = await movementInOpenTx(client, walletId, {
          kind: 'WIN',
          kindOverride: 'ROLLBACK',
          amount: '10.00',
          direction: 'DEBIT',
          referenceTxId: refundId,
          referenceExternalId: refundExternalId,
        });
        await insertRow(client, {
          reversal_id: rollback.txId,
          reversal_kind: 'ROLLBACK',
          direction: 'DEBIT',
          target_id: refundId,
          target_kind: 'REFUND',
          target_direction: 'CREDIT',
          wallet_id: walletId,
          amount: '10.00',
        });
        await client.query('UPDATE wager_reversals SET undone_by = $1::uuid WHERE reversal_id = $2::uuid', [
          rollback.txId,
          refundId,
        ]);
        return rollback.txId;
      });
      expect(undo).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        await failureOf(() =>
          client.query('UPDATE wager_reversals SET undone_by = $1::uuid WHERE reversal_id = $2::uuid', [
            Bun.randomUUIDv7(),
            refundId,
          ]),
        ),
      ).toEqual({ code: '23000', constraint: 'rev_immutable' });
      expect(
        await failureOf(() =>
          withClient(ownerUrl(database), (owner) =>
            owner.query('UPDATE wager_reversals SET amount = 20.00 WHERE reversal_id = $1::uuid', [refundId]),
          ),
        ),
      ).toEqual({ code: '23000', constraint: 'rev_immutable' });
      expect(
        await failureOf(() =>
          withClient(ownerUrl(database), (owner) =>
            owner.query('DELETE FROM wager_reversals WHERE reversal_id = $1::uuid', [refundId]),
          ),
        ),
      ).toEqual({ code: '23000', constraint: 'rev_immutable' });
    });
  });

  test('[RV-IT-01] reversão PROCESSED sem linha em wager_reversals falha no COMMIT (rev_coverage_ck)', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      expect(
        await failureOf(() =>
          inTx(client, () =>
            movementInOpenTx(client, walletId, {
              kind: 'WIN',
              kindOverride: 'REFUND',
              amount: '10.00',
              direction: 'CREDIT',
              referenceTxId: bet.txId,
              referenceExternalId: bet.externalId,
            }),
          ),
        ),
      ).toEqual({ code: '23514', constraint: 'rev_coverage_ck' });
    });
  });
});

describe('[RV-IT-05] negativos de vínculo: a tabela não descreve uma reversão que não aconteceu', () => {
  const fkFailure = (result: Awaited<ReturnType<typeof failureOf>>) => {
    if (result === 'ok') return 'ok';
    const constraint = String(result.constraint);
    return `${result.code}:${constraint.startsWith('rev_') ? 'rev_fk' : constraint}`;
  };

  test('[RV-IT-05] alvo diferente da referência gravada → FK diferida (23503)', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      const other = await movementSql(client, walletId, { kind: 'BET', amount: '10.00' });
      expect(
        fkFailure(
          await failureOf(() => inTx(client, () => refundWithRow(client, walletId, bet, { target_id: other.txId }))),
        ),
      ).toBe('23503:rev_fk');
    });
  });

  test('[RV-IT-05] direção ou valor diferentes do lançamento → FK diferida (23503)', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      expect(
        fkFailure(
          await failureOf(() =>
            inTx(client, () =>
              refundWithRow(client, walletId, bet, {
                direction: 'DEBIT',
                target_direction: 'CREDIT',
                target_kind: 'BET',
              }),
            ),
          ),
        ),
      ).toMatch(/^23(503|514):/);
      expect(
        fkFailure(await failureOf(() => inTx(client, () => refundWithRow(client, walletId, bet, { amount: '9.00' })))),
      ).toBe('23503:rev_fk');
    });
  });

  test('[RV-IT-05] linha para uma reversão REJECTED (sem referência resolvida) → FK diferida (23503)', async () => {
    await withClient(url, async (client) => {
      const { walletId, bet } = await betInWallet(client);
      const rejectedId = Bun.randomUUIDv7();
      expect(
        fkFailure(
          await failureOf(() =>
            inTx(client, async () => {
              await client.query(
                `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
                   round_id, game_id, kind, currency, amount, reference_external_transaction_id, status, failure_code, initial_status,
                   accepted_balance, accepted_wallet_version, accepted_at, result_balance, result_wallet_version, decided_at, available_at,
                   correlation_id, created_at)
                 SELECT $1::uuid, 'provider-a', 'rej-' || $1, 'rej-' || $1, $2, w.id, w.player_id, 'round-1', 'game-1', 'REFUND', 'BRL',
                        10.00, $3, 'REJECTED', 'REFERENCE_AMOUNT_MISMATCH', 'REJECTED', w.balance, w.version, statement_timestamp(),
                        w.balance, w.version, statement_timestamp(), statement_timestamp(), 'sql-fixture', now()
                   FROM wallets w WHERE w.id = $4::uuid`,
                [rejectedId, HASH, bet.externalId, walletId],
              );
              await insertRow(client, {
                reversal_id: rejectedId,
                reversal_kind: 'REFUND',
                direction: 'CREDIT',
                target_id: bet.txId,
                target_kind: 'BET',
                target_direction: 'DEBIT',
                wallet_id: walletId,
                amount: '10.00',
              });
            }),
          ),
        ),
      ).toBe('23503:rev_fk');
    });
  });
});
