import { ownerUrl } from './db.ts';
import { api, type ApiResponse, stringField } from './http.ts';
import { withClient } from './sql-fixtures.ts';
import { verifyInvariants } from './verifier.ts';

/** Corpo de submissão do §9 com valores padrão; cada chamada gera um externalTransactionId novo. */
export interface SubmissionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export interface TestWallet {
  readonly walletId: string;
  readonly playerId: string;
}

let sequence = 0;

/** externalTransactionId único por execução (o banco de teste é novo a cada arquivo). */
export function externalId(prefix = 'tx'): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Bun.randomUUIDv7().slice(-12)}`;
}

export function submission(
  wallet: TestWallet,
  overrides: Partial<SubmissionBody> & { amount?: string } = {},
): SubmissionBody {
  const { amount, ...rest } = overrides;
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId(),
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: amount ?? '10.00', currency: 'BRL' },
    ...rest,
  };
}

/** Chave recomendada pelo §9; pode ser substituída. */
export function keyOf(body: SubmissionBody): string {
  return `${body.providerId}:${body.externalTransactionId}`;
}

export async function submit(
  base: string,
  body: unknown,
  idempotencyKey: string | undefined,
  headers: Record<string, string> = {},
): Promise<ApiResponse> {
  return api(base, 'POST', '/wagering/transactions', {
    json: body,
    headers: idempotencyKey === undefined ? headers : { ...headers, 'idempotency-key': idempotencyKey },
  });
}

/** Submete com a chave recomendada. */
export async function send(base: string, body: SubmissionBody): Promise<ApiResponse> {
  return submit(base, body, keyOf(body));
}

export async function openWallet(base: string, amount: string, currency = 'BRL'): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await api(base, 'POST', '/wallets', {
    json: { playerId, initialBalance: { amount, currency } },
  });
  if (response.status !== 201) throw new Error(`POST /wallets falhou: ${response.status} ${response.text}`);
  return { walletId: stringField(response.body, 'id'), playerId };
}

/** Corpo sem o campo idempotentReplay (para comparar a resposta original com o replay). */
export function withoutReplayFlag(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  return Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'idempotentReplay'));
}

/** Verificador global (D53) sobre o banco de teste: lista vazia = invariantes válidas. */
export async function invariantIssues(database: string): Promise<string[]> {
  return withClient(ownerUrl(database), (client) =>
    verifyInvariants(async (sql) => (await client.query<Record<string, unknown>>(sql)).rows),
  );
}

export interface WalletState {
  readonly balance: string;
  readonly version: string;
  readonly entries: string;
  readonly debits: string;
  readonly transactions: string;
  readonly outbox: string;
}

/** Estado gravado de uma wallet, lido em SQL (valores em texto, sem aritmética em JavaScript). */
export async function walletState(database: string, walletId: string): Promise<WalletState> {
  return withClient(ownerUrl(database), async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT w.balance::text AS balance, w.version::text AS version,
              (SELECT count(*) FROM wallet_ledger_entries e WHERE e.wallet_id = w.id)::text AS entries,
              (SELECT count(*) FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND e.direction = 'DEBIT')::text AS debits,
              (SELECT count(*) FROM wager_transactions t WHERE t.wallet_id = w.id AND t.kind <> 'OPENING')::text AS transactions,
              (SELECT count(*) FROM outbox_messages o WHERE o.aggregate_id = w.id)::text AS outbox
         FROM wallets w WHERE w.id = $1::uuid`,
      [walletId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error(`wallet ${walletId} não existe`);
    return {
      balance: row['balance'] ?? '',
      version: row['version'] ?? '',
      entries: row['entries'] ?? '',
      debits: row['debits'] ?? '',
      transactions: row['transactions'] ?? '',
      outbox: row['outbox'] ?? '',
    };
  });
}
