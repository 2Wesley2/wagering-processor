import { Counter, type Registry } from 'prom-client';
import type { AppLogger } from '../../../platform/observability/logger.ts';
import type { ReconciliationIssue, ReconciliationObserver } from '../application/ports.ts';

/** Divergência de reconciliação: log de aviso + métrica (§9, §12). Nada é corrigido. */
export class LoggingReconciliationObserver implements ReconciliationObserver {
  private readonly counter: Counter<'issue'>;

  constructor(
    private readonly logger: AppLogger,
    registry: Registry,
  ) {
    this.counter = new Counter({
      name: 'wallet_reconciliation_divergence_total',
      help: 'Divergências encontradas pela reconciliação, por tipo',
      labelNames: ['issue'],
      registers: [registry],
    });
  }

  divergence(walletId: string, issues: readonly ReconciliationIssue[]): void {
    for (const issue of issues) this.counter.inc({ issue });
    this.logger.warn({ event: 'reconciliation.divergence', walletId, issues }, 'reconciliation.divergence');
  }
}
