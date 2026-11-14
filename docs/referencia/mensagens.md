# Referência de mensagens

Filas SQS, envelope de entrada, eventos publicados e atributos da dead-letter. As fontes são
[`submit-transaction.ts`](../../src/modules/wagering/contracts/submit-transaction.ts) (entrada),
[`events.ts`](../../src/modules/wagering/domain/events.ts) e
[`integration-event.ts`](../../src/shared/integration-event.ts) (eventos),
[`queue-provisioner.ts`](../../src/platform/sqs/queue-provisioner.ts) (filas) e
[`message-identity.ts`](../../src/modules/messaging/infrastructure/message-identity.ts) (DLQ). O
comportamento em falhas está explicado no ARCHITECTURE,
[§12](../../ARCHITECTURE.md#12-mensageria-e-falhas-f5).

Os exemplos vêm de 2026-11-14, na stack do Compose: uma mensagem real enviada à fila de entrada e os
eventos que ela e as requisições da [referência da API](api-http.md) gravaram na outbox.

## Filas

Todas são FIFO, com deduplicação por conteúdo desligada e retenção de 14 dias. O job `init-queues`
cria ou ajusta os atributos; nunca faz purge nem apaga filas.

| Fila | Papel | Visibilidade | Espera do long poll | Redrive |
|---|---|---|---|---|
| `wager-transactions.fifo` | Entrada das transações | `SQS_VISIBILITY_TIMEOUT_S` (30 s) | `SQS_WAIT_TIME_S` (10 s) | Para a DLQ depois de `SQS_MAX_RECEIVE_COUNT` (8) recebimentos sem `ack` |
| `wager-transactions-dlq.fifo` | Dead-letter da entrada | 30 s | 0 s | nenhum |
| `wagering-events.fifo` | Eventos de integração para consumidores externos | 30 s | 10 s | nenhum |

Os nomes e os valores vêm das variáveis da [configuração](configuracao.md#sqs). A stack não consome a
fila de eventos.

## Envelope de entrada

Cada mensagem da fila de entrada é um `WagerTransactionRequested`. Os campos de `data` são os mesmos
do `POST /wagering/transactions` (ver a [referência da API](api-http.md#post-wageringtransactions)),
mais a `idempotencyKey`, que no HTTP vem no header.

| Campo | Regra |
|---|---|
| `messageId` | 1 a 200 caracteres; identifica a mensagem na inbox do consumidor |
| `type` | Sempre `WagerTransactionRequested`; outro valor é `UNSUPPORTED_MESSAGE_TYPE` |
| `occurredAt` | Data e hora ISO 8601 com fuso |
| `data` | Campos de negócio do POST, mais `idempotencyKey` (`^[!-~]{1,255}$`) |

O corpo inteiro tem até 16 KiB, e campos desconhecidos são rejeitados. Mensagem real enviada:

```json
{
  "messageId": "msg-sqs-bet-1794629691",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-14T04:14:53.710Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "sqs-bet-1794629691",
    "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
    "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
    "roundId": "round-sqs-1794629691",
    "gameId": "game-1",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" },
    "idempotencyKey": "provider-a:sqs-bet-1794629691"
  }
}
```

Atributos de envio usados no exemplo, os mesmos que os testes usam: `MessageGroupId` igual ao
`walletId` e `MessageDeduplicationId` igual ao `messageId`. O resultado foi uma BET aplicada (saldo de
120,00 para 115,00) e uma linha na inbox com o desfecho `PROCESSED`.

### O que o consumidor faz com cada mensagem

| Situação | Ação |
|---|---|
| Decisão de negócio (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`) | Grava transação, saldo, lançamento, outbox e inbox na mesma transação SQL; depois confirma (`ack`) |
| Mesmo `messageId` e mesmo conteúdo já registrados | Confirma sem novo efeito |
| `messageId` novo com uma `idempotencyKey` já usada e o mesmo conteúdo | Grava a inbox com `REPLAY` e confirma; nenhum evento novo |
| Mesmo `messageId` com outro conteúdo | Descarte (`MESSAGE_ID_PAYLOAD_MISMATCH`) |
| Contrato inválido, provedor desconhecido, wallet inexistente, conflito de key ou de externalId | Descarte com o código do [catálogo de erros](api-http.md#catálogo-de-erros) |
| Erro transitório | Sem `ack`; a mensagem volta com backoff (`CONSUMER_RETRY_BASE_S` a `CONSUMER_RETRY_MAX_S`); esgotados os recebimentos, a fila a move para a DLQ |

Um descarte é gravado em `dead_letter_messages` antes de a cópia ir para a DLQ, e só então a mensagem
sai da fila de entrada.

## Eventos publicados

O publicador envia à `wagering-events.fifo` os eventos gravados na outbox, na mesma transação da
decisão.

| Item | Valor |
|---|---|
| Corpo | Envelope JSON do evento (abaixo) |
| `MessageGroupId` | `walletId`, o que mantém a ordem por wallet |
| `MessageDeduplicationId` | `eventId`; numa republicação manual, `rp:<eventId>:<runId>` |
| Atributos | `eventType` e, quando existe, `correlationId`; na republicação, também `republishRunId` |

### Envelope comum

| Campo | Significado |
|---|---|
| `eventId` | Id do evento; nunca muda, nem na republicação. Um consumidor deduplica por ele |
| `eventType` | Um dos quatro tipos abaixo |
| `version` | Versão do formato do evento; hoje `1` em todos |
| `aggregateId` | `walletId` da operação |
| `correlationId` | Correlação da operação: o `X-Correlation-Id` no HTTP, o `messageId` na fila |
| `causationId` | O que provocou o evento; nos exemplos, a `Idempotency-Key` da operação |
| `occurredAt` | Data e hora ISO 8601 |
| `data` | Campos do tipo do evento |

### Tipos de evento

| `eventType` | Quando sai | Campos de `data` |
|---|---|---|
| `WagerTransactionProcessed` | Transação aplicada, inclusive `LOSS` e a `OPENING` de uma wallet com saldo | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `kind`, `money`, `referenceExternalTransactionId` e `referenceTransactionId` (quando há referência), `balance`, `walletVersion` |
| `WalletBalanceChanged` | Um por lançamento, sempre que o saldo muda | `walletId`, `transactionId`, `direction` (`DEBIT` ou `CREDIT`), `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
| `WagerTransactionRejected` | Transação rejeitada por regra de negócio, inclusive por prazo vencido | campos da transação, mais `failureCode`, `balance`, `walletVersion` |
| `WagerTransactionPendingReference` | Só quando a transação fica `PENDING_REFERENCE` | campos da transação, com `referenceExternalTransactionId` |

`balance` e `walletVersion` são os observados na decisão. Os eventos da BET recebida pela fila, como
estão na outbox:

```json
{
  "eventId": "01a1d843-f1a4-74b2-8d52-0223149ef705",
  "eventType": "WagerTransactionProcessed",
  "version": 1,
  "aggregateId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "correlationId": "msg-sqs-bet-1794629691",
  "causationId": "provider-a:sqs-bet-1794629691",
  "occurredAt": "2026-11-14T04:14:53.821Z",
  "data": {
    "transactionId": "01a1d843-f17b-7493-90dc-7832378c688d",
    "providerId": "provider-a",
    "externalTransactionId": "sqs-bet-1794629691",
    "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
    "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
    "roundId": "round-sqs-1794629691",
    "kind": "BET",
    "money": { "amount": "5.00", "currency": "BRL" },
    "balance": { "amount": "115.00", "currency": "BRL" },
    "walletVersion": 4
  }
}
```

```json
{
  "eventId": "01a1d843-f1a5-7523-bf4f-7cc86319df67",
  "eventType": "WalletBalanceChanged",
  "version": 1,
  "aggregateId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "correlationId": "msg-sqs-bet-1794629691",
  "causationId": "provider-a:sqs-bet-1794629691",
  "occurredAt": "2026-11-14T04:14:53.821Z",
  "data": {
    "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
    "transactionId": "01a1d843-f17b-7493-90dc-7832378c688d",
    "direction": "DEBIT",
    "money": { "amount": "5.00", "currency": "BRL" },
    "balanceBefore": { "amount": "120.00", "currency": "BRL" },
    "balanceAfter": { "amount": "115.00", "currency": "BRL" },
    "walletVersion": 4
  }
}
```

A entrega é pelo menos uma vez: um evento pode chegar repetido, e o consumidor deve descartar o
`eventId` que já aplicou. Eventos publicados que se perderam no broker voltam por
`outbox:republish` enquanto ainda estiverem na outbox (ver a
[§17](../../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6)).

## Dead-letter

A cópia de uma mensagem descartada vai à `wager-transactions-dlq.fifo` com o corpo original intacto e
estes atributos:

| Atributo | Conteúdo |
|---|---|
| `dlqReason` | Código do motivo do descarte |
| `consumerName` | Consumidor que descartou (`CONSUMER_NAME`) |
| `receiveCount` | Quantas vezes a mensagem tinha sido recebida |
| `dlAttempt` | Número da tentativa de descarte do mesmo registro |
| `sourceMessageId` | `MessageId` do SQS na fila de origem |
| `deadLetterKey` | Chave do registro de descarte; mantém a identidade mesmo para corpo ilegível |

Uma mensagem que esgota os recebimentos por erro transitório chega à DLQ pela política da própria
fila, sem esses atributos e sem registro no PostgreSQL até o redrive.

O comando `docker compose exec app-1 bun run sqs:redrive` devolve à fila de entrada as cópias da DLQ.
Ele usa `dlAttempt` para descartar cópias antigas, trata uma cópia sem `dlAttempt` como movida pela
fila e mantém `deadLetterKey` e `consumerName` no reenvio. Detalhes no ARCHITECTURE,
[§12](../../ARCHITECTURE.md#12-mensageria-e-falhas-f5).

## Enviar uma mensagem de teste

Com a stack no ar, salve este arquivo como `send-sqs.ts` na raiz do repositório (troque `walletId` e
`playerId` por os de uma wallet existente):

```ts
import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  endpoint: 'http://ministack:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
const message = {
  messageId: 'msg-exemplo-1',
  type: 'WagerTransactionRequested',
  occurredAt: new Date().toISOString(),
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'exemplo-1',
    playerId: 'c808043a-bbcd-42c7-96eb-ffa960b37faa',
    walletId: '01a1d840-700f-73de-a51a-288c91bfd9ed',
    roundId: 'round-exemplo',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '5.00', currency: 'BRL' },
    idempotencyKey: 'provider-a:exemplo-1',
  },
};
const sent = await sqs.send(
  new SendMessageCommand({
    QueueUrl,
    MessageBody: JSON.stringify(message),
    MessageGroupId: message.data.walletId,
    MessageDeduplicationId: message.messageId,
  }),
);
console.log(sent.MessageId);
```

Envie pela imagem de testes, que já tem o Bun e o SDK, sem instalar nada no host:

```bash
docker compose run --rm --no-deps -v "${PWD}/send-sqs.ts:/app/send-sqs.ts:ro" tests bun /app/send-sqs.ts
```

O comando imprime o `MessageId` do SQS. Depois, confira o desfecho pela API:
`curl -s http://localhost:8080/providers/provider-a/wagering/transactions/exemplo-1`.
