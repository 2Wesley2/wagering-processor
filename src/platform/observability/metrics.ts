import { Controller, Get, Inject, Res } from '@nestjs/common';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { Public } from '../http/authentication.ts';
import { METRICS_REGISTRY } from '../tokens.ts';

/**
 * Registro de métricas por processo (D42). No Bun as default metrics são
 * parciais (sem eventos de GC); falha delas não pode impedir o boot.
 */
export function createMetricsRegistry(instanceId: string, version: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ instance: instanceId });
  try {
    collectDefaultMetrics({ register: registry });
  } catch {
    // Métricas default indisponíveis neste runtime: seguimos só com as explícitas.
  }
  const info = new Gauge({
    name: 'app_info',
    help: 'Informações da instância',
    labelNames: ['version'],
    registers: [registry],
  });
  info.set({ version }, 1);
  return registry;
}

interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
}

/** /metrics fica só na rede interna (o nginx bloqueia), sem autenticação. */
@Public()
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get('metrics')
  async metrics(@Res({ passthrough: true }) response: HeaderResponse): Promise<string> {
    response.setHeader('Content-Type', this.registry.contentType);
    return this.registry.metrics();
  }
}
