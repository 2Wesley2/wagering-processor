import { randomInt } from 'node:crypto';
import type { Subprocess } from 'bun';
import { eventually } from './eventually.ts';
import { LogBook } from './logbook.ts';

export interface KillRecord {
  readonly signal: string;
  readonly at: string;
}

export interface ExitInfo {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

export interface Instance {
  readonly id: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly logs: LogBook;
  readonly stderr: string[];
  /** Sinais enviados PELO HARNESS: separa queda autoinfligida de kill externo (D47). */
  readonly killLog: KillRecord[];
  readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly exited: Promise<ExitInfo>;
}

const live = new Set<Instance>();
let nextPort = 20_000 + randomInt(2000);

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) onLine(buffer);
}

/** Sobe uma instância real da app como processo Linux separado (D46). */
export function startInstance(options: { id: string; env: Record<string, string> }): Instance {
  const port = nextPort++;
  const logs = new LogBook();
  const stderr: string[] = [];
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, ...options.env, PORT: String(port), INSTANCE_ID: options.id, EXIT_ON_STDIN_EOF: '1' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void pump(proc.stdout, (line) => logs.push(line));
  void pump(proc.stderr, (line) => stderr.push(line));
  const instance: Instance = {
    id: options.id,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    stderr,
    killLog: [],
    proc,
    exited: proc.exited.then(() => ({
      exitCode: proc.exitCode,
      signalCode: proc.signalCode === null ? null : String(proc.signalCode),
    })),
  };
  live.add(instance);
  void instance.exited.then(() => live.delete(instance));
  return instance;
}

export function signal(instance: Instance, sig: 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT' | 'SIGUSR2'): void {
  instance.killLog.push({ signal: sig, at: new Date().toISOString() });
  instance.proc.kill(sig);
}

export async function closeStdin(instance: Instance): Promise<void> {
  await instance.proc.stdin.end();
}

/** Espera /health/ready = 200; se o processo morrer antes, falha com stderr e logs. */
export async function waitReady(instance: Instance, timeoutMs = 30_000): Promise<void> {
  let exitedEarly: ExitInfo | undefined;
  void instance.exited.then((info) => {
    exitedEarly = info;
  });
  await eventually(
    async () => {
      if (exitedEarly !== undefined) {
        throw new Error(`instância ${instance.id} saiu antes de ficar pronta: ${JSON.stringify(exitedEarly)}`);
      }
      const response = await fetch(`${instance.baseUrl}/health/ready`, { signal: AbortSignal.timeout(1500) });
      return response.status === 200 ? true : undefined;
    },
    {
      timeoutMs,
      intervalMs: 200,
      describe: `instância ${instance.id} pronta`,
      diagnose: () => ({
        exit: exitedEarly,
        stderr: instance.stderr.slice(-20),
        events: instance.logs.events().slice(-20),
      }),
    },
  );
}

export async function stopAllInstances(): Promise<void> {
  const pending = [...live];
  for (const instance of pending) {
    try {
      signal(instance, 'SIGKILL');
    } catch {
      // já saiu
    }
  }
  await Promise.all(pending.map((i) => i.exited));
}
