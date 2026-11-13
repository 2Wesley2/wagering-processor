import { createHash } from 'node:crypto';

/** Atributos que o consumidor grava na cópia enviada à DLQ (D35) e o redrive lê (D36). */
export const DLQ_ATTRIBUTES = {
  reason: 'dlqReason',
  consumerName: 'consumerName',
  receiveCount: 'receiveCount',
  attempt: 'dlAttempt',
  sourceMessageId: 'sourceMessageId',
  /**
   * Chave do registro de descarte, levada na cópia da DLQ e no reenvio do redrive. Sem ela, um corpo
   * ilegível redrivado ganharia outra chave (`sqs:<MessageId novo>`) e outro registro, em vez de
   * voltar como tentativa seguinte do mesmo descarte.
   */
  deadLetterKey: 'deadLetterKey',
} as const;

/** `v1:` + sha256 dos bytes exatos do corpo recebido. */
export function bodyHashOf(body: string): string {
  return `v1:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/**
 * messageId do envelope, quando o corpo é um objeto JSON com um messageId utilizável (1 a 200
 * caracteres). Não valida o resto: serve para identificar a mensagem mesmo quando o contrato falha.
 */
export function envelopeMessageIdOf(body: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || !('messageId' in json)) return undefined;
  const messageId = json.messageId;
  return typeof messageId === 'string' && messageId.length >= 1 && messageId.length <= 200 ? messageId : undefined;
}

const SQS_KEY_RE = /^sqs:[A-Za-z0-9-]{1,128}$/;

/**
 * Chave do registro de dead-letter (D35): o messageId do envelope ou, se o envelope não for
 * legível, `sqs:<MessageId do SQS>` da mensagem de origem ORIGINAL. Uma mensagem devolvida pelo
 * redrive traz essa chave no atributo `deadLetterKey` (`carriedKey`), porque o SQS dá um
 * MessageId novo a cada envio; um envio independente do mesmo corpo não traz o atributo e tem
 * chave própria. Só uma chave `sqs:` bem formada é aceita do atributo.
 */
export function deadLetterKeyOf(body: string, sourceSqsMessageId: string, carriedKey?: string): string {
  const messageId = envelopeMessageIdOf(body);
  if (messageId !== undefined) return messageId;
  if (carriedKey !== undefined && SQS_KEY_RE.test(carriedKey)) return carriedKey;
  return `sqs:${sourceSqsMessageId}`;
}

export interface DeadLetterKey {
  readonly consumerName: string;
  readonly dlKey: string;
  readonly bodyHash: string;
}
