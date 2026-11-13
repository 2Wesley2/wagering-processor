import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { M0001_FINANCIAL_SCHEMA } from '../../src/platform/persistence/migrations/0001-financial-schema.ts';
import { runMigrations } from '../../src/platform/persistence/migrator.ts';
import { ensureDatabase } from '../../src/platform/persistence/pg-admin.ts';
import { appUrl, dropTestDatabase, ownerUrl, withAdmin } from '../support/db.ts';
import { field } from '../support/http.ts';
import { type Instance, startInstance, stopAllInstances, waitReady } from '../support/instances.ts';
import { storedTransaction, waitResolved } from '../support/pending.ts';
import { testDbName } from '../support/run-context.ts';
import { HASH, inTx, movementInOpenTx, movementSql, openWalletSql, withClient } from '../support/sql-fixtures.ts';
import { createTestFifoQueue, deleteTestQueue, testSqsClient, type TestQueue } from '../support/sqs.ts';
import { instanceEnv } from '../support/test-env.ts';
import { send, submission, type TestWallet, walletState } from '../support/wagering.ts';

/**
 * IT-02 (atualização): um banco com o schema e os dados da F3 recebe a migration 0002 sem perder
 * nada. Os dados da F3 incluem um REFUND já desfeito por ROLLBACK, um ROLLBACK de WIN e uma
 * PENDING_REFERENCE. A 0002 preenche `wager_reversals` (com `undone_by`), o prazo e a agenda; a
 * regra P1 = C passa a valer sobre esse histórico e o worker resolve a pendência antiga.
 */
const sqs: SQSClient = testSqsClient();
let database: string;
let queues: TestQueue[] = [];
let app: Instance;
const ids: Record<string, string> = {};
let wallet: TestWallet;

beforeAll(async () => {
  database = testDbName('upg');
  await withAdmin((admin) => ensureDatabase(admin, database));
  const dlq = await createTestFifoQueue(sqs, 'upg-dlq');
  const inbound = await createTestFifoQueue(sqs, 'upg-in', {
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }),
  });
  const events = await createTestFifoQueue(sqs, 'upg-ev');
  queues = [inbound, dlq, events];
});
afterAll(async () => {
  await stopAllInstances();
  for (const queue of queues) await deleteTestQueue(sqs, queue);
  await dropTestDatabase(database);
  sqs.destroy();
});

describe('[IT-02] atualização de um banco da F3 para a migration 0002', () => {
  test('[IT-02] dados da F3 (REFUND desfeito, ROLLBACK de WIN, pendência) → 0002 preenche reversões, prazo e agenda', async () => {
    expect((await runMigrations(ownerUrl(database), 'up', [M0001_FINANCIAL_SCHEMA])).executed).toEqual([
      'Migration0001FinancialSchema',
    ]);
    await withClient(appUrl(database), async (client) => {
      const opened = await openWalletSql(client, { balance: '100.00' });
      wallet = { walletId: opened.walletId, playerId: opened.playerId };
      const bet = await movementSql(client, opened.walletId, { kind: 'BET', amount: '10.00', externalId: 'u-bet' });
      ids['bet'] = bet.txId;
      const refund = await inTx(client, () =>
        movementInOpenTx(client, opened.walletId, {
          kind: 'WIN',
          kindOverride: 'REFUND',
          amount: '10.00',
          direction: 'CREDIT',
          externalId: 'u-refund',
          referenceTxId: bet.txId,
          referenceExternalId: 'u-bet',
        }),
      );
      ids['refund'] = refund.txId;
      const undo = await inTx(client, () =>
        movementInOpenTx(client, opened.walletId, {
          kind: 'WIN',
          kindOverride: 'ROLLBACK',
          amount: '10.00',
          direction: 'DEBIT',
          externalId: 'u-undo',
          referenceTxId: refund.txId,
          referenceExternalId: 'u-refund',
        }),
      );
      ids['undo'] = undo.txId;
      const win = await movementSql(client, opened.walletId, { kind: 'WIN', amount: '20.00', externalId: 'u-win' });
      const winRollback = await inTx(client, () =>
        movementInOpenTx(client, opened.walletId, {
          kind: 'WIN',
          kindOverride: 'ROLLBACK',
          amount: '20.00',
          direction: 'DEBIT',
          externalId: 'u-win-rollback',
          referenceTxId: win.txId,
          referenceExternalId: 'u-win',
        }),
      );
      ids['win'] = win.txId;
      ids['winRollback'] = winRollback.txId;
      ids['pending'] = Bun.randomUUIDv7();
      await client.query(
        `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, currency, amount, reference_external_transaction_id, status, initial_status,
           accepted_balance, accepted_wallet_version, accepted_at, correlation_id, created_at)
         SELECT $1::uuid, 'provider-a', 'u-pending', 'provider-a:u-pending', $2, w.id, w.player_id, 'round-1', 'game-1', 'REFUND',
                'BRL', 10.00, 'u-missing', 'PENDING_REFERENCE', 'PENDING_REFERENCE', w.balance, w.version, statement_timestamp(),
                'sql-fixture', now()
           FROM wallets w WHERE w.id = $3::uuid`,
        [ids['pending'], HASH, opened.walletId],
      );
    });

    const upgrade = await runMigrations(ownerUrl(database), 'up');
    expect(upgrade.executed).toEqual([
      'Migration0002ReversalsAndPendingReferences',
      'Migration0003InboxAndDeadLetter',
      'Migration0004RetentionAndProjection',
    ]);

    const reversals = await withClient(ownerUrl(database), async (client) => {
      const result = await client.query<Record<string, string | null>>(
        `SELECT reversal_id::text AS reversal, reversal_kind AS kind, direction, target_id::text AS target, target_kind,
                target_direction, amount::text AS amount, undone_by::text AS undone_by
           FROM wager_reversals ORDER BY created_at, reversal_kind`,
      );
      return result.rows;
    });
    expect(new Set(reversals.map((row) => JSON.stringify(row)))).toEqual(
      new Set(
        [
          {
            reversal: ids['refund'],
            kind: 'REFUND',
            direction: 'CREDIT',
            target: ids['bet'],
            target_kind: 'BET',
            target_direction: 'DEBIT',
            amount: '10.00',
            undone_by: ids['undo'],
          },
          {
            reversal: ids['undo'],
            kind: 'ROLLBACK',
            direction: 'DEBIT',
            target: ids['refund'],
            target_kind: 'REFUND',
            target_direction: 'CREDIT',
            amount: '10.00',
            undone_by: null,
          },
          {
            reversal: ids['winRollback'],
            kind: 'ROLLBACK',
            direction: 'DEBIT',
            target: ids['win'],
            target_kind: 'WIN',
            target_direction: 'CREDIT',
            amount: '20.00',
            undone_by: null,
          },
        ].map((row) => JSON.stringify(row)),
      ),
    );
    const pending = await withClient(ownerUrl(database), async (client) => {
      const result = await client.query<{ deadline_ok: boolean; attempts: number }>(
        `SELECT t.pending_deadline_at = t.accepted_at + interval '30 minutes' AS deadline_ok, c.attempts
           FROM wager_transactions t JOIN pending_reference_checks c ON c.transaction_id = t.id WHERE t.id = $1::uuid`,
        [ids['pending']],
      );
      return result.rows[0];
    });
    expect(pending).toEqual({ deadline_ok: true, attempts: 0 });
    // (Os dados da F3 deste teste foram gravados em SQL, sem eventos na outbox: por isso o verificador
    // global não é usado aqui; saldo, cadeia e reversões são conferidos diretamente.)
    expect((await runMigrations(ownerUrl(database), 'up')).executed).toEqual([]);
  });

  test('[IT-02] depois da atualização, P1 = C vale sobre o histórico e o worker resolve a pendência antiga', async () => {
    app = startInstance({
      id: 'upg-1',
      env: instanceEnv({
        databaseUrl: appUrl(database),
        inboundQueue: queues[0]?.name ?? '',
        dlq: queues[1]?.name ?? '',
        eventsQueue: queues[2]?.name ?? '',
        extra: { APP_ROLES: 'api,pending-reference-worker' },
      }),
    });
    await waitReady(app);
    // REFUND já usado (mesmo desfeito) → novo REFUND rejeitado; sem reversão em vigor → ROLLBACK aceito.
    const base = {
      ...submission(wallet, { amount: '10.00', referenceExternalTransactionId: 'u-bet' }),
      roundId: 'round-1',
      gameId: 'game-1',
    };
    const refundAgain = await send(app.baseUrl, { ...base, kind: 'REFUND', externalTransactionId: 'u-refund-2' });
    expect([refundAgain.status, field(refundAgain.body, 'code')]).toEqual([422, 'REVERSAL_KIND_ALREADY_USED']);
    const rollback = await send(app.baseUrl, { ...base, kind: 'ROLLBACK', externalTransactionId: 'u-rollback' });
    expect([rollback.status, field(rollback.body, 'balance')]).toEqual([200, { amount: '100.00', currency: 'BRL' }]);
    // A pendência antiga tem prazo de 30 min: o teste antecipa o prazo pelo banco (dono do schema).
    await withClient(ownerUrl(database), (client) =>
      client.query(
        `UPDATE wager_transactions SET pending_deadline_at = accepted_at + interval '1 millisecond' WHERE id = $1::uuid`,
        [ids['pending']],
      ),
    );
    await waitResolved(database, [ids['pending'] ?? '']);
    expect(await storedTransaction(database, ids['pending'] ?? '')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_NOT_FOUND',
      availableEqualsDeadline: true,
      inAgenda: false,
    });
    expect(await walletState(database, wallet.walletId)).toMatchObject({ balance: '100.00', version: '7' });
  });
});
