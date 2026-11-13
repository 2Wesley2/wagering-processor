import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { builtinModules } from 'node:module';
import { importsOf, listTsFiles } from '../support/arch-rules.ts';

const packageJsonSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

function packageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:')) return undefined;
  if (builtinModules.includes(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * QG-07: a imagem de produção instala só `dependencies`. Um import de src/ que
 * resolva para devDependency quebraria em produção; este teste e o boot-check
 * no build da imagem runtime pegam o erro antes.
 */
describe('[QG-07] dependências de produção', () => {
  test('[QG-07] todo pacote importado em src/ está em dependencies (não em devDependencies)', async () => {
    const packageJson = packageJsonSchema.parse(await Bun.file('package.json').json());
    const prod = new Set(Object.keys(packageJson.dependencies ?? {}));
    const dev = new Set(Object.keys(packageJson.devDependencies ?? {}));
    const problems: string[] = [];
    for (const file of await listTsFiles('src')) {
      for (const specifier of importsOf(await Bun.file(file).text())) {
        const name = packageName(specifier);
        if (name === undefined || prod.has(name)) continue;
        problems.push(`${file}: ${name}${dev.has(name) ? ' (devDependency)' : ' (não declarado)'}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('[QG-07] a imagem runtime executa o boot-check com NODE_ENV=production', async () => {
    const dockerfile = await Bun.file('Dockerfile').text();
    const runtime = dockerfile.split(/^FROM /m).find((stage) => /\bAS runtime\b/.test(stage));
    expect(runtime).toBeDefined();
    expect(runtime).toContain('NODE_ENV=production');
    expect(runtime).toContain('bun src/cli/boot-check.ts');
    expect(runtime).toMatch(/--frozen-lockfile|deps-prod/);
  });

  test('[QG-07] versões exatas no package.json (sem ^, ~ ou latest)', async () => {
    const packageJson = packageJsonSchema.parse(await Bun.file('package.json').json());
    const loose = Object.entries({ ...packageJson.dependencies, ...packageJson.devDependencies }).filter(
      ([, version]) => !/^\d+\.\d+\.\d+$/.test(version),
    );
    expect(loose).toEqual([]);
  });
});
