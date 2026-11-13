import { z } from 'zod';
import type { DatabaseTransaction } from '../../../shared/ports.ts';
import { toTransactionSql } from '../../../platform/persistence/unit-of-work.ts';
import type {
  DecisionSnapshot,
  PendingEntry,
  ReversalRecord,
  TimedTransaction,
  TransactionRow,
  TransactionStore,
} from '../application/ports.ts';
import { EMPTY_REVERSAL_VIEW, type ReversalView } from '../domain/settlement-policy.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import {
  EXACT_INSTANT_COLUMNS,
  exactInstantSql,
  parseTimedTransaction,
  parseTransactionRow,
  TRANSACTION_COLUMNS,
} from './transaction-row.ts';

export type { DecisionSnapshot } from '../application/ports.ts';

const reversalRowSchema = z.object({ kind: z.enum(['REFUND', 'ROLLBACK']), undone: z.boolean() });
const settlementRowSchema = z.object({ settled: z.boolean() });
const nowRowSchema = z.object({
  now: z
    .string()
    .regex(/^\d{1,19}$/)
    .transform((value) => BigInt(value)),
});

/** Microssegundos exatos (texto) → `timestamptz`, sem passar por ponto flutuante de segundos. */
const INSTANT_FROM_MICROS = `(timestamptz 'epoch' + ?::bigint * interval '1 microsecond')`;
const attemptsSchema = z.union([z.string().regex(/^\d{1,9}$/), z.number().int().min(0)]).transform(Number);

const INSERT_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, currency, amount, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, initial_status, accepted_balance, accepted_wallet_version, accepted_at, result_balance,
  result_wallet_version, decided_at, available_at, pending_deadline_at, correlation_id, created_at`;

function businessParameters(transaction: WagerTransaction): unknown[] {
  return [
    transaction.id,
    transaction.providerId,
    transaction.externalTransactionId,
    transaction.idempotencyKey,
    transaction.payloadHash,
    transaction.walletId,
    transaction.playerId,
    transaction.roundId,
    transaction.gameId,
    transaction.kind,
    transaction.money.currency,
    transaction.money.toString(),
    transaction.referenceExternalTransactionId ?? null,
    transaction.referenceTransactionId ?? null,
    transaction.status,
    transaction.failureCode ?? null,
  ];
}

/**
 * Persistência de WagerTransaction (D16, D26, D40). `accepted_at`, `decided_at` e
 * `available_at` usam o relógio do PostgreSQL: na decisão na chegada, `statement_timestamp()` é
 * o mesmo nas três colunas (o CHECK exige igualdade) e é lido depois do lock da wallet. Na
 * resolução de uma pendência, `decided_at` é `clock_timestamp()` e `available_at` vem da regra
 * de prazo (o instante em que a decisão ficou possível, D40).
 */
/** Pendência com instantes exatos e tentativas da agenda (worker, D40). */
const PENDING_ENTRY_SELECT = `
  SELECT ${TRANSACTION_COLUMNS}, ${EXACT_INSTANT_COLUMNS},
         COALESCE((SELECT c.attempts FROM pending_reference_checks c
                    WHERE c.transaction_id = wager_transactions.id), 0) AS "attempts"
    FROM wager_transactions`;

function toPendingEntry(raw: Record<string, unknown>): PendingEntry {
  return { ...parseTimedTransaction(raw), attempts: attemptsSchema.parse(raw['attempts']) };
}

export class SqlTransactionRepository implements TransactionStore {
  /** PROCESSED ou REJECTED decidida na chegada: resposta original = resultado (accepted = result). */
  async insertDecided(
    databaseTransaction: DatabaseTransaction,
    wagerTransaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    correlationId: string,
  ): Promise<void> {
    if (wagerTransaction.status !== 'PROCESSED' && wagerTransaction.status !== 'REJECTED') {
      throw new Error(`insertDecided exige PROCESSED ou REJECTED (recebeu ${wagerTransaction.status})`);
    }
    await toTransactionSql(databaseTransaction).run(
      `INSERT INTO wager_transactions (${INSERT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?,
               ?, ?::numeric, ?, statement_timestamp(), ?::numeric, ?, statement_timestamp(), statement_timestamp(),
               NULL, ?, ?)`,
      [
        ...businessParameters(wagerTransaction),
        wagerTransaction.status,
        snapshot.balance.toString(),
        snapshot.walletVersion,
        snapshot.balance.toString(),
        snapshot.walletVersion,
        correlationId,
        wagerTransaction.createdAt,
      ],
    );
  }

  /** PENDING_REFERENCE: só a resposta original (aceite), o prazo e a linha na agenda. */
  async insertPending(
    databaseTransaction: DatabaseTransaction,
    wagerTransaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    correlationId: string,
    ttlMs: number,
  ): Promise<void> {
    if (wagerTransaction.status !== 'PENDING_REFERENCE') {
      throw new Error(`insertPending exige PENDING_REFERENCE (recebeu ${wagerTransaction.status})`);
    }
    const sql = toTransactionSql(databaseTransaction);
    await sql.run(
      `INSERT INTO wager_transactions (${INSERT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?, ?, ?, ?,
               'PENDING_REFERENCE', ?::numeric, ?, statement_timestamp(), NULL, NULL, NULL, NULL,
               statement_timestamp() + make_interval(secs => ?::numeric / 1000), ?, ?)`,
      [
        ...businessParameters(wagerTransaction),
        snapshot.balance.toString(),
        snapshot.walletVersion,
        ttlMs,
        correlationId,
        wagerTransaction.createdAt,
      ],
    );
    await sql.run(
      `INSERT INTO pending_reference_checks (transaction_id, wallet_id, attempts, next_check_at, created_at)
       VALUES (?, ?, 0, statement_timestamp(), statement_timestamp())`,
      [wagerTransaction.id, wagerTransaction.walletId],
    );
  }

  async resolvePending(
    databaseTransaction: DatabaseTransaction,
    wagerTransaction: WagerTransaction,
    snapshot: DecisionSnapshot,
    availableAt: bigint,
  ): Promise<void> {
    if (!wagerTransaction.isTerminal()) throw new Error('resolvePending exige desfecho terminal');
    const sql = toTransactionSql(databaseTransaction);
    const affected = await sql.run(
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, reference_transaction_id = ?, result_balance = ?::numeric,
              result_wallet_version = ?, decided_at = clock_timestamp(), available_at = ${INSTANT_FROM_MICROS}
        WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [
        wagerTransaction.status,
        wagerTransaction.failureCode ?? null,
        wagerTransaction.referenceTransactionId ?? null,
        snapshot.balance.toString(),
        snapshot.walletVersion,
        availableAt.toString(),
        wagerTransaction.id,
      ],
    );
    if (affected !== 1) throw new Error(`pendência ${wagerTransaction.id} não estava mais PENDING_REFERENCE`);
    await sql.run('DELETE FROM pending_reference_checks WHERE transaction_id = ?', [wagerTransaction.id]);
  }

  async findByIdempotencyKey(
    databaseTransaction: DatabaseTransaction,
    idempotencyKey: string,
  ): Promise<TransactionRow | undefined> {
    const raw = await toTransactionSql(databaseTransaction).one<unknown>(
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`,
      [idempotencyKey],
    );
    return raw === undefined ? undefined : parseTransactionRow(raw);
  }

  async findByProviderAndExternalId(
    databaseTransaction: DatabaseTransaction,
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionRow | undefined> {
    const raw = await toTransactionSql(databaseTransaction).one<unknown>(
      `SELECT ${TRANSACTION_COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return raw === undefined ? undefined : parseTransactionRow(raw);
  }

  async findTimedByProviderAndExternalId(
    databaseTransaction: DatabaseTransaction,
    providerId: string,
    externalTransactionId: string,
  ): Promise<TimedTransaction | undefined> {
    const raw = await toTransactionSql(databaseTransaction).one<unknown>(
      `SELECT ${TRANSACTION_COLUMNS}, ${EXACT_INSTANT_COLUMNS}
         FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return raw === undefined ? undefined : parseTimedTransaction(raw);
  }

  async reversalView(
    databaseTransaction: DatabaseTransaction,
    targetTransactionId: string,
    includeWinSettlement: boolean,
  ): Promise<ReversalView> {
    const sql = toTransactionSql(databaseTransaction);
    const reversals = (
      await sql.all<unknown>(
        `SELECT reversal_kind AS kind, undone_by IS NOT NULL AS undone
           FROM wager_reversals WHERE target_id = ? ORDER BY created_at`,
        [targetTransactionId],
      )
    ).map((row) => reversalRowSchema.parse(row));
    let settledByWin = false;
    if (includeWinSettlement) {
      const settlement = settlementRowSchema.parse(
        await sql.one<unknown>(
          `SELECT EXISTS (
             SELECT 1 FROM wager_transactions w
              WHERE w.reference_transaction_id = ? AND w.kind = 'WIN' AND w.status = 'PROCESSED'
                AND NOT EXISTS (SELECT 1 FROM wager_reversals u WHERE u.target_id = w.id)
           ) AS settled`,
          [targetTransactionId],
        ),
      );
      settledByWin = settlement.settled;
    }
    if (reversals.length === 0 && !settledByWin) return EMPTY_REVERSAL_VIEW;
    return { reversals, settledByWin };
  }

  async recordReversal(databaseTransaction: DatabaseTransaction, reversal: ReversalRecord): Promise<void> {
    await toTransactionSql(databaseTransaction).run(
      `INSERT INTO wager_reversals (reversal_id, reversal_kind, direction, target_id, target_kind, target_direction,
                                    wallet_id, currency, amount, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?)`,
      [
        reversal.reversalId,
        reversal.reversalKind,
        reversal.direction,
        reversal.targetId,
        reversal.targetKind,
        reversal.targetDirection,
        reversal.walletId,
        reversal.money.currency,
        reversal.money.toString(),
        reversal.createdAt,
      ],
    );
  }

  async markReversalUndone(
    databaseTransaction: DatabaseTransaction,
    refundId: string,
    rollbackId: string,
  ): Promise<void> {
    const affected = await toTransactionSql(databaseTransaction).run(
      `UPDATE wager_reversals SET undone_by = ? WHERE reversal_id = ? AND reversal_kind = 'REFUND' AND undone_by IS NULL`,
      [rollbackId, refundId],
    );
    if (affected !== 1) throw new Error(`REFUND ${refundId} não estava em vigor para ser desfeito`);
  }

  async nudgeDependents(
    databaseTransaction: DatabaseTransaction,
    walletId: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<void> {
    await toTransactionSql(databaseTransaction).run(
      `UPDATE pending_reference_checks c SET next_check_at = statement_timestamp()
         FROM wager_transactions p
        WHERE c.transaction_id = p.id AND p.status = 'PENDING_REFERENCE' AND p.wallet_id = ?
          AND p.provider_id = ? AND p.reference_external_transaction_id = ? AND c.next_check_at > statement_timestamp()`,
      [walletId, providerId, externalTransactionId],
    );
  }

  async findPendingEntry(
    databaseTransaction: DatabaseTransaction,
    transactionId: string,
  ): Promise<PendingEntry | undefined> {
    const raw = await toTransactionSql(databaseTransaction).one<Record<string, unknown>>(
      `${PENDING_ENTRY_SELECT} WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [transactionId],
    );
    return raw === undefined ? undefined : toPendingEntry(raw);
  }

  async pendingOfWallet(
    databaseTransaction: DatabaseTransaction,
    walletId: string,
    limit: number,
  ): Promise<PendingEntry[]> {
    const rows = await toTransactionSql(databaseTransaction).all<Record<string, unknown>>(
      `${PENDING_ENTRY_SELECT} WHERE wallet_id = ? AND status = 'PENDING_REFERENCE' ORDER BY accept_seq LIMIT ?`,
      [walletId, limit],
    );
    return rows.map(toPendingEntry);
  }

  async reschedule(
    databaseTransaction: DatabaseTransaction,
    transactionId: string,
    nextCheckAt: bigint,
  ): Promise<void> {
    await toTransactionSql(databaseTransaction).run(
      `UPDATE pending_reference_checks
          SET attempts = attempts + 1, next_check_at = ${INSTANT_FROM_MICROS}, claim_token = NULL,
              claimed_until = NULL, last_error = NULL
        WHERE transaction_id = ?`,
      [nextCheckAt.toString(), transactionId],
    );
  }

  async databaseNow(databaseTransaction: DatabaseTransaction): Promise<bigint> {
    return nowRowSchema.parse(
      await toTransactionSql(databaseTransaction).one<unknown>(`SELECT ${exactInstantSql('clock_timestamp()')} AS now`),
    ).now;
  }
}
