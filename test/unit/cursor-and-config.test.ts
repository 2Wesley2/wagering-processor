import { describe, expect, test } from 'bun:test';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  InvalidCursorError,
  parseLedgerLimit,
} from '../../src/modules/wallet/application/ledger-cursor.ts';
import { ConfigError, loadConfig } from '../../src/platform/config/config.ts';

describe('[UT-12] cursor opaco do ledger', () => {
  test('[UT-12] ida e volta; base64url sem padding', () => {
    const cursor = encodeLedgerCursor('w-1', 50);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeLedgerCursor(cursor, 'w-1')).toBe(50);
  });

  test('[UT-12] cursor de outra wallet, adulterado ou fora do formato → INVALID_CURSOR', () => {
    const cursor = encodeLedgerCursor('w-1', 50);
    const bad = [
      () => decodeLedgerCursor(cursor, 'w-2'),
      () => decodeLedgerCursor('não-base64!', 'w-1'),
      () => decodeLedgerCursor(Buffer.from('{"v":2,"w":"w-1","s":1}').toString('base64url'), 'w-1'),
      () => decodeLedgerCursor(Buffer.from('{"v":1,"w":"w-1","s":-1}').toString('base64url'), 'w-1'),
      () => decodeLedgerCursor(Buffer.from('{"v":1,"w":"w-1","s":1.5}').toString('base64url'), 'w-1'),
      () => decodeLedgerCursor(Buffer.from('[]').toString('base64url'), 'w-1'),
    ];
    for (const attempt of bad) expect(attempt).toThrow(InvalidCursorError);
  });

  test('[UT-12] limit: padrão 50, faixa 1..200', () => {
    expect(parseLedgerLimit(undefined)).toBe(50);
    expect(parseLedgerLimit('200')).toBe(200);
    for (const raw of ['0', '201', '-1', '1.5', 'abc', ''])
      expect(() => parseLedgerLimit(raw)).toThrow(InvalidCursorError);
  });
});

// eslint-disable-next-line sonarjs/no-clear-text-protocols -- endpoint local de teste; o MiniStack e o nginx do Compose não usam TLS
const baseEnv = { DATABASE_URL: 'postgres://u:p@db:5432/x', SQS_ENDPOINT: 'http://sqs:4566' };

function configCode(env: Record<string, string>): string {
  try {
    loadConfig(env);
    return 'ok';
  } catch (error) {
    if (error instanceof ConfigError) return error.code;
    throw error;
  }
}

describe('[UT-13] configuração e tabela de tempos validadas no boot', () => {
  test('[UT-13] padrões de produção da tabela de tempos', () => {
    const config = loadConfig(baseEnv);
    expect(config.nodeEnv).toBe('production');
    expect(config.sqs).toMatchObject({ waitTimeS: 10, visibilityTimeoutS: 30, maxReceiveCount: 8 });
    expect(config.shutdown).toMatchObject({ drainMs: 20_000, hardTimeoutMs: 30_000 });
    expect([...config.roles].sort((left, right) => left.localeCompare(right))).toEqual([
      'api',
      'consumer',
      'outbox-publisher',
      'pending-reference-worker',
    ]);
    expect(config.fault.enabled).toBe(false);
  });

  test('[UT-13] tabela de teste é aceita', () => {
    expect(
      configCode({
        ...baseEnv,
        NODE_ENV: 'test',
        SQS_WAIT_TIME_S: '1',
        SQS_VISIBILITY_TIMEOUT_S: '3',
        SHUTDOWN_DRAIN_MS: '5000',
        SHUTDOWN_HARD_TIMEOUT_MS: '8000',
      }),
    ).toBe('ok');
  });

  test('[UT-13] Wait ≥ drain ou drain ≥ limite duro é recusado', () => {
    expect(configCode({ ...baseEnv, SQS_WAIT_TIME_S: '20', SHUTDOWN_DRAIN_MS: '20000' })).toBe('config.invalid_timing');
    expect(configCode({ ...baseEnv, SHUTDOWN_DRAIN_MS: '30000', SHUTDOWN_HARD_TIMEOUT_MS: '30000' })).toBe(
      'config.invalid_timing',
    );
  });

  test('[UT-13] valores inválidos são recusados com código estável', () => {
    expect(configCode({ ...baseEnv, APP_ROLES: 'api,miner' })).toBe('config.invalid_roles');
    expect(configCode({ ...baseEnv, DATABASE_URL: 'mysql://x' })).toBe('config.invalid');
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- endpoint local de teste; o MiniStack e o nginx do Compose não usam TLS
    expect(configCode({ SQS_ENDPOINT: 'http://sqs:4566' })).toBe('config.invalid');
    expect(configCode({ ...baseEnv, PORT: '70000' })).toBe('config.invalid');
  });
});
