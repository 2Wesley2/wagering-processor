import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './run-context.ts';

/** Grava a evidência de um teste (bloco EVIDENCE do relatório; D47). */
export function writeEvidence(testId: string, evidence: Record<string, unknown>): void {
  const directory = join(RESULTS_DIR, 'evidence');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${testId}.json`), `${JSON.stringify({ testId, ...evidence }, null, 2)}\n`);
}
