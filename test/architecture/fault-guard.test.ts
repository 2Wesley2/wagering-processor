import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from '../../src/platform/config/config.ts';
import { createFaultInjector, NoopFaultInjector } from '../../src/platform/lifecycle/fault-injection.ts';

const base = {
  DATABASE_URL: 'postgres://u:p@db:5432/x',
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- endpoint local de teste; o MiniStack e o nginx do Compose não usam TLS
  SQS_ENDPOINT: 'http://sqs:4566',
  SQS_WAIT_TIME_S: '1',
  SHUTDOWN_DRAIN_MS: '5000',
  SHUTDOWN_HARD_TIMEOUT_MS: '8000',
};

function code(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return 'ok';
  } catch (error) {
    if (error instanceof ConfigError) return error.code;
    throw error;
  }
}

describe('[QG-06] o injetor de falhas recusa produção', () => {
  test('[QG-06] FAULT_* fora de NODE_ENV=test aborta a configuração', () => {
    for (const nodeEnv of ['production', 'development']) {
      expect(code({ ...base, NODE_ENV: nodeEnv, FAULT_INJECTION: 'enabled' })).toBe('config.fault_injection_forbidden');
      expect(code({ ...base, NODE_ENV: nodeEnv, FAULT_PLAN: '[]' })).toBe('config.fault_injection_forbidden');
    }
    // Sem NODE_ENV o padrão é produção.
    expect(code({ ...base, FAULT_INJECTION: 'enabled' })).toBe('config.fault_injection_forbidden');
  });

  test('[QG-06] mesmo em teste exige a segunda chave e valores válidos', () => {
    expect(code({ ...base, NODE_ENV: 'test', FAULT_PLAN: '[]' })).toBe('config.fault_plan_requires_enable');
    expect(code({ ...base, NODE_ENV: 'test', FAULT_INJECTION: 'yes' })).toBe('config.invalid_fault_injection');
    expect(
      code({ ...base, NODE_ENV: 'test', FAULT_INJECTION: 'enabled', FAULT_PLAN: '[{"point":"nope","action":"kill"}]' }),
    ).toBe('config.invalid_fault_plan');
  });

  test('[QG-06] sem as duas chaves o injetor é Noop', () => {
    expect(createFaultInjector(loadConfig({ ...base, NODE_ENV: 'test' }))).toBeInstanceOf(NoopFaultInjector);
    expect(createFaultInjector(loadConfig({ ...base }))).toBeInstanceOf(NoopFaultInjector);
    expect(createFaultInjector(loadConfig({ ...base, NODE_ENV: 'test', FAULT_INJECTION: 'enabled' })).enabled).toBe(
      true,
    );
  });

  test('[QG-06] a imagem runtime fixa NODE_ENV=production', async () => {
    const dockerfile = await Bun.file('Dockerfile').text();
    const runtime = dockerfile.split(/^FROM /m).find((stage) => /\bAS runtime\b/.test(stage)) ?? '';
    expect(runtime).toMatch(/^ENV NODE_ENV=production$/m);
  });
});
