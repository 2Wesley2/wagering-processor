import { DomainError } from './errors.ts';

/**
 * Money (§6.1, D05): valor exato em unidades mínimas (bigint) com escala fixa 2.
 * Nunca usa number, float, arredondamento nem bibliotecas decimais com precisão
 * global. Imutável: toda operação devolve uma nova instância.
 */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

export const MONEY_SCALE = 2;
/** Maior valor aceito em contratos, saldos e no DOMAIN SQL `money_amount` (abs < 1e15). */
export const MAX_AMOUNT = '999999999999999.99';
export const MAX_MINOR_UNITS = 99_999_999_999_999_999n;
/** Moedas aceitas pela aplicação. USD existe para os testes de conflito de moeda. */
export const SUPPORTED_CURRENCIES: readonly string[] = ['BRL', 'USD'];

export type MoneyRejection =
  'TYPE' | 'FORMAT' | 'SCALE' | 'NEGATIVE' | 'OUT_OF_RANGE' | 'INVALID_CURRENCY' | 'UNSUPPORTED_CURRENCY';

export class InvalidMoneyError extends DomainError {
  constructor(readonly reason: MoneyRejection) {
    super(
      reason === 'UNSUPPORTED_CURRENCY' || reason === 'INVALID_CURRENCY' ? 'UNSUPPORTED_CURRENCY' : 'INVALID_AMOUNT',
      `valor monetário inválido: ${reason}`,
    );
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(left: string, right: string) {
    super('CURRENCY_MISMATCH', `moedas diferentes: ${left} e ${right}`);
  }
}

// Em JavaScript, `\d` sem a flag `u` só aceita os dígitos ASCII 0-9 (dígitos unicode continuam recusados).
const CONTRACT_RE = /^(0|[1-9]\d{0,14})\.\d{2}$/;
const SCALE2_ANY_RE = /^(0|[1-9]\d*)\.\d{2}$/;
const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
const NEGATIVE_RE = /^-(0|[1-9]\d*)(\.\d+)?$/;
const STORED_RE = /^-?(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Classifica uma entrada de contrato; undefined = válida. */
export function classifyAmount(raw: unknown): MoneyRejection | undefined {
  if (typeof raw !== 'string') return 'TYPE';
  if (CONTRACT_RE.test(raw)) return undefined;
  if (NEGATIVE_RE.test(raw)) return 'NEGATIVE';
  if (SCALE2_ANY_RE.test(raw)) return 'OUT_OF_RANGE';
  if (DECIMAL_RE.test(raw)) return 'SCALE';
  return 'FORMAT';
}

/** Type guard do contrato de valor: string decimal válida (escala 2, sem sinal, ≤ MAX). */
export function isContractAmount(raw: unknown): raw is string {
  return classifyAmount(raw) === undefined;
}

/** Type guard de moeda: código ISO de 3 letras na whitelist da aplicação. */
export function isSupportedCurrency(raw: unknown): raw is string {
  return classifyCurrency(raw) === undefined;
}

export function classifyCurrency(raw: unknown): MoneyRejection | undefined {
  if (typeof raw !== 'string' || !CURRENCY_RE.test(raw)) return 'INVALID_CURRENCY';
  if (!SUPPORTED_CURRENCIES.includes(raw)) return 'UNSUPPORTED_CURRENCY';
  return undefined;
}

function assertCurrency(currency: string): void {
  const rejection = classifyCurrency(currency);
  if (rejection !== undefined) throw new InvalidMoneyError(rejection);
}

function parseDecimal(text: string): bigint {
  const negative = text.startsWith('-');
  const [intPart = '0', fracPart = '00'] = (negative ? text.slice(1) : text).split('.');
  const minor = BigInt(intPart) * 100n + BigInt(fracPart);
  return negative ? -minor : minor;
}

export class Money {
  private constructor(
    private readonly minor: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Contrato de entrada: string decimal estrita, escala 2, não negativa, ≤ MAX. */
  static from(props: { amount: unknown; currency: unknown }): Money {
    const { amount, currency } = props;
    if (!isSupportedCurrency(currency)) throw new InvalidMoneyError(classifyCurrency(currency) ?? 'INVALID_CURRENCY');
    if (!isContractAmount(amount)) throw new InvalidMoneyError(classifyAmount(amount) ?? 'TYPE');
    return new Money(parseDecimal(amount), currency);
  }

  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money(0n, currency);
  }

  /** Uso interno (persistência, reconciliação): aceita sinal, sem limite de faixa. */
  static fromMinor(minor: bigint, currency: string): Money {
    assertCurrency(currency);
    return new Money(minor, currency);
  }

  /** Reidratação de numeric(·) lido como string do banco, com escala 2 exata. */
  static parseStored(text: string, currency: string): Money {
    assertCurrency(currency);
    if (!STORED_RE.test(text)) throw new InvalidMoneyError(text.includes('.') ? 'SCALE' : 'FORMAT');
    return new Money(parseDecimal(text), currency);
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  /** Acima do limite único MAX_AMOUNT (em módulo). */
  exceedsMax(): boolean {
    return this.minor > MAX_MINOR_UNITS || -this.minor > MAX_MINOR_UNITS;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const cents = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${(abs / 100n).toString()}.${cents}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Impede aritmética implícita (`a + b`, `a > b`) que converteria para number. */
  valueOf(): never {
    throw new TypeError('Money não converte para primitivo; use os métodos de Money');
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
