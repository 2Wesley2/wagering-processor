import { Glob } from 'bun';

/** Pacotes proibidos em código puro: domain/, application/ e shared/ (D02, §6.1). */
export const FORBIDDEN_IN_PURE = ['@nestjs/', '@mikro-orm/', '@aws-sdk/', 'pg', 'pino', 'prom-client'] as const;

// Três expressões simples (sem retrocesso super-linear): `... from 'x'`, `import 'x'` e `import('x')`.
const FROM_RE = /\bfrom\s+['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /^[ \t]*import[ \t]+['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of [FROM_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
}

export function isPureModule(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return /\/(domain|application)\//.test(normalized) || normalized.startsWith('src/shared/');
}

function isForbidden(specifier: string): boolean {
  return FORBIDDEN_IN_PURE.some((prefix) =>
    prefix.endsWith('/') ? specifier.startsWith(prefix) : specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
}

/** Violações de um arquivo; vazio quando o arquivo não é puro ou está limpo. */
export function violations(path: string, source: string): string[] {
  if (!isPureModule(path)) return [];
  return importsOf(source)
    .filter(isForbidden)
    .map((specifier) => `importa ${specifier}`);
}

export async function listTsFiles(root: string): Promise<string[]> {
  const glob = new Glob(`${root}/**/*.ts`);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: process.cwd() })) files.push(file);
  return files.sort((left, right) => left.localeCompare(right));
}
