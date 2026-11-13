import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Cluster, startCluster } from '../support/cluster.ts';
import { eventually } from '../support/eventually.ts';
import { writeEvidence } from '../support/evidence.ts';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { field } from '../support/http.ts';
import { invariantIssues, openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * CT-13: hot wallet saturando o pool (2 conexões por instância). Sem deadlock e sem erro
 * interno: cada requisição é aplicada ou recebe 503 retentável (a espera pelo pool é limitada
 * por DB_CONNECT_TIMEOUT_MS — contrapressão, não falha). O health continua respondendo pela
 * conexão dedicada, e o reenvio com a mesma key aplica cada aposta exatamente uma vez.
 */
let fixture: Fixture;
let cluster: Cluster;

beforeAll(async () => {
  fixture = await createFixture('ct13');
  cluster = await startCluster(fixture, 'ct13', { env: { DB_POOL_MAX: '2' } });
});
afterAll(async () => {
  expect(await invariantIssues(fixture.database)).toEqual([]);
  await fixture.dispose();
});

const TRANSIENT_CODES = new Set(['DATABASE_UNAVAILABLE', 'CONCURRENCY_CONFLICT']);

describe('[CT-13] hot wallet saturando o pool', () => {
  test('[CT-13] 90 apostas simultâneas com pool 2: 200 ou 503 retentável, health 200; reenvio fecha em 90 débitos', async () => {
    const wallet = await openWallet(cluster.next().baseUrl, '1000.00');
    const bodies = Array.from({ length: 90 }, () => submission(wallet, { amount: '1.00' }));
    let loadDone = false;
    const load = Promise.all(bodies.map((body, index) => send(cluster.at(index).baseUrl, body))).finally(() => {
      loadDone = true;
    });
    const healthStatuses: number[] = [];
    while (!loadDone) {
      for (const instance of cluster.instances) {
        for (const path of ['/health/live', '/health/ready']) {
          const response = await fetch(`${instance.baseUrl}${path}`, { signal: AbortSignal.timeout(3000) });
          healthStatuses.push(response.status);
        }
      }
      await Bun.sleep(50);
    }
    const responses = await load;
    const outcomes = responses.map((response) =>
      response.status === 200
        ? 'applied'
        : `${response.status}:${String(field(response.body, 'code'))}:${String(field(response.body, 'retryable'))}`,
    );
    const transient = responses
      .map((response, index) => ({ response, body: bodies[index] }))
      .filter(({ response }) => response.status !== 200);
    for (const { response } of transient) {
      expect(response.status).toBe(503);
      expect(TRANSIENT_CODES.has(String(field(response.body, 'code')))).toBe(true);
      expect(field(response.body, 'retryable')).toBe(true);
    }
    // O provedor reenvia o que recebeu 503, com a mesma key: nenhum efeito duplicado.
    for (const { body } of transient) {
      if (body === undefined) continue;
      await eventually(
        async () => {
          const retry = await send(cluster.next().baseUrl, body);
          return retry.status === 200 ? retry : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 200, describe: 'reenvio da aposta que recebeu 503' },
      );
    }
    const state = await walletState(fixture.database, wallet.walletId);
    writeEvidence('CT-13', {
      applied: outcomes.filter((outcome) => outcome === 'applied').length,
      transient: [...new Set(outcomes.filter((outcome) => outcome !== 'applied'))],
      transientCount: transient.length,
      healthChecks: healthStatuses.length,
      healthStatuses: [...new Set(healthStatuses)],
      state,
    });
    expect(healthStatuses.length).toBeGreaterThan(0);
    expect([...new Set(healthStatuses)]).toEqual([200]);
    expect(state).toMatchObject({ balance: '910.00', debits: '90', version: '91', transactions: '90' });
  });
});
