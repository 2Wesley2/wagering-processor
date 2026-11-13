import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { restrictedSyntax } from '../../eslint.config.ts';

/**
 * QG-02: as regras de lint que protegem dinheiro realmente disparam (fixtures
 * positivas e negativas) e estão ativas para src/ na configuração real.
 */
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      rules: { 'no-restricted-syntax': ['error', ...restrictedSyntax] },
    },
  ],
});

async function messages(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: 'src/fixture.ts' });
  return (result?.messages ?? []).map((message) => message.message);
}

describe('[QG-02] lint de dinheiro', () => {
  test('[QG-02] padrões proibidos disparam', async () => {
    const forbidden = [
      'const a = parseFloat("1.10");',
      'const a = Number.parseFloat("1.10");',
      'const s = (1.1).toFixed(2);',
      'const r = Math.round(1.5);',
      'interface X { amount: number }',
      'class Y { balance: number = 0 }',
      'const sql = "UPDATE wallets SET version = version + 1";',
      'const sql = `UPDATE wallets SET version = version + 1`;',
      'em.getConnection().execute("select 1");',
      'em.getKysely();',
    ];
    for (const code of forbidden) expect({ code, hits: (await messages(code)).length }).toEqual({ code, hits: 1 });
  });

  test('[QG-02] código equivalente permitido não dispara', async () => {
    const allowed = [
      'interface X { amount: string }',
      'class Y { balance: bigint = 0n }',
      'const n = Number.parseInt("10", 10);',
      'const f = Math.floor(1.5);',
      'const sql = "UPDATE wallets SET version = $2";',
    ];
    for (const code of allowed) expect({ code, msgs: await messages(code) }).toEqual({ code, msgs: [] });
  });

  test('[QG-02] a regra está ligada para src/ na configuração real do projeto', async () => {
    const config: unknown = await new ESLint().calculateConfigForFile('src/shared/money.ts');
    const rules = typeof config === 'object' && config !== null && 'rules' in config ? config.rules : undefined;
    const rule: unknown =
      typeof rules === 'object' && rules !== null && 'no-restricted-syntax' in rules
        ? rules['no-restricted-syntax']
        : undefined;
    expect(Array.isArray(rule) ? rule[0] : rule).not.toBe('off');
    expect(Array.isArray(rule) ? rule[0] : rule).not.toBe(0);
    expect(Array.isArray(rule) ? rule.length - 1 : 0).toBe(restrictedSyntax.length);
  });
});
