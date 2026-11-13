import { DomainError } from '../../../shared/errors.ts';

export class InvalidCursorError extends DomainError {
  constructor(reason: string) {
    super('INVALID_CURSOR', `cursor inválido: ${reason}`);
  }
}

interface CursorPayload {
  readonly v: 1;
  readonly w: string;
  readonly s: number;
}

/** Cursor opaco do ledger (D21): base64url de {v:1, w: walletId, s: última wallet_version}. */
export function encodeLedgerCursor(walletId: string, afterVersion: number): string {
  const payload: CursorPayload = { v: 1, w: walletId, s: afterVersion };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(raw: string, walletId: string): number {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(raw)) throw new InvalidCursorError('formato');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('conteúdo');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError('conteúdo');
  // Campos serializados do cursor (formato {v, w, s}, D21) lidos com narrowing, sem afirmação de tipo.
  const version = 'v' in parsed ? parsed.v : undefined;
  const cursorWalletId = 'w' in parsed ? parsed.w : undefined;
  const afterVersion = 's' in parsed ? parsed.s : undefined;
  if (version !== 1) throw new InvalidCursorError('versão');
  if (cursorWalletId !== walletId) throw new InvalidCursorError('cursor de outra wallet');
  if (typeof afterVersion !== 'number' || !Number.isSafeInteger(afterVersion) || afterVersion < 0) {
    throw new InvalidCursorError('posição');
  }
  return afterVersion;
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;

export function parseLedgerLimit(raw: string | undefined): number {
  if (raw === undefined) return LEDGER_PAGE_DEFAULT;
  if (!/^[1-9]\d{0,2}$/.test(raw)) throw new InvalidCursorError('limit');
  const limit = Number.parseInt(raw, 10);
  if (limit > LEDGER_PAGE_MAX) throw new InvalidCursorError('limit');
  return limit;
}
