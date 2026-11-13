import type { IncomingMessage } from 'node:http';
import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { MoneyProps } from '../../../shared/money.ts';
import { AppError, readJsonBody } from '../../../platform/http/problem-details.ts';
import { ContextStore } from '../../../platform/observability/context.ts';
import { WAGERING_SERVICE } from '../../../platform/tokens.ts';
import type { OriginalResponse, TransactionView } from '../application/original-response.ts';
import type { SubmissionResult } from '../application/submit-wager-transaction.ts';
import type { WageringOperations } from '../application/wagering-service.ts';
import { parseIdempotencyKey, parseSubmitTransaction, PROVIDER_ID_RE } from '../contracts/submit-transaction.ts';

interface StatusResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  getHeader(name: string): unknown;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTERNAL_ID_RE = /^[!-~]{1,128}$/;

/** 200/202: corpo do §9. */
interface AcceptedBody {
  readonly transactionId: string;
  readonly status: 'PROCESSED' | 'PENDING_REFERENCE';
  readonly balance: MoneyProps;
  readonly idempotentReplay: boolean;
}

/** 422: problem+json com a transação rejeitada (D31). */
interface RejectedBody {
  readonly type: string;
  readonly title: string;
  readonly status: 422;
  readonly code: string;
  readonly detail: string;
  readonly retryable: false;
  readonly correlationId: string;
  readonly transaction: {
    readonly transactionId: string;
    readonly status: 'REJECTED';
    readonly failureCode: string;
    readonly balance: MoneyProps;
  };
  readonly idempotentReplay: boolean;
}

/**
 * Corpo da resposta original (I1 = opção A). Tudo vem da `OriginalResponse` gravada na primeira
 * decisão (inclusive o correlationId e um `detail` fixo por código): o replay só muda
 * `idempotentReplay`.
 */
function responseOf(result: SubmissionResult): { httpStatus: number; body: AcceptedBody | RejectedBody } {
  const original: OriginalResponse = result.response;
  if (original.status === 'REJECTED') {
    const failureCode = original.failureCode;
    if (failureCode === undefined) throw new Error('rejeição sem failureCode');
    return {
      httpStatus: 422,
      body: {
        type: `urn:wagering:error:${failureCode}`,
        title: failureCode,
        status: 422,
        code: failureCode,
        detail: `transação rejeitada por regra de negócio: ${failureCode}`,
        retryable: false,
        correlationId: original.correlationId,
        transaction: {
          transactionId: original.transactionId,
          status: 'REJECTED',
          failureCode,
          balance: original.balance,
        },
        idempotentReplay: result.idempotentReplay,
      },
    };
  }
  return {
    httpStatus: original.status === 'PROCESSED' ? 200 : 202,
    body: {
      transactionId: original.transactionId,
      status: original.status,
      balance: original.balance,
      idempotentReplay: result.idempotentReplay,
    },
  };
}

/** Submissão e consultas de transação do §9 (F3). */
@Controller()
export class WageringTransactionsController {
  constructor(@Inject(WAGERING_SERVICE) private readonly wagering: WageringOperations) {}

  @Post('wagering/transactions')
  async submit(
    @Req() request: IncomingMessage,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<AcceptedBody | RejectedBody> {
    // Ordem de avaliação (D31): 415/413/JSON → (guard) → header e schema → identidade → idempotência.
    const body = await readJsonBody(request);
    const idempotencyKey = parseIdempotencyKey(request.headers['idempotency-key']);
    if (!idempotencyKey.ok) throw new AppError(idempotencyKey.code, 'Idempotency-Key inválida', {});
    const parsed = parseSubmitTransaction(body);
    if (!parsed.ok) throw new AppError(parsed.code, 'corpo inválido', { issues: parsed.issues });
    const header = response.getHeader('X-Correlation-Id');
    const correlationId =
      typeof header === 'string' ? header : (ContextStore.get().correlationId ?? Bun.randomUUIDv7());
    const result = await this.wagering.submit({
      command: parsed.value,
      idempotencyKey: idempotencyKey.value,
      correlationId,
    });
    const { httpStatus, body: responseBody } = responseOf(result);
    response.status(httpStatus);
    response.setHeader('Location', `/wagering/transactions/${result.response.transactionId}`);
    if (httpStatus === 422) response.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
    return responseBody;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<TransactionView> {
    if (!UUID_RE.test(transactionId)) throw new AppError('VALIDATION_ERROR', 'transactionId precisa ser um UUID');
    return this.wagering.getById(transactionId.toLowerCase());
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<TransactionView> {
    if (!PROVIDER_ID_RE.test(providerId) || !EXTERNAL_ID_RE.test(externalTransactionId)) {
      throw new AppError('VALIDATION_ERROR', 'providerId ou externalTransactionId fora do formato');
    }
    return this.wagering.getByProvider(providerId, externalTransactionId);
  }
}
