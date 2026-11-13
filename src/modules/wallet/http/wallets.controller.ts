import type { IncomingMessage } from 'node:http';
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Money } from '../../../shared/money.ts';
import { ContextStore } from '../../../platform/observability/context.ts';
import { AppError, readJsonBody } from '../../../platform/http/problem-details.ts';
import { WALLET_SERVICE } from '../../../platform/tokens.ts';
import { InvalidCursorError, parseLedgerLimit } from '../application/ledger-cursor.ts';
import type { LedgerPage, ReconciliationResult, WalletOperations } from '../application/wallet-service.ts';
import type { WalletView } from '../application/ports.ts';
import { parseOpenWallet, WALLET_ID_RE } from '../contracts/open-wallet.ts';

interface HeaderResponse {
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

function walletIdOf(raw: string): string {
  if (!WALLET_ID_RE.test(raw)) throw new AppError('VALIDATION_ERROR', 'walletId precisa ser um UUID');
  return raw.toLowerCase();
}

function singleQuery(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidCursorError(`${name} repetido`);
  return value;
}

/** Endpoints de wallet do §9 (F2): criar, consultar, ledger paginado e reconciliação. */
@Controller('wallets')
export class WalletsController {
  constructor(@Inject(WALLET_SERVICE) private readonly wallets: WalletOperations) {}

  @Post()
  @HttpCode(201)
  async create(@Req() request: IncomingMessage, @Res({ passthrough: true }) response: HeaderResponse) {
    const parsed = parseOpenWallet(await readJsonBody(request));
    if (!parsed.ok) throw new AppError(parsed.code, 'corpo inválido', { issues: parsed.issues });
    const header = response.getHeader('X-Correlation-Id');
    const correlationId =
      typeof header === 'string' ? header : (ContextStore.get().correlationId ?? Bun.randomUUIDv7());
    const wallet = await this.wallets.open({
      playerId: parsed.value.playerId,
      initialBalance: Money.from(parsed.value.initialBalance),
      correlationId,
    });
    response.setHeader('Location', `/wallets/${wallet.id}`);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance, version: wallet.version };
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.wallets.get(walletIdOf(walletId));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<LedgerPage> {
    const id = walletIdOf(walletId);
    return this.wallets.ledger(id, singleQuery(cursor, 'cursor'), parseLedgerLimit(singleQuery(limit, 'limit')));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string): Promise<ReconciliationResult> {
    return this.wallets.reconcile(walletIdOf(walletId));
  }
}
