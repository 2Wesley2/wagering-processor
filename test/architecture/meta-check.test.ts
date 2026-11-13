import { describe, expect, test } from 'bun:test';
import {
  classify,
  type Counts,
  evaluateMeta,
  exitCodeFor,
  formatStrictMisses,
  resolveMode,
  type RunMode,
} from '../meta/evaluate.ts';
import { CATALOG, entriesUpTo, PHASES } from '../meta/required.ts';

/**
 * Regressões do meta-check (QG-08): escopo estrito por ID, BLOCKED acima de
 * contagens de aprovação e a distinção entre modo completo, --phase e etapas.
 * Os conjuntos esperados são escritos à mão (D58), não derivados do avaliador.
 */
const PASSED: Counts = { pass: 1, fail: 0, skip: 0 };
const FULL: RunMode = { kind: 'full' };
const PHASE_F2: RunMode = { kind: 'phase', phase: 'F2' };
const STAGES_ONLY: RunMode = { kind: 'stages' };

/** Resultados como se todo ID das fases até F2 tivesse um caso aprovado, exceto os omitidos. */
function passedUpToF2(omit: readonly string[] = []): Map<string, Counts> {
  return new Map(
    entriesUpTo('F2')
      .filter((entry) => !omit.includes(entry.id))
      .map((entry) => [entry.id, PASSED]),
  );
}

function missIds(results: Map<string, Counts>, mode: RunMode, blocked: ReadonlySet<string> = new Set()): string[] {
  return evaluateMeta(CATALOG, results, blocked, mode).strictMisses.map((item) => item.id);
}

describe('[QG-08] meta-check: escopo estrito por ID', () => {
  test('[QG-08] IDs do catálogo são únicos (o escopo é calculado por ID)', () => {
    const ids = CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('[QG-08] um ID obrigatório da F2 ausente reprova --phase F2', () => {
    const evaluation = evaluateMeta(CATALOG, passedUpToF2(['IT-16']), new Set(), PHASE_F2);
    expect(evaluation.strictMisses.map((item) => [item.id, item.status])).toEqual([['IT-16', 'NOT IMPLEMENTED']]);
    expect(exitCodeFor(false, evaluation.strictMisses)).toBe(1);
  });

  test('[QG-08] um ID obrigatório de fase anterior ausente também reprova --phase F2', () => {
    expect(missIds(passedUpToF2(['UT-05a', 'CONF-07']), PHASE_F2)).toEqual(['CONF-07', 'UT-05a']);
  });

  test('[QG-08] IDs de fases futuras ausentes não impedem --phase F2', () => {
    const evaluation = evaluateMeta(CATALOG, passedUpToF2(), new Set(), PHASE_F2);
    expect(evaluation.strictMisses).toEqual([]);
    expect(exitCodeFor(false, evaluation.strictMisses)).toBe(0);
    const statusOf = (id: string): string | undefined => evaluation.meta.find((item) => item.id === id)?.status;
    expect(statusOf('IT-10a')).toBe('NOT IMPLEMENTED');
    expect(statusOf('CT-08')).toBe('NOT IMPLEMENTED');
  });

  test('[QG-08] sem --phase, IDs obrigatórios NOT IMPLEMENTED reprovam e são listados', () => {
    const evaluation = evaluateMeta(CATALOG, passedUpToF2(), new Set(), FULL);
    const futureRequired = CATALOG.filter((entry) => entry.required && !['F0', 'F1', 'F2'].includes(entry.phase));
    expect(futureRequired.length).toBeGreaterThan(0);
    expect(evaluation.strictMisses.map((item) => item.id)).toEqual(futureRequired.map((entry) => entry.id));
    expect(evaluation.strictMisses.every((item) => item.status === 'NOT IMPLEMENTED')).toBe(true);
    expect(exitCodeFor(false, evaluation.strictMisses)).toBe(1);
    const listing = formatStrictMisses(evaluation.strictMisses);
    expect(listing).toContain('IT-10a=NOT IMPLEMENTED');
    expect(listing).toContain('UT-05b=NOT IMPLEMENTED');
    expect(listing).toContain('CT-08=NOT IMPLEMENTED');
  });

  test('[QG-08] sem --phase e com o catálogo inteiro aprovado, o meta-check passa', () => {
    const allPassed = new Map(CATALOG.map((entry) => [entry.id, PASSED]));
    expect(missIds(allPassed, FULL)).toEqual([]);
  });

  test('[QG-08] cada fase só exige os IDs obrigatórios até ela', () => {
    const allPassedExcept = (id: string): Map<string, Counts> =>
      new Map(CATALOG.filter((entry) => entry.id !== id).map((entry) => [entry.id, PASSED]));
    // IT-26 é da F4: reprova F4 em diante, não reprova F3.
    expect(missIds(allPassedExcept('IT-26'), { kind: 'phase', phase: 'F3' })).toEqual([]);
    expect(missIds(allPassedExcept('IT-26'), { kind: 'phase', phase: 'F4' })).toEqual(['IT-26']);
    expect(PHASES).toContain('F7');
    expect(missIds(allPassedExcept('IT-26'), { kind: 'phase', phase: 'F7' })).toEqual(['IT-26']);
  });
});

describe('[QG-08] meta-check: classificação', () => {
  test('[QG-08] BLOCKED prevalece sobre uma contagem de aprovação anterior', () => {
    expect(classify(PASSED, true)).toBe('BLOCKED');
    expect(classify({ pass: 3, fail: 0, skip: 1 }, true)).toBe('BLOCKED');
    expect(classify(undefined, true)).toBe('BLOCKED');
  });

  test('[QG-08] uma falha real continua FAIL mesmo com o ID bloqueado', () => {
    expect(classify({ pass: 2, fail: 1, skip: 0 }, true)).toBe('FAIL');
    expect(classify({ pass: 2, fail: 1, skip: 0 }, false)).toBe('FAIL');
  });

  test('[QG-08] demais classificações', () => {
    expect(classify(PASSED, false)).toBe('PASS');
    expect(classify({ pass: 1, fail: 0, skip: 1 }, false)).toBe('SKIPPED');
    expect(classify({ pass: 0, fail: 0, skip: 1 }, false)).toBe('SKIPPED');
    expect(classify(undefined, false)).toBe('NOT IMPLEMENTED');
  });

  test('[QG-08] um ID bloqueado com aprovação reprova --phase F2 como BLOCKED', () => {
    const evaluation = evaluateMeta(CATALOG, passedUpToF2(), new Set(['IT-32']), PHASE_F2);
    expect(evaluation.strictMisses.map((item) => [item.id, item.status])).toEqual([['IT-32', 'BLOCKED']]);
    expect(exitCodeFor(false, evaluation.strictMisses)).toBe(1);
  });

  test('[QG-08] o marcador ALL bloqueia todos os IDs, mas não esconde uma falha', () => {
    const results = passedUpToF2();
    results.set('IT-09', { pass: 1, fail: 1, skip: 0 });
    const evaluation = evaluateMeta(CATALOG, results, new Set(['ALL']), PHASE_F2);
    const statuses = new Set(evaluation.meta.map((item) => item.status));
    expect([...statuses].sort((left, right) => left.localeCompare(right))).toEqual(['BLOCKED', 'FAIL']);
    expect(evaluation.meta.find((item) => item.id === 'IT-09')?.status).toBe('FAIL');
  });
});

describe('[QG-08] meta-check: IDs informativos e execução parcial por etapa', () => {
  test('[QG-08] um ID informativo ausente não reprova nenhum modo estrito', () => {
    const informative = CATALOG.filter((entry) => !entry.required).map((entry) => entry.id);
    expect(informative).toEqual(['SPK-01']);
    const allButSpike = new Map(CATALOG.filter((entry) => entry.required).map((entry) => [entry.id, PASSED]));
    expect(missIds(allButSpike, FULL)).toEqual([]);
    expect(missIds(passedUpToF2(['SPK-01']), PHASE_F2)).toEqual([]);
    const spike = evaluateMeta(CATALOG, allButSpike, new Set(), FULL).meta.find((item) => item.id === 'SPK-01');
    expect(spike?.status).toBe('NOT IMPLEMENTED');
  });

  test('[QG-08] execução parcial por etapa: meta-check informativo, exit só pelas etapas', () => {
    const evaluation = evaluateMeta(CATALOG, new Map([['UT-01', PASSED]]), new Set(['IT-32']), STAGES_ONLY);
    expect(evaluation.strictMisses).toEqual([]);
    expect(evaluation.meta.find((item) => item.id === 'IT-32')?.status).toBe('BLOCKED');
    expect(exitCodeFor(false, evaluation.strictMisses)).toBe(0);
    expect(exitCodeFor(true, evaluation.strictMisses)).toBe(1);
  });

  test('[QG-08] resolução do modo a partir dos argumentos', () => {
    expect(resolveMode(undefined, false)).toEqual(FULL);
    expect(resolveMode('F2', false)).toEqual(PHASE_F2);
    expect(resolveMode(undefined, true)).toEqual(STAGES_ONLY);
    // `--phase F2 unit`: a seleção de etapas prevalece; não há como exigir IDs de etapas não executadas.
    expect(resolveMode('F2', true)).toEqual(STAGES_ONLY);
  });

  test('[QG-08] uma etapa com falha reprova mesmo sem IDs pendentes', () => {
    expect(exitCodeFor(true, [])).toBe(1);
    expect(exitCodeFor(false, [])).toBe(0);
  });
});
