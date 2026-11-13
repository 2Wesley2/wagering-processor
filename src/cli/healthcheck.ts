/**
 * Healthcheck sem curl: usado pelo compose (--quiet) e pelo README
 * (`docker compose exec app-1 bun run healthcheck`).
 */
interface Probe {
  readonly status: number;
  readonly body: unknown;
}

async function get(port: string, path: string): Promise<Probe> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2000) });
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

export async function healthcheckMain(quiet: boolean): Promise<number> {
  const port = process.env['PORT'] ?? '3000';
  try {
    const live = await get(port, '/health/live');
    const ready = await get(port, '/health/ready');
    if (!quiet) process.stdout.write(`${JSON.stringify({ live, ready }, null, 2)}\n`);
    return live.status === 200 && ready.status === 200 ? 0 : 1;
  } catch (error) {
    if (!quiet) process.stderr.write(`healthcheck falhou: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  healthcheckMain(process.argv.includes('--quiet')).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
