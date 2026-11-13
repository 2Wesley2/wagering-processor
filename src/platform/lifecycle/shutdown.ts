import type { INestApplication } from '@nestjs/common';
import type { AppConfig } from '../config/config.ts';
import type { AppLogger } from '../observability/logger.ts';
import type { ReadinessState } from './readiness.ts';

export type Closer = () => Promise<void>;

export interface ShutdownDependencies {
  readonly app: INestApplication;
  readonly config: AppConfig;
  readonly logger: AppLogger;
  readonly readiness: ReadinessState;
  /**
   * Drenagem antes do HTTP (D37): consumidor (para de pedir mensagens, conclui ou devolve as em
   * voo), publicador da outbox e worker de pendências.
   */
  readonly drainers: readonly Closer[];
  /** Fecha recursos de I/O (banco, clientes) depois do HTTP. */
  readonly closers: readonly Closer[];
}

/**
 * Coordenador único de encerramento (D37). Ordem:
 * readiness 503 → parar polls, drenar, devolver visibilidade → HTTP → banco → exit 0.
 * Um watchdog força exit 1 se o limite duro estourar. Sinais repetidos são ignorados.
 */
export class ShutdownCoordinator {
  private started = false;

  constructor(private readonly dependencies: ShutdownDependencies) {}

  install(): void {
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'));
    process.on('SIGINT', () => void this.shutdown('SIGINT'));
    if (this.dependencies.config.shutdown.exitOnStdinEof) {
      // Harness de testes: se o processo pai morrer, o stdin fecha e a instância sai.
      process.stdin.on('end', () => void this.shutdown('stdin_eof'));
      process.stdin.resume();
    }
  }

  private async withinDeadline(close: Closer, timeoutMs: number): Promise<void> {
    const finished = await Promise.race([close().then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      this.dependencies.logger.warn({ event: 'shutdown.close_timeout', timeoutMs }, 'shutdown.close_timeout');
    }
  }

  async shutdown(reason: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { app, config, logger, readiness, drainers, closers } = this.dependencies;
    const startedAt = Date.now();

    const watchdog = setTimeout(() => {
      logger.fatal({ event: 'shutdown.hard_timeout', limitMs: config.shutdown.hardTimeoutMs }, 'shutdown.hard_timeout');
      logger.flush();
      process.exit(1);
    }, config.shutdown.hardTimeoutMs);

    try {
      logger.info({ event: 'shutdown.signal_received', reason }, 'shutdown.signal_received');
      readiness.startDraining();
      logger.info({ event: 'readiness.off' }, 'readiness.off');
      if (config.shutdown.readinessDrainDelayMs > 0) await Bun.sleep(config.shutdown.readinessDrainDelayMs);

      for (const drain of drainers) await drain();

      await app.close();
      logger.info({ event: 'http.closed' }, 'http.closed');

      // Cada fechamento tem prazo: uma transação devolvida na drenagem (mensagem já de volta à fila,
      // nada comitado) ainda segura uma conexão; ela cai com o processo, sem esperar o pool.
      for (const close of closers) await this.withinDeadline(close, config.shutdown.closeTimeoutMs);
      logger.info({ event: 'db.closed' }, 'db.closed');

      logger.info({ event: 'shutdown.complete', exitCode: 0, durationMs: Date.now() - startedAt }, 'shutdown.complete');
      logger.flush();
      clearTimeout(watchdog);
      process.exit(0);
    } catch (error) {
      logger.fatal(
        { event: 'shutdown.failed', error: error instanceof Error ? error.message : String(error) },
        'shutdown.failed',
      );
      logger.flush();
      process.exit(1);
    }
  }
}
