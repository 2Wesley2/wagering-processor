import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import { ContextStore } from './context.ts';

export type AppLogger = Logger;

export interface LoggerOptions {
  readonly level: string;
  readonly instanceId: string;
  readonly roles: readonly string[];
  /** Em teste o destino é síncrono: um SIGKILL não pode engolir linhas anteriores. */
  readonly sync: boolean;
}

/**
 * Logs JSON no stdout, sem transports (§12, D41). Cada linha recebe o contexto de
 * correlação do AsyncLocalStorage. Campos sensíveis são removidos.
 */
export function createLogger(options: LoggerOptions): AppLogger {
  return pino(
    {
      level: options.level,
      base: { instance: options.instanceId, roles: options.roles.join(',') },
      messageKey: 'msg',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => ({ ...ContextStore.get() }),
      redact: {
        paths: ['password', '*.password', 'headers.authorization', '*.headers.authorization', 'playerId', '*.playerId'],
        remove: true,
      },
    },
    pino.destination({ fd: 1, sync: options.sync }),
  );
}

/** Adapta o logger do Nest para o pino, mantendo um único formato de log. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: AppLogger) {}

  log(message: unknown, ...optional: unknown[]): void {
    this.logger.info({ event: 'nest.log', context: this.context(optional) }, String(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    this.logger.error({ event: 'nest.error', context: this.context(optional) }, String(message));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.logger.warn({ event: 'nest.warn', context: this.context(optional) }, String(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.logger.debug({ event: 'nest.debug', context: this.context(optional) }, String(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.logger.trace({ event: 'nest.verbose', context: this.context(optional) }, String(message));
  }

  private context(optional: unknown[]): string | undefined {
    const last = optional[optional.length - 1];
    return typeof last === 'string' ? last : undefined;
  }
}

/** Linha de log fatal síncrona, para falhas antes de o logger existir. */
export function writeFatalLine(event: string, message: string): void {
  process.stdout.write(`${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), event, msg: message })}\n`);
}
