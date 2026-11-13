/**
 * Catálogo de testes obrigatórios (plano, seções 15 e 19). O meta-check (QG-08)
 * cruza este catálogo com os resultados reais: ID sem teste = NOT IMPLEMENTED,
 * nunca aprovado. IDs com sufixo separam partes que entram em fases diferentes.
 */
export const PHASES = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'] as const;
export type Phase = (typeof PHASES)[number];

export const STAGES = ['static', 'conformance', 'unit', 'integration', 'concurrency', 'resilience'] as const;
export type Stage = (typeof STAGES)[number];

export interface CatalogEntry {
  readonly id: string;
  readonly phase: Phase;
  readonly stage: Stage;
  readonly title: string;
  /** false = informativo (spike); não entra na conta do meta-check estrito. */
  readonly required: boolean;
  /** Decisão do usuário da qual o oráculo depende (gates I2/I1/P1/P2). */
  readonly decision?: 'I1' | 'I2' | 'P1' | 'P2';
}

const catalogEntry = (
  id: string,
  phase: Phase,
  stage: Stage,
  title: string,
  extra: Partial<Pick<CatalogEntry, 'required' | 'decision'>> = {},
): CatalogEntry => ({
  id,
  phase,
  stage,
  title,
  required: extra.required ?? true,
  ...(extra.decision ? { decision: extra.decision } : {}),
});

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`);

export const CATALOG: readonly CatalogEntry[] = [
  // ---- F0
  catalogEntry('QG-01', 'F0', 'static', 'tsc --noEmit em modo strict'),
  catalogEntry('QG-03', 'F0', 'static', 'Fitness de arquitetura (regra de dependência)'),
  catalogEntry('QG-05', 'F0', 'static', 'Smoke de DI do NestJS no Bun'),
  catalogEntry('QG-07', 'F0', 'static', 'src/ não importa devDependencies (boot-check + lint)'),
  ...range('CONF-', 0, 21).map((id) => catalogEntry(id, 'F0', 'conformance', 'Conformidade do MiniStack')),
  catalogEntry('IT-32', 'F0', 'integration', 'Guardas do harness, sinais e órfãos'),
  catalogEntry('IT-01a', 'F0', 'integration', 'Bootstrap: roles, dono do banco, filas e reexecução idempotente'),
  catalogEntry('SPK-01', 'F0', 'integration', 'Spike MikroORM 7 + ALS + pg no Bun', { required: false }),
  // ---- F1
  ...[
    'UT-01',
    'UT-02',
    'UT-03',
    'UT-04',
    'UT-05a',
    'UT-06',
    'UT-07',
    'UT-08',
    'UT-09',
    'UT-10',
    'UT-11',
    'UT-12',
    'UT-13',
  ].map((id) => catalogEntry(id, 'F1', 'unit', 'Domínio puro')),
  catalogEntry('QG-02', 'F1', 'static', 'Lint proíbe number/parseFloat/toFixed em dinheiro'),
  catalogEntry('QG-06', 'F1', 'static', 'FaultInjector recusa produção'),
  catalogEntry('QG-08', 'F1', 'static', 'Meta-check por ID (escopo e classificação); oráculos não importam src/'),
  catalogEntry('RV-UT-02a', 'F1', 'unit', 'Matriz de reversão comum (regra 3, valor, escopo, regra 9)'),
  // ---- F2 (gate I2 antes)
  catalogEntry('IT-01b', 'F2', 'integration', 'Checksum de migration; convergência de senha e RedrivePolicy'),
  ...['IT-02', 'IT-03', 'IT-04', 'IT-05', 'IT-06', 'IT-08', 'IT-09', 'IT-15', 'IT-16', 'IT-17', 'IT-19'].map((id) =>
    catalogEntry(id, 'F2', 'integration', 'Persistência e wallets'),
  ),
  catalogEntry('IT-07a', 'F2', 'integration', 'Atomicidade no caminho POST /wallets'),
  catalogEntry('QG-04', 'F2', 'static', 'Catálogo do schema por nome'),
  catalogEntry('QG-09', 'F2', 'static', 'Formatação verificada pelo Prettier'),
  catalogEntry('QG-10', 'F2', 'static', 'ESLint com regras do eslint-plugin-sonarjs sem erros'),
  // ---- F3 (gate I1 antes)
  catalogEntry('IT-10a', 'F3', 'integration', 'Idempotência (a, c, d, e)', { decision: 'I2' }),
  ...['IT-11', 'IT-12', 'IT-13', 'IT-18'].map((id) => catalogEntry(id, 'F3', 'integration', 'Submit HTTP')),
  catalogEntry('IT-07b', 'F3', 'integration', 'Atomicidade no caminho HTTP'),
  ...['CT-01h', 'CT-02h', 'CT-04h', 'CT-03', 'CT-09', 'CT-10', 'CT-12', 'CT-13'].map((id) =>
    catalogEntry(id, 'F3', 'concurrency', 'Concorrência via HTTP'),
  ),
  // ---- F4 (gate P1/P2 antes)
  catalogEntry('UT-05b', 'F4', 'unit', 'Precedência dependente de P1/P2', { decision: 'P1' }),
  ...['RV-UT-01', 'RV-UT-02b', 'RV-UT-03'].map((id) => catalogEntry(id, 'F4', 'unit', 'Reversões', { decision: 'P1' })),
  ...range('RV-IT-', 1, 7).map((id) => catalogEntry(id, 'F4', 'integration', 'Reversões', { decision: 'P1' })),
  ...range('RV-CT-', 1, 4).map((id) =>
    catalogEntry(id, 'F4', 'concurrency', 'Reversões concorrentes', { decision: 'P1' }),
  ),
  ...['P2-T1', 'P2-T2', 'P2-T3', 'P2-T4', 'P2-T5'].map((id) =>
    catalogEntry(id, 'F4', 'unit', 'Opção de P2', { decision: 'P2' }),
  ),
  catalogEntry('IT-10b', 'F4', 'integration', 'Replay de uma 1ª resposta 202', { decision: 'I1' }),
  catalogEntry('IT-26', 'F4', 'integration', 'Worker de PENDING_REFERENCE e regra de prazo'),
  catalogEntry('IT-07c', 'F4', 'integration', 'Atomicidade no caminho do worker'),
  ...['CT-07h', 'CT-11h'].map((id) => catalogEntry(id, 'F4', 'concurrency', 'Pendências e reversões via HTTP')),
  // ---- F5
  catalogEntry('UT-14', 'F5', 'unit', 'Construtor de MessageDeduplicationId'),
  ...['IT-14', 'IT-20', 'IT-21', 'IT-22', 'IT-23', 'IT-25', 'IT-29'].map((id) =>
    catalogEntry(id, 'F5', 'integration', 'Mensageria'),
  ),
  ...['IT-21e', 'IT-21f', 'IT-21g', 'IT-21h', 'IT-21i'].map((id) =>
    catalogEntry(id, 'F5', 'integration', 'Dead-letter e redrive'),
  ),
  ...['IT-21b', 'IT-21c', 'IT-21d', 'IT-21j', 'IT-28', 'IT-30'].map((id) =>
    catalogEntry(id, 'F5', 'resilience', 'Quedas na mensageria'),
  ),
  catalogEntry('IT-07d', 'F5', 'integration', 'Atomicidade no caminho SQS'),
  ...['CT-01s', 'CT-02s', 'CT-04s', 'CT-07s', 'CT-11s'].map((id) =>
    catalogEntry(id, 'F5', 'concurrency', 'Concorrência via SQS'),
  ),
  ...['CT-05', 'CT-06'].map((id) => catalogEntry(id, 'F5', 'resilience', 'Queda após commit; publishers concorrentes')),
  // ---- F6
  ...['IT-24', 'IT-27', 'IT-27b'].map((id) => catalogEntry(id, 'F6', 'resilience', 'Indisponibilidade e recuperação')),
  catalogEntry('IT-31', 'F6', 'integration', 'Logs e /metrics'),
  catalogEntry('CT-08', 'F6', 'resilience', 'Reinício com consistência final'),
];

export function phaseIndex(phase: Phase): number {
  return PHASES.indexOf(phase);
}

export function isPhase(value: string): value is Phase {
  return PHASES.some((phase) => phase === value);
}

/** Entradas que já devem existir até a fase informada (inclusive). */
export function entriesUpTo(phase: Phase): CatalogEntry[] {
  return CATALOG.filter((entry) => phaseIndex(entry.phase) <= phaseIndex(phase));
}

/**
 * Decisões do usuário já tomadas (o oráculo dos testes que dependem delas segue
 * a escolha). I2 = Idempotency-Key global, decidida em 2026-11-11. I1 = opção A,
 * resposta original congelada no replay; P1 = C (uma por tipo, contando desfeitas, e uma em
 * vigor por referência); P2 = (c) (BET revertida em vigor não recebe WIN/LOSS; BET com WIN em
 * vigor não é revertida) — decididas em 2026-11-12 (ARCHITECTURE.md §1).
 */
export const DECIDED: Readonly<Partial<Record<NonNullable<CatalogEntry['decision']>, string>>> = {
  I2: 'global',
  I1: 'original-response',
  P1: 'C',
  P2: 'c',
};
