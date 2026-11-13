import { DomainError } from '../../../shared/errors.ts';
import { type TransactionView, transactionViewOf } from './original-response.ts';
import type { TransactionQueries } from './ports.ts';
import type { SubmissionRequest, SubmissionResult, SubmitWagerTransaction } from './submit-wager-transaction.ts';

export class TransactionNotFoundError extends DomainError {
  constructor() {
    super('TRANSACTION_NOT_FOUND', 'transação não encontrada');
  }
}

/** Operações de transação usadas pela borda HTTP (porta; dublês tipados sem afirmação de tipo). */
export type WageringOperations = Pick<WageringService, 'submit' | 'getById' | 'getByProvider'>;

/** Fachada da F3: submissão (caso de uso) e as duas consultas do §9 (estado atual, D29). */
export class WageringService {
  constructor(
    private readonly submission: SubmitWagerTransaction,
    private readonly queries: TransactionQueries,
  ) {}

  submit(request: SubmissionRequest): Promise<SubmissionResult> {
    return this.submission.execute(request);
  }

  async getById(transactionId: string): Promise<TransactionView> {
    const row = await this.queries.findById(transactionId);
    if (row === undefined) throw new TransactionNotFoundError();
    return transactionViewOf(row);
  }

  async getByProvider(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const row = await this.queries.findByProviderAndExternalId(providerId, externalTransactionId);
    if (row === undefined) throw new TransactionNotFoundError();
    return transactionViewOf(row);
  }
}
