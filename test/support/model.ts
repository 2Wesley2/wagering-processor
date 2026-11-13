/**
 * Modelo de referência ingênuo (D58) para testes de propriedade. NÃO importa
 * nada de src/: reimplementa só o essencial, de forma sequencial e óbvia, para
 * que um erro da produção não seja repetido pelo oráculo (verificado em QG-08).
 */
export const MODEL_MAX_CENTS = 99_999_999_999_999_999n;

export function centsOf(text: string): bigint {
  const match = /^(-?)(\d+)\.(\d\d)$/.exec(text);
  if (match === null) throw new Error(`modelo: valor fora do formato: ${text}`);
  const cents = BigInt(match[2] ?? '0') * 100n + BigInt(match[3] ?? '0');
  return match[1] === '-' ? -cents : cents;
}

export function textOf(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const rest = abs % 100n;
  return `${negative ? '-' : ''}${whole}.${rest < 10n ? '0' : ''}${rest}`;
}

export interface ModelEntry {
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly cents: bigint;
  readonly before: bigint;
  readonly after: bigint;
  readonly version: number;
}

export class ModelWallet {
  balance: bigint;
  version = 1;
  readonly entries: ModelEntry[] = [];

  constructor(initialCents: bigint) {
    this.balance = initialCents;
    if (initialCents > 0n)
      this.entries.push({ direction: 'CREDIT', cents: initialCents, before: 0n, after: initialCents, version: 1 });
  }

  /** true se aplicou; false se rejeitou (saldo insuficiente ou acima do máximo). */
  apply(direction: 'DEBIT' | 'CREDIT', cents: bigint): boolean {
    const after = direction === 'DEBIT' ? this.balance - cents : this.balance + cents;
    if (after < 0n || after > MODEL_MAX_CENTS) return false;
    this.version += 1;
    this.entries.push({ direction, cents, before: this.balance, after, version: this.version });
    this.balance = after;
    return true;
  }

  ledgerSum(): bigint {
    let sum = 0n;
    for (const entry of this.entries) sum += entry.direction === 'CREDIT' ? entry.cents : -entry.cents;
    return sum;
  }
}
