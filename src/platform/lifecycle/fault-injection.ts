import { writeSync } from 'node:fs';
import type { AppConfig, FaultPlanEntry, FaultPoint } from '../config/config.ts';

export interface FaultContext {
  readonly messageId?: string;
  readonly eventId?: string;
}

/** Porta de injeção de falhas (D47). Em produção é sempre o Noop. */
export interface FaultInjector {
  readonly enabled: boolean;
  hit(point: FaultPoint, context?: FaultContext): Promise<void>;
}

export class FaultInjectedError extends Error {
  constructor(readonly point: FaultPoint) {
    super(`falha injetada em ${point}`);
    this.name = 'FaultInjectedError';
  }
}

export class NoopFaultInjector implements FaultInjector {
  readonly enabled = false;

  hit(): Promise<void> {
    return Promise.resolve();
  }
}

function matches(entry: FaultPlanEntry, context: FaultContext): boolean {
  if (entry.match === undefined) return true;
  if (entry.match.messageId !== undefined && entry.match.messageId !== context.messageId) return false;
  if (entry.match.eventId !== undefined && entry.match.eventId !== context.eventId) return false;
  return true;
}

/**
 * Executa o FAULT_PLAN. Antes de agir, grava o marcador `fault.injected` com
 * writeSync no stdout: é a evidência (1) de que a queda foi provocada (D47).
 */
export class PlanFaultInjector implements FaultInjector {
  readonly enabled = true;

  /** Entradas `failOnce` que já falharam (a próxima passagem pelo ponto segue normal). */
  private readonly spent = new Set<FaultPlanEntry>();

  constructor(
    private readonly plan: readonly FaultPlanEntry[],
    private readonly instanceId: string,
  ) {}

  async hit(point: FaultPoint, context: FaultContext = {}): Promise<void> {
    const entry = this.plan.find(
      (candidate) => candidate.point === point && matches(candidate, context) && !this.spent.has(candidate),
    );
    if (entry === undefined) return;
    const marker = {
      level: 'warn',
      time: new Date().toISOString(),
      event: 'fault.injected',
      point,
      action: entry.action,
      instance: this.instanceId,
      pid: process.pid,
      ...context,
    };
    writeSync(1, `${JSON.stringify(marker)}\n`);
    switch (entry.action) {
      case 'kill':
        process.kill(process.pid, 'SIGKILL');
        // O processo morre aqui; a promise nunca resolve.
        await new Promise<never>(() => undefined);
        return;
      case 'pause':
        // Segura o fluxo até SIGUSR2 (retomar) — usado para observar a tx aberta.
        await new Promise<void>((resolve) => process.once('SIGUSR2', () => resolve()));
        return;
      case 'fail':
        throw new FaultInjectedError(point);
      case 'failOnce':
        this.spent.add(entry);
        throw new FaultInjectedError(point);
    }
  }
}

export function createFaultInjector(config: AppConfig): FaultInjector {
  if (config.nodeEnv === 'test' && config.fault.enabled) {
    return new PlanFaultInjector(config.fault.plan, config.instanceId);
  }
  return new NoopFaultInjector();
}
