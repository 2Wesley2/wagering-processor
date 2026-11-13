import { z } from 'zod';
import { type ContractResult, describeIssues, issueCode, moneyContractSchema } from '../../../shared/zod-contract.ts';

/** Corpo do POST /wallets (§9). Strict: campos desconhecidos são rejeitados. */
const openWalletSchema = z
  .object({
    playerId: z.uuid(),
    initialBalance: moneyContractSchema,
  })
  .strict();

export interface OpenWalletBody {
  readonly playerId: string;
  readonly initialBalance: { readonly amount: string; readonly currency: string };
}

export function parseOpenWallet(body: unknown): ContractResult<OpenWalletBody> {
  const parsed = openWalletSchema.safeParse(body);
  if (!parsed.success)
    return { ok: false, code: issueCode(parsed.error.issues), issues: describeIssues(parsed.error.issues) };
  const { amount, currency } = parsed.data.initialBalance;
  return { ok: true, value: { playerId: parsed.data.playerId.toLowerCase(), initialBalance: { amount, currency } } };
}

export const WALLET_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
