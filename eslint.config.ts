import js from '@eslint/js';
import type { Linter } from 'eslint';
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

/** Os tipos do plugin admitem formatos legados; aqui só serve uma configuração flat (objeto com `plugins`). */
function isFlatConfig(config: unknown): config is Linter.Config {
  return (
    typeof config === 'object' && config !== null && !Array.isArray(config) && 'plugins' in config && !('env' in config)
  );
}

const sonarRecommended = sonarjs.configs?.recommended;
if (!isFlatConfig(sonarRecommended))
  throw new Error('eslint-plugin-sonarjs: configuração recommended ausente ou legada');

/** Padrões proibidos para dinheiro e para o caminho transacional (§5 item 1, D19, D23). */
export const restrictedSyntax = [
  { selector: "CallExpression[callee.name='parseFloat']", message: 'Dinheiro nunca usa parseFloat (§5 item 1).' },
  {
    selector: "CallExpression[callee.object.name='Number'][callee.property.name='parseFloat']",
    message: 'Dinheiro nunca usa Number.parseFloat (§5 item 1).',
  },
  {
    selector: "CallExpression[callee.property.name='toFixed']",
    message: 'toFixed arredonda float; proibido (§5 item 1).',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='round']",
    message: 'Math.round é proibido no código da app.',
  },
  {
    selector: 'TSPropertySignature[key.name=/^(amount|balance|money)$/] TSNumberKeyword',
    message: 'Campos monetários não podem ser number (§5 item 1).',
  },
  {
    selector: 'PropertyDefinition[key.name=/^(amount|balance|money)$/] TSNumberKeyword',
    message: 'Campos monetários não podem ser number (§5 item 1).',
  },
  {
    selector: "CallExpression[callee.property.name='execute'][callee.object.callee.property.name='getConnection']",
    message: 'SQL cru só pelo TxSql (D19).',
  },
  { selector: "CallExpression[callee.property.name='getKysely']", message: 'getKysely só pelo TxSql (D19).' },
  {
    selector: 'Literal[value=/version\\s*=\\s*version\\s*\\+\\s*1/i]',
    message: 'A versão da wallet vem do domínio, nunca de version = version + 1 (D23).',
  },
  {
    selector: 'TemplateElement[value.raw=/version\\s*=\\s*version\\s*\\+\\s*1/i]',
    message: 'A versão da wallet vem do domínio, nunca de version = version + 1 (D23).',
  },
];

export default defineConfig(
  { ignores: ['node_modules/**', 'test-results/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // Análise estática do SonarJS (plugin de ESLint; não é o SonarQube completo).
  sonarRecommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-syntax': ['error', ...restrictedSyntax],
      // Constituição, Princípio XIII: afirmações de tipo não podem esconder dados não validados.
      // Não alcançam `as const`, apelidos em imports nem a negação lógica `!valor`.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],
    },
  },
  {
    // QG-07: src/ só pode importar dependências de produção.
    files: ['src/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: false, optionalDependencies: false, peerDependencies: false },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.ts', 'eslint.config.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': ['error', { devDependencies: true }],
      'no-restricted-syntax': 'off',
    },
  },
);
