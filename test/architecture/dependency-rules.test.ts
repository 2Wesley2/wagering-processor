import { describe, expect, test } from 'bun:test';
import { listTsFiles, violations } from '../support/arch-rules.ts';

describe('[QG-03] regra de dependência', () => {
  test('[QG-03] o verificador detecta violações conhecidas (autoteste com fixtures)', () => {
    expect(violations('src/modules/wallet/domain/wallet.ts', "import { Injectable } from '@nestjs/common';")).toEqual([
      'importa @nestjs/common',
    ]);
    expect(violations('src/modules/wagering/application/x.ts', "import pg from 'pg';")).toEqual(['importa pg']);
    expect(violations('src/shared/money.ts', "const m = await import('@mikro-orm/core');")).toEqual([
      'importa @mikro-orm/core',
    ]);
    expect(violations('src/shared/money.ts', "export { x } from '@aws-sdk/client-sqs';")).toEqual([
      'importa @aws-sdk/client-sqs',
    ]);
    // Fora de domain/application/shared o import é permitido.
    expect(violations('src/modules/wallet/infrastructure/repo.ts', "import pg from 'pg';")).toEqual([]);
    // 'pgx' não é 'pg': o prefixo não pode gerar falso positivo.
    expect(violations('src/shared/x.ts', "import y from 'pgx';")).toEqual([]);
  });

  test('[QG-03] nenhum arquivo puro de src/ importa framework, ORM, SDK, driver ou logger', async () => {
    const files = await listTsFiles('src');
    expect(files.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const violation of violations(file, source)) found.push(`${file}: ${violation}`);
    }
    expect(found).toEqual([]);
  });
});
