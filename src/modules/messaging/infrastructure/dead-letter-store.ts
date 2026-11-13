import { z } from 'zod';
import type { AutocommitSql } from '../../../platform/persistence/unit-of-work.ts';
import type { DeadLetterKey } from './message-identity.ts';

export type DeadLetterState = 'PENDING_DLQ' | 'IN_DLQ' | 'REDRIVE_PENDING' | 'REDRIVEN';

const rowSchema = z.object({
  state: z.enum(['PENDING_DLQ', 'IN_DLQ', 'REDRIVE_PENDING', 'REDRIVEN']),
  attempt: z.coerce.number().int().min(1),
  redriveCount: z.coerce.number().int().min(0),
  redrivenAttempt: z.coerce.number().int().min(1).nullable(),
  reason: z.string(),
  pendingForMs: z.coerce.number().min(0),
});
export type DeadLetterRow = z.infer<typeof rowSchema>;

const ROW_COLUMNS = `state, attempt, redrive_count AS "redriveCount", redriven_attempt AS "redrivenAttempt", reason,
  (extract(epoch FROM clock_timestamp() - last_failed_at) * 1000)::bigint::text AS "pendingForMs"`;
const KEY_WHERE = 'consumer_name = ? AND dl_key = ? AND body_hash = ?';
const keyParameters = (key: DeadLetterKey) => [key.consumerName, key.dlKey, key.bodyHash];

/** O que fazer com uma cópia lida da DLQ (D36). */
export type RedriveDecision =
  | { readonly type: 'SEND'; readonly attempt: number; readonly redriveCount: number }
  | { readonly type: 'OBSOLETE' }
  | { readonly type: 'SKIP'; readonly state: DeadLetterState };

/**
 * Registro de dead-letter (D35, D36), em autocommit: cada passo do protocolo é commitado antes do
 * envio à DLQ, do ack ou do redrive. Cada transição é condicional (estado e tentativa esperados)
 * e o trigger `dead_letter_guard` recusa qualquer transição fora da máquina de estados.
 */
export class DeadLetterStore {
  constructor(private readonly sql: AutocommitSql) {}

  async lookup(key: DeadLetterKey): Promise<DeadLetterRow | undefined> {
    const rows = await this.sql.all<unknown>(
      `SELECT ${ROW_COLUMNS} FROM dead_letter_messages WHERE ${KEY_WHERE}`,
      keyParameters(key),
    );
    return rows[0] === undefined ? undefined : rowSchema.parse(rows[0]);
  }

  /**
   * Passo 2 do protocolo: commita a decisão de descartar. Sem linha → PENDING_DLQ (attempt 1).
   * REDRIVEN ou REDRIVE_PENDING → nova falha depois de um redrive (attempt + 1). PENDING_DLQ ou
   * IN_DLQ → reentrega do mesmo descarte: nada muda e o protocolo é retomado.
   */
  async open(key: DeadLetterKey, reason: string, sqsMessageId: string): Promise<DeadLetterRow> {
    const rows = await this.sql.all<unknown>(
      `INSERT INTO dead_letter_messages AS d (consumer_name, dl_key, body_hash, reason, sqs_message_id, state, attempt,
                                               redrive_count, first_seen_at, last_failed_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING_DLQ', 1, 0, clock_timestamp(), clock_timestamp())
       ON CONFLICT (consumer_name, dl_key, body_hash) DO UPDATE
          SET state = 'PENDING_DLQ', attempt = d.attempt + 1, reason = EXCLUDED.reason,
              sqs_message_id = EXCLUDED.sqs_message_id, last_failed_at = clock_timestamp(), dlq_sent_at = NULL
        WHERE d.state IN ('REDRIVEN', 'REDRIVE_PENDING')
       RETURNING ${ROW_COLUMNS.replaceAll('last_failed_at', 'd.last_failed_at')}`,
      [...keyParameters(key), reason, sqsMessageId],
    );
    if (rows[0] !== undefined) return rowSchema.parse(rows[0]);
    const current = await this.lookup(key);
    if (current === undefined) throw new Error('registro de dead-letter sumiu entre o upsert e a leitura');
    return current;
  }

  /** Passo 4: a cópia está na DLQ. */
  async markInDlq(key: DeadLetterKey, attempt: number): Promise<void> {
    await this.sql.run(
      `UPDATE dead_letter_messages SET state = 'IN_DLQ', dlq_sent_at = clock_timestamp()
        WHERE ${KEY_WHERE} AND state = 'PENDING_DLQ' AND attempt = ?`,
      [...keyParameters(key), attempt],
    );
  }

  /**
   * Passo 1 do redrive. `dlAttempt` vem da cópia (ausente = cópia movida pelo broker pela
   * RedrivePolicy, que é SEMPRE redrivada). Cópia obsoleta (tentativa antiga ou já redrivada) só
   * é apagada; uma cópia de um descarte que o consumidor ainda está concluindo (PENDING_DLQ com a
   * mesma tentativa) fica para depois.
   */
  async beginRedrive(
    key: DeadLetterKey,
    dlAttempt: number | undefined,
    sqsMessageId: string,
  ): Promise<RedriveDecision> {
    for (let round = 0; round < 3; round++) {
      const row = await this.lookup(key);
      if (row === undefined) {
        const inserted = await this.sql.run(
          `INSERT INTO dead_letter_messages (consumer_name, dl_key, body_hash, reason, sqs_message_id, state, attempt,
                                             redrive_count, first_seen_at, last_failed_at)
           VALUES (?, ?, ?, 'BROKER_MAX_RECEIVE', ?, 'REDRIVE_PENDING', 1, 1, clock_timestamp(), clock_timestamp())
           ON CONFLICT (consumer_name, dl_key, body_hash) DO NOTHING`,
          [...keyParameters(key), sqsMessageId],
        );
        if (inserted === 1) return { type: 'SEND', attempt: 1, redriveCount: 1 };
        continue;
      }
      const decision = decide(row, dlAttempt);
      if (decision.type !== 'TRANSITION') return decision;
      const moved = await this.sql.run(
        `UPDATE dead_letter_messages SET state = 'REDRIVE_PENDING', redrive_count = redrive_count + 1
          WHERE ${KEY_WHERE} AND state = ? AND attempt = ? AND redrive_count = ?`,
        [...keyParameters(key), row.state, row.attempt, row.redriveCount],
      );
      if (moved === 1) return { type: 'SEND', attempt: row.attempt, redriveCount: row.redriveCount + 1 };
    }
    throw new Error('registro de dead-letter mudou repetidamente durante o redrive');
  }

  /** A decisão que `beginRedrive` tomaria agora, sem efeito colateral. */
  async peekRedrive(
    key: DeadLetterKey,
    dlAttempt: number | undefined,
  ): Promise<RedriveDecision | 'TRANSITION' | 'NEW'> {
    const row = await this.lookup(key);
    if (row === undefined) return 'NEW';
    const step = decide(row, dlAttempt);
    return step.type === 'TRANSITION' ? 'TRANSITION' : step;
  }

  /** Passo 3 do redrive. */
  async markRedriven(key: DeadLetterKey, attempt: number): Promise<void> {
    await this.sql.run(
      `UPDATE dead_letter_messages SET state = 'REDRIVEN', redriven_attempt = attempt, redriven_at = clock_timestamp()
        WHERE ${KEY_WHERE} AND state = 'REDRIVE_PENDING' AND attempt = ?`,
      [...keyParameters(key), attempt],
    );
  }
}

type Step = RedriveDecision | { readonly type: 'TRANSITION' };

function decide(row: DeadLetterRow, dlAttempt: number | undefined): Step {
  if (dlAttempt === undefined) {
    // Cópia movida pelo broker: sempre redrivada (nunca obsoleta).
    return row.state === 'REDRIVE_PENDING'
      ? { type: 'SEND', attempt: row.attempt, redriveCount: row.redriveCount }
      : { type: 'TRANSITION' };
  }
  if (row.attempt > dlAttempt) return { type: 'OBSOLETE' };
  if (row.state === 'REDRIVEN' && row.redrivenAttempt === dlAttempt) return { type: 'OBSOLETE' };
  if (row.attempt < dlAttempt) return { type: 'SKIP', state: row.state };
  switch (row.state) {
    case 'REDRIVE_PENDING':
      return { type: 'SEND', attempt: row.attempt, redriveCount: row.redriveCount };
    case 'IN_DLQ':
      return { type: 'TRANSITION' };
    case 'PENDING_DLQ':
    case 'REDRIVEN':
      return { type: 'SKIP', state: row.state };
  }
}
