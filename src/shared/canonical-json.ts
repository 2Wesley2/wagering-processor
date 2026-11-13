import { createHash } from 'node:crypto';

/**
 * JSON canônico (D28): chaves ordenadas recursivamente por code unit, sem
 * espaços, `null` e `undefined` em objetos tratados como ausentes. Compatível
 * com RFC 8785 para os tipos usados nos payloads (strings, objetos, arrays,
 * booleanos e inteiros seguros).
 */
/** Ordem por code unit (RFC 8785), independente de locale; por isso não usa localeCompare. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('JSON canônico aceita só inteiros seguros');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries: [string, unknown][] = Object.entries(value);
    const members = entries
      .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
      .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
      .map(([entryKey, entryValue]) => JSON.stringify(entryKey) + ':' + canonicalJson(entryValue));
    return '{' + members.join(',') + '}';
  }
  throw new TypeError(`tipo não suportado no JSON canônico: ${typeof value}`);
}

/** `v1:` + sha256 hex do JSON canônico em UTF-8. */
export function hashV1(value: unknown): string {
  return `v1:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export const HASH_V1_RE = /^v1:[0-9a-f]{64}$/;
