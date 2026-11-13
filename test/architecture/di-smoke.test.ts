import { describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.ts';
import type { HealthProbe } from '../../src/modules/health/probes.ts';
import type { WageringOperations } from '../../src/modules/wagering/application/wagering-service.ts';
import type { WalletOperations } from '../../src/modules/wallet/application/wallet-service.ts';
import { NoopAuthentication } from '../../src/platform/http/authentication.ts';
import { loadConfig } from '../../src/platform/config/config.ts';
import { NoopFaultInjector } from '../../src/platform/lifecycle/fault-injection.ts';
import { ReadinessState } from '../../src/platform/lifecycle/readiness.ts';
import { createLogger } from '../../src/platform/observability/logger.ts';
import { createMetricsRegistry } from '../../src/platform/observability/metrics.ts';

/**
 * QG-05: o container de DI do NestJS 12 resolve o grafo da F0 sob Bun
 * (decorators + emitDecoratorMetadata + reflect-metadata). As sondas são
 * substituídas por stubs: aqui só a injeção é verificada, não PG/SQS.
 */
describe('[QG-05] smoke de DI', () => {
  test('[QG-05] AppModule resolve controllers e responde /health/live e /health/ready', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      INSTANCE_ID: 'di-smoke',
      PORT: '0',
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
      SQS_ENDPOINT: 'http://127.0.0.1:1',
      SQS_WAIT_TIME_S: '1',
      SHUTDOWN_DRAIN_MS: '5000',
      SHUTDOWN_HARD_TIMEOUT_MS: '8000',
    });
    const logger = createLogger({ level: 'fatal', instanceId: 'di-smoke', roles: ['api'], sync: true });
    const up: HealthProbe = { check: () => Promise.resolve('up') };
    const notUsed = () => Promise.reject(new Error('não usado no smoke de DI'));
    const unusedWalletOperations: WalletOperations = {
      open: notUsed,
      get: notUsed,
      ledger: notUsed,
      reconcile: notUsed,
    };
    const unusedWageringOperations: WageringOperations = {
      submit: notUsed,
      getById: notUsed,
      getByProvider: notUsed,
    };
    const app = await NestFactory.create(
      AppModule.forRoot({
        config,
        logger,
        readiness: new ReadinessState(),
        pgProbe: up,
        sqsProbe: up,
        faultInjector: new NoopFaultInjector(),
        metrics: createMetricsRegistry('di-smoke', 'test'),
        walletService: unusedWalletOperations,
        wageringService: unusedWageringOperations,
        authentication: new NoopAuthentication(),
      }),
      { logger: false },
    );
    try {
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      const base = url.replace('[::1]', '127.0.0.1');
      const live = await fetch(`${base}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: 'ok' });
      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);
      // Rota de autoteste existe em NODE_ENV=test e, com o Noop, não faz nada.
      const fault = await fetch(`${base}/__test/fault/selfcheck.probe`, { method: 'POST' });
      expect(fault.status).toBe(204);
    } finally {
      await app.close();
    }
  });
});
