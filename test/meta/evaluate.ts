/**
 * Avaliação pura do meta-check (QG-08), separada do test-all para ser testada sem
 * PostgreSQL nem MiniStack. O escopo estrito é calculado por ID: o meta-check
 * trabalha com cópias das entradas do catálogo, então comparar objetos não serve.
 */
import { type CatalogEntry, type Phase, phaseIndex } from './required.ts';

export type Status = 'PASS' | 'FAIL' | 'NOT IMPLEMENTED' | 'SKIPPED' | 'BLOCKED';

export interface Counts {
  pass: number;
  fail: number;
  skip: number;
}

/**
 * - `full`: todas as etapas, sem `--phase`; todo ID obrigatório do catálogo precisa de PASS.
 * - `phase`: todas as etapas com `--phase Fn`; só os obrigatórios até Fn precisam de PASS.
 * - `stages`: só as etapas citadas; o meta-check é informativo e o exit vem das etapas.
 */
export type RunMode =
  { readonly kind: 'full' } | { readonly kind: 'phase'; readonly phase: Phase } | { readonly kind: 'stages' };

export type MetaItem = CatalogEntry & { readonly status: Status };

export function resolveMode(phase: Phase | undefined, partialRun: boolean): RunMode {
  if (partialRun) return { kind: 'stages' };
  return phase === undefined ? { kind: 'full' } : { kind: 'phase', phase };
}

/**
 * Falha real prevalece; depois, um pré-requisito bloqueado prevalece sobre qualquer
 * contagem de aprovação (um teste que rodou apesar do bloqueio não prova o ID).
 */
export function classify(counts: Counts | undefined, blocked: boolean): Status {
  if (counts !== undefined && counts.fail > 0) return 'FAIL';
  if (blocked) return 'BLOCKED';
  if (counts !== undefined && counts.skip > 0) return 'SKIPPED';
  if (counts !== undefined && counts.pass > 0) return 'PASS';
  return 'NOT IMPLEMENTED';
}

export function isBlocked(id: string, blocked: ReadonlySet<string>): boolean {
  return blocked.has(id) || blocked.has('ALL');
}

/** IDs obrigatórios que precisam estar em PASS no modo; vazio na execução parcial por etapa. */
export function strictScope(catalog: readonly CatalogEntry[], mode: RunMode): Set<string> {
  if (mode.kind === 'stages') return new Set();
  const inScope = (entry: CatalogEntry): boolean =>
    mode.kind === 'full' || phaseIndex(entry.phase) <= phaseIndex(mode.phase);
  return new Set(catalog.filter((entry) => entry.required && inScope(entry)).map((entry) => entry.id));
}

export interface MetaEvaluation {
  readonly meta: readonly MetaItem[];
  readonly strictMisses: readonly MetaItem[];
}

export function evaluateMeta(
  catalog: readonly CatalogEntry[],
  results: ReadonlyMap<string, Counts>,
  blocked: ReadonlySet<string>,
  mode: RunMode,
): MetaEvaluation {
  const meta = catalog.map((entry) => ({
    ...entry,
    status: classify(results.get(entry.id), isBlocked(entry.id, blocked)),
  }));
  const scope = strictScope(catalog, mode);
  const strictMisses = meta.filter((item) => scope.has(item.id) && item.status !== 'PASS');
  return { meta, strictMisses };
}

export function exitCodeFor(anyStageFailed: boolean, strictMisses: readonly MetaItem[]): 0 | 1 {
  return anyStageFailed || strictMisses.length > 0 ? 1 : 0;
}

export function formatStrictMisses(strictMisses: readonly MetaItem[]): string {
  return strictMisses.map((item) => `${item.id}=${item.status}`).join(' ');
}
