import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyRejection } from '../../src/shared/money.ts';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function rejection(amount: unknown, currency: unknown = 'BRL'): MoneyRejection | 'accepted' {
  try {
    Money.from({ amount, currency });
    return 'accepted';
  } catch (error) {
    if (error instanceof InvalidMoneyError) return error.reason;
    throw error;
  }
}

describe('[UT-01] Money: contrato de entrada, faixa e ausência de arredondamento', () => {
  test('[UT-01] aceita apenas decimal com escala 2 e até MAX', () => {
    for (const ok of ['0.00', '0.01', '25.00', '100.10', '999999999999999.99']) expect(rejection(ok)).toBe('accepted');
  });

  test('[UT-01] rejeita entradas inválidas com o motivo esperado', () => {
    const cases: [unknown, MoneyRejection][] = [
      ['25', 'SCALE'],
      ['25.0', 'SCALE'],
      ['25.001', 'SCALE'],
      ['25.005', 'SCALE'],
      ['025.00', 'FORMAT'],
      ['+25.00', 'FORMAT'],
      ['1e3', 'FORMAT'],
      [' 25.00', 'FORMAT'],
      ['25.00 ', 'FORMAT'],
      ['.50', 'FORMAT'],
      ['25.', 'FORMAT'],
      ['25,00', 'FORMAT'],
      ['NaN', 'FORMAT'],
      ['Infinity', 'FORMAT'],
      ['', 'FORMAT'],
      ['２５.００', 'FORMAT'],
      ['-25.00', 'NEGATIVE'],
      ['-0.00', 'NEGATIVE'],
      [25, 'TYPE'],
      [25.5, 'TYPE'],
      [null, 'TYPE'],
      ['1000000000000000.00', 'OUT_OF_RANGE'],
    ];
    for (const [input, reason] of cases) expect({ input, reason: rejection(input) }).toEqual({ input, reason });
  });

  test('[UT-01] moeda: formato ISO e whitelist da aplicação', () => {
    expect(rejection('1.00', 'brl')).toBe('INVALID_CURRENCY');
    expect(rejection('1.00', 'BRLX')).toBe('INVALID_CURRENCY');
    expect(rejection('1.00', 'EUR')).toBe('UNSUPPORTED_CURRENCY');
    expect(rejection('1.00', 'USD')).toBe('accepted');
  });

  test('[UT-01] aritmética exata, sem arredondamento, inclusive acima de 2^53 centavos', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('999999999999999.99').subtract(brl('0.01')).toString()).toBe('999999999999999.98');
    expect(brl('90071992547409.92').add(brl('0.01')).toString()).toBe('90071992547409.93');
    expect(brl('999999999999999.99').add(brl('0.01')).exceedsMax()).toBe(true);
    expect(brl('999999999999999.99').exceedsMax()).toBe(false);
  });
});

describe('[UT-02] Money: operações, imutabilidade, moeda e serialização', () => {
  test('[UT-02] operações devolvem novas instâncias e não alteram as originais', () => {
    const a = brl('10.00');
    const b = brl('2.50');
    const sum = a.add(b);
    expect(sum.toString()).toBe('12.50');
    expect(a.toString()).toBe('10.00');
    expect(a.subtract(b).toString()).toBe('7.50');
    expect(b.subtract(a).toString()).toBe('-7.50');
    expect(a.negate().toString()).toBe('-10.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(sum).not.toBe(a);
  });

  test('[UT-02] comparações e predicados', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').negate().isNegative()).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isGreaterThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });

  test('[UT-02] moedas diferentes lançam CurrencyMismatchError', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test('[UT-02] serialização como string decimal e bloqueio de conversão implícita', () => {
    expect(JSON.stringify(brl('25.00'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(brl('0.05').toJSON()).toEqual({ amount: '0.05', currency: 'BRL' });
    expect(String(brl('7.00'))).toBe('7.00');
    expect(() => Number(brl('1.00'))).toThrow(TypeError);
  });

  test('[UT-02] reidratação interna aceita sinal e exige escala 2', () => {
    expect(Money.parseStored('-10.50', 'BRL').toString()).toBe('-10.50');
    expect(Money.parseStored('0.00', 'BRL').isZero()).toBe(true);
    expect(() => Money.parseStored('10.5', 'BRL')).toThrow(InvalidMoneyError);
    expect(Money.fromMinor(-1n, 'BRL').toString()).toBe('-0.01');
  });
});
