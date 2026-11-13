import { describe, expect, test } from 'bun:test';
import { importsOf } from '../support/arch-rules.ts';

/**
 * QG-08 (fitness, D58): o modelo de referência usado como oráculo não importa
 * código de produção; um erro em src/ não pode ser repetido pelo oráculo.
 */
const ORACLE_FILES = ['test/support/model.ts', 'test/support/verifier.ts'];

describe('[QG-08] oráculos independentes de src/', () => {
  test('[QG-08] o verificador detecta import de src/ (autoteste)', () => {
    const bad = "import { Money } from '../../src/shared/money.ts';";
    expect(importsOf(bad).some((specifier) => specifier.includes('/src/') || specifier.startsWith('src/'))).toBe(true);
  });

  test('[QG-08] arquivos de oráculo não importam nada de src/ nem pacotes de produção', async () => {
    for (const file of ORACLE_FILES) {
      const imports = importsOf(await Bun.file(file).text());
      expect({ file, imports }).toEqual({ file, imports: [] });
    }
  });
});
