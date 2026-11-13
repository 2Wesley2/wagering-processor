import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createFixture, type Fixture } from '../support/fixture.ts';
import { adminDbUrl } from '../support/http.ts';
import { type Instance, startInstance, waitReady } from '../support/instances.ts';
import { runCli } from '../support/messaging.ts';
import { withClient } from '../support/sql-fixtures.ts';
import { openWallet, send, submission, walletState } from '../support/wagering.ts';

/**
 * IT-17 (`bun run verify`): invariantes do sistema inteiro, somente leitura, usado nos runbooks
 * de queda (V7, V9c). Consistente → exit 0; uma divergência fabricada pelo superusuário → exit 1
 * com a wallet apontada, e nada é corrigido. (Este arquivo termina com um estado inválido de
 * propósito: o verificador global não roda no afterAll.)
 */
let fixture: Fixture;
let app: Instance;

beforeAll(async () => {
  fixture = await createFixture('verify');
  app = startInstance({ id: 'verify-api', env: fixture.env() });
  await waitReady(app);
});
afterAll(async () => {
  await fixture.dispose();
});

const reportSchema = z.object({
  event: z.literal('verify.done'),
  consistent: z.boolean(),
  checks: z.number(),
  violations: z.array(z.object({ check: z.string(), subjects: z.array(z.string()) })),
  counters: z.record(z.string(), z.string()),
});

async function verify() {
  const run = await runCli(fixture, 'verify');
  return { exitCode: run.exitCode, report: reportSchema.parse(run.logs.find('verify.done')) };
}

describe('[IT-17] bun run verify', () => {
  test('[IT-17] verify: consistente → exit 0; divergência fabricada → exit 1 com a wallet, sem correção', async () => {
    const wallet = await openWallet(app.baseUrl, '100.00');
    expect((await send(app.baseUrl, submission(wallet, { amount: '10.00' }))).status).toBe(200);

    const clean = await verify();
    expect(clean.exitCode).toBe(0);
    expect(clean.report).toMatchObject({ consistent: true, violations: [] });
    expect(clean.report.counters).toMatchObject({ wallets: '1', transactions: '2', ledger_entries: '2' });

    await withClient(adminDbUrl(fixture.database), async (client) => {
      await client.query('SET session_replication_role = replica');
      await client.query('UPDATE wallets SET balance = balance + 1.00 WHERE id = $1::uuid', [wallet.walletId]);
    });
    const broken = await verify();
    expect(broken.exitCode).toBe(1);
    expect(broken.report.consistent).toBe(false);
    expect(broken.report.violations).toContainEqual({
      check: 'saldo diferente da soma do ledger',
      subjects: [wallet.walletId],
    });
    // Somente leitura: o saldo divergente continua lá.
    expect((await walletState(fixture.database, wallet.walletId)).balance).toBe('91.00');
  });
});
