export type LogEntry = Record<string, unknown> & { event?: string; level?: string };

/** Logs JSON de uma instância filha; linhas não JSON reprovam o requisito de log (§12). */
export class LogBook {
  readonly entries: LogEntry[] = [];
  readonly nonJson: string[] = [];
  private readonly waiters: { event: string; resolve: (entry: LogEntry) => void }[] = [];

  push(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.nonJson.push(trimmed);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.nonJson.push(trimmed);
      return;
    }
    if (!isLogEntry(parsed)) {
      this.nonJson.push(trimmed);
      return;
    }
    const entry = parsed;
    this.entries.push(entry);
    for (const waiter of [...this.waiters]) {
      if (entry.event === waiter.event) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(entry);
      }
    }
  }

  events(): string[] {
    return this.entries.map((entry) => entry.event).filter((entry): entry is string => typeof entry === 'string');
  }

  find(event: string): LogEntry | undefined {
    return this.entries.find((entry) => entry.event === event);
  }

  waitFor(event: string, timeoutMs: number): Promise<LogEntry> {
    const existing = this.find(event);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`log "${event}" não apareceu em ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        event,
        resolve: (entry) => {
          clearTimeout(timer);
          resolve(entry);
        },
      });
    });
  }
}

/** `event` e `level`, quando presentes, precisam ser strings. */
function isLogEntry(value: object): value is LogEntry {
  const event = 'event' in value ? value.event : undefined;
  const level = 'level' in value ? value.level : undefined;
  return (event === undefined || typeof event === 'string') && (level === undefined || typeof level === 'string');
}
