import { adminUrl } from './db.ts';

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly text: string;
}

/** Chamada HTTP de teste: devolve status, headers e corpo (JSON quando possível). */
export async function api(
  base: string,
  method: string,
  path: string,
  options: { json?: unknown; raw?: string; headers?: Record<string, string> } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] ??= 'application/json';
  } else if (options.raw !== undefined) {
    body = options.raw;
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // corpo não JSON
  }
  return { status: response.status, headers: response.headers, body: parsed, text };
}

export function field(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const value: unknown = Reflect.get(body, name);
  return value;
}

/** Campo string obrigatório de um corpo JSON; falha o teste se faltar ou tiver outro tipo. */
export function stringField(body: unknown, name: string): string {
  const value = field(body, name);
  if (typeof value !== 'string') throw new Error(`campo "${name}" ausente ou não é string`);
  return value;
}

/** URL do superusuário apontando para um banco de teste (para fabricar estados impossíveis). */
export function adminDbUrl(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}
