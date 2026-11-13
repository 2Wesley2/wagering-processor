import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { AppConfig } from '../../platform/config/config.ts';
import { Public } from '../../platform/http/authentication.ts';
import type { ReadinessState } from '../../platform/lifecycle/readiness.ts';
import { APP_CONFIG, PG_PROBE, READINESS, SQS_PROBE } from '../../platform/tokens.ts';
import type { HealthProbe, ProbeStatus } from './probes.ts';

interface StatusResponse {
  status(code: number): unknown;
}

/** Health checks públicos (§9, §2): live não consulta dependências; ready sim. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(READINESS) private readonly readiness: ReadinessState,
    @Inject(PG_PROBE) private readonly pg: HealthProbe,
    @Inject(SQS_PROBE) private readonly sqs: HealthProbe,
  ) {}

  @Get('live')
  live(): { status: string; instance: string; uptimeS: number } {
    return { status: 'ok', instance: this.config.instanceId, uptimeS: Math.floor(process.uptime()) };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<{
    status: string;
    instance: string;
    draining: boolean;
    checks: { postgres: ProbeStatus | 'skipped'; sqs: ProbeStatus | 'skipped' };
  }> {
    const draining = this.readiness.isDraining();
    const [postgres, sqs]: [ProbeStatus | 'skipped', ProbeStatus | 'skipped'] = draining
      ? ['skipped', 'skipped']
      : await Promise.all([this.pg.check(), this.sqs.check()]);
    const ok = !draining && postgres === 'up' && sqs === 'up';
    response.status(ok ? 200 : 503);
    return {
      status: ok ? 'ready' : 'not_ready',
      instance: this.config.instanceId,
      draining,
      checks: { postgres, sqs },
    };
  }
}
