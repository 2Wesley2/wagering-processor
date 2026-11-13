import { DomainError } from '../../../shared/errors.ts';
import { Money, type MoneyProps } from '../../../shared/money.ts';
import type { Clock, IdGenerator, UnitOfWork } from '../../../shared/ports.ts';
import { Wallet } from '../domain/wallet.ts';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.ts';
import {
  DuplicateWalletError,
  type LedgerEntryView,
  type OpeningRecorder,
  type ReconciliationIssue,
  type ReconciliationObserver,
  type ReconciliationReader,
  type WalletQueries,
  type WalletRepository,
  type WalletView,
} from './ports.ts';

export class WalletAlreadyExistsError extends DomainError {
  constructor(readonly existingWalletId: string | undefined) {
    super('WALLET_ALREADY_EXISTS', 'já existe wallet para este playerId e moeda');
  }
}

export class WalletNotFoundError extends DomainError {
  constructor(walletId: string) {
    super('WALLET_NOT_FOUND', `wallet não encontrada: ${walletId}`);
  }
}

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: Money;
  readonly correlationId: string;
}

export interface LedgerPage {
  readonly walletId: string;
  readonly entries: readonly LedgerEntryView[];
  readonly nextCursor: string | null;
}

export interface ReconciliationResult {
  readonly walletId: string;
  readonly storedBalance: MoneyProps;
  readonly calculatedBalance: MoneyProps;
  readonly difference: MoneyProps;
  readonly consistent: boolean;
  readonly checkedEntries: number;
  readonly issues: readonly ReconciliationIssue[];
}

function view(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

/** Operações de wallet usadas pela borda HTTP (porta; permite dublês tipados sem afirmação de tipo). */
export type WalletOperations = Pick<WalletService, 'open' | 'get' | 'ledger' | 'reconcile'>;

/** Casos de uso de wallet da F2: abertura, consultas e reconciliação. */
export class WalletService {
  constructor(
    private readonly dependencies: {
      readonly unitOfWork: UnitOfWork;
      readonly wallets: WalletRepository;
      readonly openings: OpeningRecorder;
      readonly queries: WalletQueries;
      readonly reconciliation: ReconciliationReader;
      readonly observer: ReconciliationObserver;
      readonly clock: Clock;
      readonly idGenerator: IdGenerator;
    },
  ) {}

  /**
   * POST /wallets: wallet, OPENING, lançamento CREDIT e eventos na MESMA
   * transação SQL (§9). A unicidade (player, moeda) é garantida pelo índice;
   * perder a corrida vira 409 com o id existente.
   */
  async open(command: OpenWalletCommand): Promise<WalletView> {
    const { unitOfWork: unitOfWork, wallets, openings, queries, clock, idGenerator: idGenerator } = this.dependencies;
    const walletId = idGenerator.next();
    const at = clock.now();
    const opening = command.initialBalance.isPositive()
      ? { transactionId: idGenerator.next(), entryId: idGenerator.next() }
      : undefined;
    // Caminho rápido fora da transação (não segura duas conexões); a corrida é
    // decidida pelo índice wallets_player_currency_uq.
    const existing = await queries.findIdByPlayerAndCurrency(command.playerId, command.initialBalance.currency);
    if (existing !== undefined) throw new WalletAlreadyExistsError(existing);
    try {
      return await unitOfWork.run(async (databaseTransaction) => {
        const wallet = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance: command.initialBalance,
          at,
          ...(opening === undefined ? {} : { opening }),
        });
        const entries = wallet.pullLedgerEntries();
        await wallets.insert(databaseTransaction, wallet);
        const [openingEntry] = entries;
        if (openingEntry !== undefined) {
          await openings.record(databaseTransaction, wallet, openingEntry, {
            correlationId: command.correlationId,
            at,
          });
          await wallets.insertLedgerEntries(databaseTransaction, entries);
        }
        return view(wallet);
      });
    } catch (error) {
      if (error instanceof DuplicateWalletError) {
        throw new WalletAlreadyExistsError(
          await queries.findIdByPlayerAndCurrency(command.playerId, command.initialBalance.currency),
        );
      }
      throw error;
    }
  }

  async get(walletId: string): Promise<WalletView> {
    const found = await this.dependencies.queries.findById(walletId);
    if (found === undefined) throw new WalletNotFoundError(walletId);
    return found;
  }

  /** GET /wallets/:id/ledger: keyset por wallet_version com cursor opaco (D21). */
  async ledger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage> {
    if ((await this.dependencies.queries.findById(walletId)) === undefined) throw new WalletNotFoundError(walletId);
    const after = cursor === undefined ? 0 : decodeLedgerCursor(cursor, walletId);
    const rows = await this.dependencies.queries.ledgerAfter(walletId, after, limit + 1);
    const entries = rows.slice(0, limit);
    const last = entries.at(-1);
    return {
      walletId,
      entries,
      nextCursor: rows.length > limit && last !== undefined ? encodeLedgerCursor(walletId, last.walletVersion) : null,
    };
  }

  /** POST /wallets/:id/reconciliation: compara saldo com Σ ledger; nunca corrige (D22). */
  async reconcile(walletId: string): Promise<ReconciliationResult> {
    const facts = await this.dependencies.reconciliation.read(walletId);
    if (facts === undefined) throw new WalletNotFoundError(walletId);
    const stored = Money.parseStored(facts.storedBalance, facts.currency);
    const calculated = Money.parseStored(facts.calculatedBalance, facts.currency);
    const issues: ReconciliationIssue[] = [];
    if (!stored.equals(calculated)) issues.push('BALANCE_MISMATCH');
    const headOk =
      facts.headBalance === undefined
        ? stored.isZero() && facts.storedVersion === 1 && !facts.hasOpening
        : stored.equals(Money.parseStored(facts.headBalance, facts.currency)) &&
          facts.storedVersion === facts.headVersion;
    if (!headOk) issues.push('HEAD_MISMATCH');
    if (facts.chainBreaks > 0) issues.push('CHAIN_BREAK');
    if (facts.orphanEntries > 0) issues.push('ORPHAN_ENTRY');
    if (facts.missingEntries > 0) issues.push('MISSING_ENTRY');
    if (issues.length > 0) this.dependencies.observer.divergence(walletId, issues);
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: issues.length === 0,
      checkedEntries: facts.entries,
      issues,
    };
  }
}
