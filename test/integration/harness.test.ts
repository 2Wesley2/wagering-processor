import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { z } from 'zod';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { closeStdin, signal, startInstance, waitReady } from '../support/instances.ts';
import { assertTestDbName, assertTestQueueName } from '../support/run-context.ts';

let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture('it32');
});

afterAll(async () => {
  await fixture.dispose();
});

describe('[IT-32] guardas do harness', () => {
  test('[IT-32] FAULT_INJECTION fora de NODE_ENV=test aborta o boot com exit 1', async () => {
    const instance = startInstance({
      id: 'it32-prod-fault',
      env: fixture.env({ NODE_ENV: 'production', FAULT_INJECTION: 'enabled' }),
    });
    const exit = await instance.exited;
    expect(exit.exitCode).toBe(1);
    expect(instance.logs.events()).toContain('config.fault_injection_forbidden');
  });

  test('[IT-32] sem FAULT_INJECTION o injetor é Noop: o ponto de autoteste não faz nada', async () => {
    const instance = startInstance({ id: 'it32-noop', env: fixture.env() });
    await waitReady(instance);
    const response = await fetch(`${instance.baseUrl}/__test/fault/selfcheck.probe`, { method: 'POST' });
    expect(response.status).toBe(204);
    expect(instance.logs.find('fault.injected')).toBeUndefined();
    const ready = await instance.logs.waitFor('app.ready', 1000);
    expect(ready['faultInjection']).toBe(false);
    signal(instance, 'SIGTERM');
    expect((await instance.exited).exitCode).toBe(0);
  });

  test('[IT-32] queda autoinfligida: marcador + SIGKILL + nenhum kill do harness', async () => {
    const instance = startInstance({
      id: 'it32-kill',
      env: fixture.env({
        FAULT_INJECTION: 'enabled',
        FAULT_PLAN: JSON.stringify([{ point: 'selfcheck.probe', match: { messageId: 'm-1' }, action: 'kill' }]),
      }),
    });
    await waitReady(instance);
    // messageId diferente: o filtro não casa e nada acontece.
    expect(
      (await fetch(`${instance.baseUrl}/__test/fault/selfcheck.probe?messageId=other`, { method: 'POST' })).status,
    ).toBe(204);
    await fetch(`${instance.baseUrl}/__test/fault/selfcheck.probe?messageId=m-1`, { method: 'POST' }).catch(
      () => undefined,
    );
    const exit = await instance.exited;
    const marker = instance.logs.find('fault.injected');
    writeEvidence('IT-32-kill', { exit, marker, killLog: instance.killLog, nonJson: instance.logs.nonJson });
    expect(marker).toBeDefined();
    expect(marker?.['point']).toBe('selfcheck.probe');
    expect(exit.signalCode).toBe('SIGKILL');
    expect(exit.exitCode).toBeNull();
    expect(instance.killLog).toEqual([]);
  });

  test('[IT-32] SIGTERM: ready=503 e live=200 durante a drenagem; ordem dos logs; exit 0', async () => {
    const instance = startInstance({ id: 'it32-term', env: fixture.env({ READINESS_DRAIN_DELAY_MS: '1500' }) });
    await waitReady(instance);
    signal(instance, 'SIGTERM');
    await instance.logs.waitFor('readiness.off', 3000);
    const ready = await fetch(`${instance.baseUrl}/health/ready`);
    const live = await fetch(`${instance.baseUrl}/health/live`);
    const exit = await instance.exited;
    const order = instance.logs
      .events()
      .filter((entry) =>
        ['shutdown.signal_received', 'readiness.off', 'http.closed', 'db.closed', 'shutdown.complete'].includes(entry),
      );
    writeEvidence('IT-32-sigterm', { readyStatus: ready.status, liveStatus: live.status, order, exit });
    expect(ready.status).toBe(503);
    expect(live.status).toBe(200);
    expect(order).toEqual([
      'shutdown.signal_received',
      'readiness.off',
      'http.closed',
      'db.closed',
      'shutdown.complete',
    ]);
    expect(exit.exitCode).toBe(0);
    expect(instance.logs.nonJson).toEqual([]);
  });

  test('[IT-32] fim do stdin (morte do pai) encerra a instância: sem órfãos', async () => {
    const instance = startInstance({ id: 'it32-orphan', env: fixture.env() });
    await waitReady(instance);
    await closeStdin(instance);
    const exit = await instance.exited;
    expect(exit.exitCode).toBe(0);
    expect(instance.logs.find('shutdown.signal_received')?.['reason']).toBe('stdin_eof');
  });

  test('[IT-32] guardas de nome recusam recursos fora do padrão de teste', () => {
    expect(() => assertTestDbName('wagering')).toThrow();
    expect(() => assertTestDbName('postgres')).toThrow();
    expect(() => assertTestQueueName('wager-transactions.fifo')).toThrow();
    expect(() => assertTestQueueName('wagering-events.fifo')).toThrow();
  });

  test('[IT-32] o serviço tests depende só do PG e do MiniStack de teste', async () => {
    const composeSchema = z.object({
      services: z.record(
        z.string(),
        z.object({
          depends_on: z.record(z.string(), z.unknown()).optional(),
          profiles: z.array(z.string()).optional(),
        }),
      ),
    });
    const compose = composeSchema.parse(parse(await Bun.file('docker-compose.yml').text()));
    const tests = compose.services['tests'];
    expect(tests?.profiles).toEqual(['test']);
    expect(Object.keys(tests?.depends_on ?? {}).sort((left, right) => left.localeCompare(right))).toEqual([
      'ministack-test',
      'postgres-test',
    ]);
  });
});
