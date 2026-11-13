import { type DynamicModule, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type { Registry } from 'prom-client';
import { HealthController } from './modules/health/health.controller.ts';
import type { HealthProbe } from './modules/health/probes.ts';
import type { WageringOperations } from './modules/wagering/application/wagering-service.ts';
import { WageringTransactionsController } from './modules/wagering/http/wagering-transactions.controller.ts';
import type { WalletOperations } from './modules/wallet/application/wallet-service.ts';
import { WalletsController } from './modules/wallet/http/wallets.controller.ts';
import type { AppConfig } from './platform/config/config.ts';
import { AuthGuard, type AuthenticationPort } from './platform/http/authentication.ts';
import { ProblemDetailsFilter } from './platform/http/problem-details.ts';
import { TestFaultController } from './platform/http/test-fault.controller.ts';
import type { FaultInjector } from './platform/lifecycle/fault-injection.ts';
import type { ReadinessState } from './platform/lifecycle/readiness.ts';
import type { AppLogger } from './platform/observability/logger.ts';
import { MetricsController } from './platform/observability/metrics.ts';
import {
  APP_CONFIG,
  AUTHENTICATION,
  FAULT_INJECTOR,
  LOGGER,
  METRICS_REGISTRY,
  PG_PROBE,
  READINESS,
  SQS_PROBE,
  WAGERING_SERVICE,
  WALLET_SERVICE,
} from './platform/tokens.ts';

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: AppLogger;
  readonly readiness: ReadinessState;
  readonly pgProbe: HealthProbe;
  readonly sqsProbe: HealthProbe;
  readonly faultInjector: FaultInjector;
  readonly metrics: Registry;
  readonly walletService: WalletOperations;
  readonly wageringService: WageringOperations;
  readonly authentication: AuthenticationPort;
}

/**
 * Raiz de composição. F3: health, métricas, wallets, transações (submissão e consultas), guard de
 * autenticação (no-op) e a rota de autoteste (só em teste). Dependências chegam prontas.
 */
@Module({})
export class AppModule {
  static forRoot(dependencies: AppDependencies): DynamicModule {
    // Boot por papel (D01): sem o papel `api`, só health e métricas respondem.
    const controllers: Type<unknown>[] = [HealthController, MetricsController];
    if (dependencies.config.roles.has('api')) controllers.push(WalletsController, WageringTransactionsController);
    if (dependencies.config.nodeEnv === 'test') controllers.push(TestFaultController);
    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: APP_CONFIG, useValue: dependencies.config },
        { provide: LOGGER, useValue: dependencies.logger },
        { provide: READINESS, useValue: dependencies.readiness },
        { provide: PG_PROBE, useValue: dependencies.pgProbe },
        { provide: SQS_PROBE, useValue: dependencies.sqsProbe },
        { provide: FAULT_INJECTOR, useValue: dependencies.faultInjector },
        { provide: METRICS_REGISTRY, useValue: dependencies.metrics },
        { provide: WALLET_SERVICE, useValue: dependencies.walletService },
        { provide: WAGERING_SERVICE, useValue: dependencies.wageringService },
        { provide: AUTHENTICATION, useValue: dependencies.authentication },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
