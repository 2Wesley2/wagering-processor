/**
 * Pipeline de testes (D45), executado DENTRO do contêiner `tests`:
 *   bun scripts/test-all.ts                 → todas as etapas + meta-check estrito
 *   bun scripts/test-all.ts --phase F0      → testes existentes; estrito só até a fase
 *   bun scripts/test-all.ts unit integration → só as etapas citadas (meta-check informativo)
 *   bun scripts/test-all.ts --selfcheck     → falha proposital (V4); exit ≠ 0 esperado
 * Roda todas as etapas mesmo quando uma falha; imprime resumo, meta-check e EVIDENCE.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DeleteQueueCommand, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { Glob } from 'bun';
import { runMigrations } from '../src/platform/persistence/migrator.ts';
import { connect, ensureDatabase, ensureRoles, waitForPostgres } from '../src/platform/persistence/pg-admin.ts';
import { createSqsClient, waitForSqs } from '../src/platform/sqs/sqs-client.ts';
import {
  type Counts,
  evaluateMeta,
  exitCodeFor,
  formatStrictMisses,
  type MetaItem,
  resolveMode,
  type Status,
} from '../test/meta/evaluate.ts';
import { CATALOG, DECIDED, isPhase, type Phase, STAGES, type Stage } from '../test/meta/required.ts';
import { RESULTS_DIR, RUN_ID, TEST_DB_RE, TEST_QUEUE_RE } from '../test/support/run-context.ts';

interface StageReport {
  stage: string;
  ok: boolean;
  durationMs: number;
  memoryCurrentBytes?: number;
  notes: string[];
}

// ------------------------------------------------------------------ argumentos
const argv = process.argv.slice(2);
const selfcheck = argv.includes('--selfcheck');
const phaseArg = argv.includes('--phase') ? argv[argv.indexOf('--phase') + 1] : undefined;
if (phaseArg !== undefined && !isPhase(phaseArg)) {
  console.error(`--phase inválida: ${phaseArg}`);
  process.exit(2);
}
const phase: Phase | undefined = phaseArg;
const positional = argv.filter((argument, index) => !argument.startsWith('--') && argv[index - 1] !== '--phase');
const isStage = (value: string): value is Stage => STAGES.some((stage) => stage === value);
const unknown = positional.filter((value) => !isStage(value));
if (unknown.length > 0) {
  console.error(`etapas desconhecidas: ${unknown.join(', ')} (válidas: ${STAGES.join('|')})`);
  process.exit(2);
}
const selected: Stage[] = positional.length > 0 ? positional.filter(isStage) : [...STAGES];
const partialRun = positional.length > 0;
const mode = resolveMode(phase, partialRun);

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`variável ausente: ${name}`);
  return value;
};

const childEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  RUN_ID,
  RESULTS_DIR,
  NODE_ENV: 'test',
};

mkdirSync(join(RESULTS_DIR, 'junit'), { recursive: true });
const results = new Map<string, Counts>();
const stageReports: StageReport[] = [];

function record(id: string, outcome: keyof Counts): void {
  const counts = results.get(id) ?? { pass: 0, fail: 0, skip: 0 };
  counts[outcome] += 1;
  results.set(id, counts);
}

function cgroupNumber(file: string): number | undefined {
  try {
    const raw = readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();
    return raw === 'max' ? undefined : Number.parseInt(raw, 10);
  } catch {
    return undefined;
  }
}

const mib = (bytes: number | undefined): string => (bytes === undefined ? 'n/d' : `${Math.round(bytes / 1048576)} MiB`);

async function run(command: string[], extraEnv: Record<string, string> = {}): Promise<number> {
  console.log(`\n$ ${command.join(' ')}`);
  const proc = Bun.spawn(command, {
    env: { ...childEnv, ...extraEnv },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  });
  return proc.exited;
}

// ------------------------------------------------------------------ junit
const decode = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

const ID_RE = /\[([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+[a-z]?)\]/g;

function parseJunit(file: string): { total: number; failed: number } {
  if (!existsSync(file)) return { total: 0, failed: 0 };
  const xml = readFileSync(file, 'utf8');
  let total = 0;
  let failed = 0;
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? '';
    const body = match[3] ?? '';
    const name = decode(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? '');
    const outcome = testcaseOutcome(body);
    total += 1;
    if (outcome === 'fail') failed += 1;
    const ids = new Set([...name.matchAll(ID_RE)].map((item) => item[1] ?? ''));
    for (const id of ids) record(id, outcome);
  }
  return { total, failed };
}

function testcaseOutcome(body: string): keyof Counts {
  if (/<failure|<error/.test(body)) return 'fail';
  if (/<skipped/.test(body)) return 'skip';
  return 'pass';
}

async function bunTest(stage: string, directory: string): Promise<{ ok: boolean; notes: string[] }> {
  const files = [...new Glob(`${directory}/**/*.test.ts`).scanSync({ cwd: process.cwd() })];
  if (files.length === 0) return { ok: true, notes: [`sem arquivos em ${directory}`] };
  const junit = join(RESULTS_DIR, 'junit', `${stage}.xml`);
  const code = await run([
    'bun',
    'test',
    `${directory}/`,
    '--timeout',
    '120000',
    '--reporter=junit',
    `--reporter-outfile=${junit}`,
  ]);
  const parsed = parseJunit(junit);
  const notes = [`${files.length} arquivo(s), ${parsed.total} caso(s), ${parsed.failed} falha(s), exit ${code}`];
  if (parsed.total === 0) notes.push('junit vazio: nenhum caso registrado');
  return { ok: code === 0 && parsed.failed === 0 && parsed.total > 0, notes };
}

// ------------------------------------------------------------------ etapas
async function staticStage(): Promise<{ ok: boolean; notes: string[] }> {
  const notes: string[] = [];
  const tsc = await run(['bunx', '--bun', 'tsc', '--noEmit', '-p', 'tsconfig.json']);
  record('QG-01', tsc === 0 ? 'pass' : 'fail');
  notes.push(`tsc exit ${tsc}`);
  // QG-10: ESLint inclui as regras do eslint-plugin-sonarjs (não é o SonarQube completo).
  // --max-warnings 0: um aviso também reprova, para não passar despercebido no exit code.
  const lint = await run(['bunx', '--bun', 'eslint', '--max-warnings', '0', '.']);
  record('QG-10', lint === 0 ? 'pass' : 'fail');
  notes.push(`eslint + sonarjs exit ${lint}`);
  const prettier = await run(['bunx', '--bun', 'prettier', '--check', '.']);
  record('QG-09', prettier === 0 ? 'pass' : 'fail');
  notes.push(`prettier --check exit ${prettier}`);
  const crFiles: string[] = [];
  for (const pattern of [
    'src/**/*',
    'test/**/*',
    'scripts/**/*',
    'infra/**/*',
    '*.ts',
    '*.json',
    '*.yml',
    '*.toml',
    'Dockerfile',
  ]) {
    for (const file of new Glob(pattern).scanSync({ cwd: process.cwd(), onlyFiles: true })) {
      if (readFileSync(file, 'utf8').includes('\r')) crFiles.push(file);
    }
  }
  notes.push(crFiles.length === 0 ? 'varredura de CR: ok' : `CR encontrado em: ${crFiles.join(', ')}`);
  const arch = await bunTest('static', 'test/architecture');
  notes.push(...arch.notes);
  return { ok: tsc === 0 && lint === 0 && prettier === 0 && crFiles.length === 0 && arch.ok, notes };
}

async function preflight(): Promise<string> {
  const adminUrl = env('PG_ADMIN_URL');
  await waitForPostgres(adminUrl, 60_000);
  const passwords = { ownerPassword: env('OWNER_DB_PASSWORD'), appPassword: env('APP_DB_PASSWORD') };
  const template = `wt_${RUN_ID}_template`;
  const admin = await connect(adminUrl, 'wagering:test-preflight');
  try {
    await ensureRoles(admin, passwords);
    await ensureDatabase(admin, template);
  } finally {
    await admin.end();
  }
  const owner = new URL(adminUrl);
  owner.username = 'wagering_owner';
  owner.password = encodeURIComponent(passwords.ownerPassword);
  owner.pathname = `/${template}`;
  await runMigrations(owner.toString(), 'up');
  const sqs = createSqsClient({
    endpoint: env('SQS_ENDPOINT'),
    region: env('AWS_REGION', 'us-east-1'),
    requestTimeoutMs: 5000,
  });
  try {
    await waitForSqs(sqs, 60_000);
  } finally {
    sqs.destroy();
  }
  return template;
}

async function cleanup(): Promise<string[]> {
  const notes: string[] = [];
  try {
    const admin = await connect(env('PG_ADMIN_URL'), 'wagering:test-cleanup');
    try {
      const dbs = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [
        `wt\\_${RUN_ID}\\_%`,
      ]);
      for (const { datname } of dbs.rows) {
        if (!TEST_DB_RE.test(datname)) continue;
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(datname)} WITH (FORCE)`);
      }
      notes.push(`bancos removidos: ${dbs.rowCount ?? 0}`);
    } finally {
      await admin.end();
    }
  } catch (error) {
    notes.push(`limpeza do PG falhou: ${String(error)}`);
  }
  try {
    const sqs = createSqsClient({
      endpoint: env('SQS_ENDPOINT'),
      region: env('AWS_REGION', 'us-east-1'),
      requestTimeoutMs: 5000,
    });
    const listed = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: `t-${RUN_ID}-` }));
    let removed = 0;
    for (const url of listed.QueueUrls ?? []) {
      const name = url.split('/').pop() ?? '';
      if (!TEST_QUEUE_RE.test(name)) continue;
      await sqs.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);
      removed += 1;
    }
    sqs.destroy();
    notes.push(`filas removidas: ${removed}`);
  } catch (error) {
    notes.push(`limpeza do SQS falhou: ${String(error)}`);
  }
  return notes;
}

// ------------------------------------------------------------------ meta-check
function blockedIds(): Set<string> {
  const directory = join(RESULTS_DIR, 'blocked');
  if (!existsSync(directory)) return new Set();
  return new Set(readdirSync(directory).map((fileName) => fileName.replace(/\.json$/, '')));
}

// ------------------------------------------------------------------ main
const STATUS_ORDER: readonly Status[] = ['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'NOT IMPLEMENTED'];
const RULE = '='.repeat(78);

function modeDescription(): string {
  if (selfcheck) return 'selfcheck';
  if (mode.kind === 'stages') return `etapas ${selected.join(',')} (meta-check informativo)`;
  if (mode.kind === 'phase') return `fase ${mode.phase}`;
  return 'completo (estrito)';
}

function printBanner(): void {
  console.log(RULE);
  console.log(`run ${RUN_ID}  bun ${Bun.version}  kernel ${os.release()}  ${os.platform()}/${os.arch()}`);
  const memoryMax = mib(cgroupNumber('memory.max'));
  console.log(`CPUs ${os.cpus().length}  RAM ${mib(os.totalmem())}  cgroup memory.max ${memoryMax}`);
  console.log(`modo: ${modeDescription()}`);
  console.log(`artefatos: ${RESULTS_DIR}`);
  console.log(RULE);
}

async function runSelfcheck(): Promise<number> {
  const outcome = await bunTest('selfcheck', 'test/selfcheck');
  if (outcome.ok) {
    console.log('\nSELFCHECK: a falha proposital NÃO foi detectada (erro do pipeline)');
    return 3;
  }
  console.log('\nSELFCHECK: falha proposital detectada → exit 1 (esperado)');
  return 1;
}

async function runPreflight(): Promise<boolean> {
  try {
    childEnv['TEST_TEMPLATE_DB'] = await preflight();
    console.log(`preflight ok: template ${childEnv['TEST_TEMPLATE_DB']}`);
    return true;
  } catch (error) {
    console.error(`preflight FALHOU: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function runStage(stage: Stage, preflightOk: boolean): Promise<{ ok: boolean; notes: string[] }> {
  if (!preflightOk && stage !== 'static') return { ok: false, notes: ['não executada: preflight falhou'] };
  if (stage === 'static') return staticStage();
  return bunTest(stage, `test/${stage}`);
}

async function runStages(preflightOk: boolean): Promise<void> {
  for (const stage of selected) {
    const stageStartedAt = Date.now();
    const outcome = await runStage(stage, preflightOk);
    const report: StageReport = {
      stage,
      ok: outcome.ok,
      durationMs: Date.now() - stageStartedAt,
      notes: outcome.notes,
    };
    const memoryCurrentBytes = cgroupNumber('memory.current');
    if (memoryCurrentBytes !== undefined) report.memoryCurrentBytes = memoryCurrentBytes;
    stageReports.push(report);
  }
}

function printStages(cleanupNotes: readonly string[]): void {
  console.log(`\n${RULE}\nETAPAS`);
  for (const report of stageReports) {
    const label = report.ok ? 'OK  ' : 'FAIL';
    const duration = String(report.durationMs).padStart(7);
    console.log(`  ${label} ${report.stage.padEnd(12)} ${duration} ms  mem ${mib(report.memoryCurrentBytes)}`);
    for (const note of report.notes) console.log(`         ${note}`);
  }
  console.log(`  pico de memória do contêiner (cgroup memory.peak): ${mib(cgroupNumber('memory.peak'))}`);
  console.log(`  limpeza: ${cleanupNotes.join('; ')}`);
}

function scopeDescription(): string {
  if (mode.kind === 'stages') return 'informativo (execução parcial por etapa)';
  if (mode.kind === 'phase') return `estrito até ${mode.phase}, informativo depois`;
  return 'estrito no catálogo completo';
}

function printMetaCheck(meta: readonly MetaItem[]): void {
  console.log(`\nMETA-CHECK (QG-08) — ${scopeDescription()}`);
  const byStatus = new Map<Status, string[]>();
  for (const item of meta) {
    const label = item.required ? item.id : `${item.id}(info)`;
    byStatus.set(item.status, [...(byStatus.get(item.status) ?? []), label]);
  }
  for (const status of STATUS_ORDER) {
    const ids = byStatus.get(status) ?? [];
    console.log(`  ${status.padEnd(16)} ${String(ids.length).padStart(3)}  ${ids.join(' ')}`);
  }
  const pendingDecisions = meta.filter(
    (item) => item.decision !== undefined && item.status !== 'PASS' && DECIDED[item.decision] === undefined,
  );
  if (pendingDecisions.length > 0) {
    const decisions = [...new Set(pendingDecisions.map((item) => item.decision))].join(', ');
    console.log(`  dependem de decisão ainda pendente do usuário: ${decisions}`);
  }
  const decided = Object.entries(DECIDED).map(([decisionId, choice]) => `${decisionId}=${choice}`);
  if (decided.length > 0) console.log(`  decisões já tomadas: ${decided.join(', ')}`);
}

function printEvidence(): void {
  const evidenceDir = join(RESULTS_DIR, 'evidence');
  if (!existsSync(evidenceDir)) return;
  console.log('\nEVIDENCE');
  for (const file of readdirSync(evidenceDir).sort((left, right) => left.localeCompare(right))) {
    const body = JSON.stringify(JSON.parse(readFileSync(join(evidenceDir, file), 'utf8')));
    const shown = body.length > 4000 ? body.slice(0, 4000) + '…' : body;
    console.log(`EVIDENCE ${file.replace(/\.json$/, '')} ${shown}`);
  }
}

function writeSummary(
  meta: readonly MetaItem[],
  strictMisses: readonly MetaItem[],
  started: number,
  exitCode: number,
): void {
  const fallbackMode = partialRun ? selected.join(',') : 'full';
  const summary = {
    runId: RUN_ID,
    mode: phase ?? fallbackMode,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    bun: Bun.version,
    kernel: os.release(),
    stages: stageReports,
    meta: meta.map(({ id, phase: entryPhase, stage, required, status }) => ({
      id,
      phase: entryPhase,
      stage,
      required,
      status,
    })),
    strictMisses: strictMisses.map((item) => item.id),
    exitCode,
  };
  writeFileSync(join(RESULTS_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(RESULTS_DIR, '..', 'latest'), `${RUN_ID}\n`);
}

function printResult(strictMisses: readonly MetaItem[], started: number, exitCode: number): void {
  console.log(`\n${RULE}`);
  if (strictMisses.length > 0) {
    console.log(
      `IDs obrigatórios fora de PASS no escopo (${strictMisses.length}): ${formatStrictMisses(strictMisses)}`,
    );
  }
  const verdict = exitCode === 0 ? 'OK' : 'FALHOU';
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`RESULTADO: ${verdict} (exit ${exitCode}) em ${seconds} s`);
}

async function main(): Promise<number> {
  const started = Date.now();
  printBanner();
  if (selfcheck) return runSelfcheck();

  const preflightOk = await runPreflight();
  await runStages(preflightOk);
  const cleanupNotes = await cleanup();

  const { meta, strictMisses } = evaluateMeta(CATALOG, results, blockedIds(), mode);
  const anyStageFailed = stageReports.some((report) => !report.ok);

  printStages(cleanupNotes);
  printMetaCheck(meta);
  printEvidence();
  const exitCode = exitCodeFor(anyStageFailed, strictMisses);
  writeSummary(meta, strictMisses, started, exitCode);
  printResult(strictMisses, started, exitCode);
  return exitCode;
}

process.exit(await main());
