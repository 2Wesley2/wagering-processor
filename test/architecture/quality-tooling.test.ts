import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import sonarjs from 'eslint-plugin-sonarjs';

/**
 * QG-09 e QG-10: as ferramentas de qualidade estão de fato configuradas. O exit
 * code de `prettier --check` e de `eslint --max-warnings 0 .` é registrado pelo
 * test-all; aqui se garante que esses exit codes não passam por configuração vazia,
 * rebaixada ou desligada.
 */
const SEVERITY_BY_NAME: Readonly<Record<string, number>> = { off: 0, warn: 1, error: 2 };

/** Severidade numérica de uma entrada de regra (`'error'`, `2`, `['error', {...}]`...). */
function severityOf(entry: unknown): number | undefined {
  const level: unknown = Array.isArray(entry) ? entry[0] : entry;
  if (typeof level === 'number') return level;
  if (typeof level === 'string') return SEVERITY_BY_NAME[level];
  return undefined;
}

function rulesOf(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || !('rules' in config)) return {};
  const rules = config.rules;
  return typeof rules === 'object' && rules !== null ? Object.fromEntries(Object.entries(rules)) : {};
}

const PROBE_FILE = 'src/shared/money.ts';

describe('[QG-10] regras do eslint-plugin-sonarjs ativas com a severidade efetiva', () => {
  test('[QG-10] a severidade efetiva de cada regra do recommended do SonarJS é a do recommended', async () => {
    const effective = rulesOf(await new ESLint().calculateConfigForFile(PROBE_FILE));
    const recommended = rulesOf(sonarjs.configs?.recommended);
    const recommendedNames = Object.keys(recommended);
    expect(recommendedNames.length).toBeGreaterThan(200);
    const divergent = recommendedNames
      .map((name) => ({ name, expected: severityOf(recommended[name]), actual: severityOf(effective[name]) }))
      .filter((rule) => rule.expected !== rule.actual);
    // Nenhuma regra do recommended foi desligada ou rebaixada pela configuração do projeto.
    expect(divergent).toEqual([]);
    const sonarSeverities = Object.entries(effective)
      .filter(([name]) => name.startsWith('sonarjs/'))
      .map(([, entry]) => severityOf(entry));
    expect(sonarSeverities.filter((severity) => severity === 2).length).toBeGreaterThan(200);
    // Nenhuma regra em "warn": um aviso não muda o exit code e passaria despercebido.
    expect(sonarSeverities.filter((severity) => severity === 1)).toEqual([]);
    expect(severityOf(effective['@typescript-eslint/no-non-null-assertion'])).toBe(2);
    expect(severityOf(effective['@typescript-eslint/consistent-type-assertions'])).toBe(2);
  });

  test('[QG-10] regras ativadas produzem o diagnóstico esperado; as const continua livre', async () => {
    const source = [
      'export const pick = (flag: boolean): number => (flag ? 1 : 1);',
      'export const raw = (value: string | undefined): string => value!;',
      "export const kinds = ['A', 'B'] as const;",
      '',
    ].join('\n');
    const [result] = await new ESLint().lintText(source, { filePath: PROBE_FILE });
    const diagnostics = (result?.messages ?? []).map((message) => ({
      ruleId: message.ruleId,
      severity: message.severity,
      line: message.line,
    }));
    expect(diagnostics).toContainEqual({ ruleId: 'sonarjs/no-all-duplicated-branches', severity: 2, line: 1 });
    expect(diagnostics).toContainEqual({ ruleId: '@typescript-eslint/no-non-null-assertion', severity: 2, line: 2 });
    expect(diagnostics.filter((diagnostic) => diagnostic.line === 3)).toEqual([]);
  });
});

describe('[QG-09] Prettier configurado sem tocar arquivos protegidos', () => {
  test('[QG-09] .prettierignore protege o enunciado e os arquivos do Spec Kit', async () => {
    const ignored = (await Bun.file('.prettierignore').text()).split('\n').map((line) => line.trim());
    expect(ignored).toContain('docs/');
    expect(ignored).toContain('.specify/');
    expect(ignored).toContain('.claude/');
    const options: unknown = await Bun.file('.prettierrc.json').json();
    expect(options).toMatchObject({ endOfLine: 'lf', singleQuote: true });
  });
});
