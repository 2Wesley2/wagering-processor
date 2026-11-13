import { z } from 'zod';
import type { ErrorCode } from './error-catalog.ts';
import { classifyAmount, classifyCurrency, isContractAmount, isSupportedCurrency } from './money.ts';

/**
 * Peças comuns dos contratos zod (HTTP e SQS). Os problemas carregam o código
 * do catálogo como prefixo da mensagem; o mais específico vence.
 */
const contractAmountSchema = z.custom<string>(isContractAmount, {
  error: (issue) => `INVALID_AMOUNT:${classifyAmount(issue.input) ?? 'FORMAT'}`,
});

const contractCurrencySchema = z.custom<string>(isSupportedCurrency, {
  error: (issue) => `UNSUPPORTED_CURRENCY:${classifyCurrency(issue.input) ?? 'INVALID_CURRENCY'}`,
});

/** `{ amount, currency }` validados e já tipados como string (sem afirmação de tipo). */
export const moneyContractSchema = z
  .object({ amount: contractAmountSchema, currency: contractCurrencySchema })
  .strict();

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly issues: readonly string[] };

const SPECIFIC_CODES = ['KIND_NOT_ALLOWED', 'INVALID_AMOUNT', 'UNSUPPORTED_CURRENCY'] as const;

export function issueCode(issues: readonly z.core.$ZodIssue[]): ErrorCode {
  const tagged = issues.map((i) => i.message.split(':')[0]);
  for (const code of SPECIFIC_CODES) {
    if (tagged.includes(code)) return code;
  }
  return 'VALIDATION_ERROR';
}

export function describeIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  return issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`);
}
