/**
 * Reimprime o resumo da última execução (ou de um runId informado) a partir do
 * volume `test-artifacts`, sem rodar testes:
 *   docker compose run --rm --no-deps tests bun run test:report [runId]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = '/app/test-results';
const runId =
  process.argv[2] ?? (existsSync(join(root, 'latest')) ? readFileSync(join(root, 'latest'), 'utf8').trim() : undefined);
if (runId === undefined || !/^[a-z0-9]{8}$/.test(runId)) {
  console.error('nenhuma execução encontrada em test-artifacts');
  process.exit(1);
}
const file = join(root, runId, 'summary.json');
if (!existsSync(file)) {
  console.error(`resumo ausente: ${file}`);
  process.exit(1);
}

interface Summary {
  runId: string;
  mode: string;
  startedAt: string;
  durationMs: number;
  bun: string;
  kernel: string;
  stages: { stage: string; ok: boolean; durationMs: number; notes: string[] }[];
  meta: { id: string; required: boolean; status: string }[];
  strictMisses: string[];
  exitCode: number;
}

const summary = JSON.parse(readFileSync(file, 'utf8')) as Summary;
console.log(
  `run ${summary.runId}  modo ${summary.mode}  início ${summary.startedAt}  duração ${Math.round(summary.durationMs / 1000)} s`,
);
console.log(`bun ${summary.bun}  kernel ${summary.kernel}`);
for (const stage of summary.stages)
  console.log(
    `  ${stage.ok ? 'OK  ' : 'FAIL'} ${stage.stage.padEnd(12)} ${stage.durationMs} ms  ${stage.notes.join(' | ')}`,
  );
const counts = new Map<string, number>();
for (const item of summary.meta) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
const countsByStatus = [...counts].map(([status, count]) => `${status}=${count}`).join('  ');
console.log(`meta-check: ${countsByStatus}`);
if (summary.strictMisses.length > 0) console.log(`fora de PASS no escopo: ${summary.strictMisses.join(' ')}`);
console.log(`exit ${summary.exitCode}`);
