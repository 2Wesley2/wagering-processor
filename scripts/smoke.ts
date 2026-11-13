/**
 * Smoke da stack através do nginx.
 *   --level health  (V2a, a partir da F0): /health/live e /health/ready via LB e
 *                   pelo menos 2 X-Instance-Id distintos. Somente leitura.
 *   --level full    (V2b, a partir da F3): health + fluxo de negócio pelo LB — cria uma wallet
 *                   PRÓPRIA (playerId novo a cada execução), BET, WIN referenciando a BET, replay
 *                   da BET (mesmo código e corpo), as duas consultas de transação e a
 *                   reconciliação. Valores esperados fixos. Não apaga nada: cada execução deixa
 *                   uma wallet de demonstração (o ledger é imutável por desenho).
 * Uso: docker compose run --rm --no-deps tests bun run test:smoke --level full
 */
export {};

const level = process.argv.includes('--level') ? process.argv[process.argv.indexOf('--level') + 1] : 'health';
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- endpoint local de teste; o MiniStack e o nginx do Compose não usam TLS
const base = process.env['STACK_URL'] ?? 'http://nginx';

if (level !== 'health' && level !== 'full') {
  console.error(`nível desconhecido: "${level}" (use health ou full)`);
  process.exit(2);
}

const instances = new Map<string, number>();
const failures: string[] = [];

function countInstance(response: Response): string {
  const instance = response.headers.get('x-instance-id') ?? '<sem header>';
  instances.set(instance, (instances.get(instance) ?? 0) + 1);
  return instance;
}

async function checkHealth(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    for (const path of ['/health/live', '/health/ready']) {
      try {
        const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) });
        const instance = countInstance(response);
        if (response.status !== 200) failures.push(`${path} → ${response.status} (${instance})`);
      } catch (error) {
        failures.push(`${path} → ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

async function call(
  method: string,
  path: string,
  json?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: json === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    signal: AbortSignal.timeout(10_000),
  });
  countInstance(response);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // corpo não JSON: fica como texto no relatório
  }
  return { status: response.status, body };
}

function read(body: unknown, name: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const value: unknown = Reflect.get(body, name);
  return value;
}

function expectEqual(step: string, actual: unknown, expected: unknown): void {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText === expectedText) {
    console.log(`  ok    ${step}`);
    return;
  }
  failures.push(`${step}: esperado ${expectedText}, obtido ${actualText}`);
  console.log(`  FALHA ${step}: esperado ${expectedText}, obtido ${actualText}`);
}

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function checkBusinessFlow(): Promise<void> {
  const run = Bun.randomUUIDv7();
  const playerId = Bun.randomUUIDv7();
  const wallet = await call('POST', '/wallets', { playerId, initialBalance: brl('100.00') });
  expectEqual(
    'POST /wallets → 201, saldo 100.00, versão 1',
    [wallet.status, read(wallet.body, 'balance'), read(wallet.body, 'version')],
    [201, brl('100.00'), 1],
  );
  const walletId = read(wallet.body, 'id');
  if (typeof walletId !== 'string') {
    failures.push('POST /wallets não devolveu id; fluxo interrompido');
    return;
  }

  const common = { providerId: 'provider-a', playerId, walletId, roundId: `smoke-round-${run}`, gameId: 'smoke-game' };
  const betExternalId = `smoke-bet-${run}`;
  const betBody = { ...common, externalTransactionId: betExternalId, kind: 'BET', money: brl('30.00') };
  const betKey = { 'idempotency-key': `provider-a:${betExternalId}` };
  const bet = await call('POST', '/wagering/transactions', betBody, betKey);
  expectEqual(
    'BET 30.00 → 200 PROCESSED, saldo 70.00',
    [bet.status, read(bet.body, 'status'), read(bet.body, 'balance'), read(bet.body, 'idempotentReplay')],
    [200, 'PROCESSED', brl('70.00'), false],
  );
  const betId = read(bet.body, 'transactionId');

  const winExternalId = `smoke-win-${run}`;
  const win = await call(
    'POST',
    '/wagering/transactions',
    {
      ...common,
      externalTransactionId: winExternalId,
      kind: 'WIN',
      money: brl('50.00'),
      referenceExternalTransactionId: betExternalId,
    },
    { 'idempotency-key': `provider-a:${winExternalId}` },
  );
  expectEqual(
    'WIN 50.00 referenciando a BET → 200, saldo 120.00',
    [win.status, read(win.body, 'status'), read(win.body, 'balance')],
    [200, 'PROCESSED', brl('120.00')],
  );

  const replay = await call('POST', '/wagering/transactions', betBody, betKey);
  expectEqual(
    'replay da BET → mesmo código e corpo, idempotentReplay true',
    [replay.status, replay.body],
    [bet.status, { transactionId: betId, status: 'PROCESSED', balance: brl('70.00'), idempotentReplay: true }],
  );

  const byId = await call('GET', `/wagering/transactions/${String(betId)}`);
  expectEqual(
    'GET da BET por id → PROCESSED, saldo da decisão 70.00, versão 2',
    [byId.status, read(byId.body, 'status'), read(byId.body, 'balance'), read(byId.body, 'walletVersion')],
    [200, 'PROCESSED', brl('70.00'), 2],
  );
  const byProvider = await call(
    'GET',
    `/providers/provider-a/wagering/transactions/${encodeURIComponent(betExternalId)}`,
  );
  expectEqual(
    'GET da BET por provider/externalId → mesma transação',
    [byProvider.status, read(byProvider.body, 'transactionId')],
    [200, betId],
  );

  const reconciliation = await call('POST', `/wallets/${walletId}/reconciliation`);
  expectEqual(
    'reconciliação → consistente, 120.00, 3 lançamentos',
    [
      reconciliation.status,
      read(reconciliation.body, 'consistent'),
      read(reconciliation.body, 'storedBalance'),
      read(reconciliation.body, 'checkedEntries'),
    ],
    [200, true, brl('120.00'), 3],
  );
}

console.log(`stack: ${base}`);
await checkHealth();
if (level === 'full') {
  console.log('fluxo de negócio (V2b):');
  try {
    await checkBusinessFlow();
  } catch (error) {
    failures.push(`fluxo de negócio: ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`respostas por instância: ${JSON.stringify(Object.fromEntries(instances))}`);
const distinct = [...instances.keys()].filter((instanceName) => instanceName !== '<sem header>').length;
if (failures.length > 0) console.log(`falhas (${failures.length}):\n  ${failures.slice(0, 20).join('\n  ')}`);
const ok = failures.length === 0 && distinct >= 2;
console.log(`SMOKE ${level}: ${ok ? 'OK' : 'FALHOU'} (instâncias distintas: ${distinct}, mínimo 2)`);
process.exit(ok ? 0 : 1);
