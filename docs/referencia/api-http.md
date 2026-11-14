# Referência da API HTTP

Rotas, headers, corpos, respostas e códigos de erro da API. As fontes são os controllers em
`src/modules/*/http/` e `src/modules/health/`, os contratos em `src/modules/*/contracts/` e o
catálogo [`src/shared/error-catalog.ts`](../../src/shared/error-catalog.ts). O porquê do
comportamento está no ARCHITECTURE,
[§6, 10 e 14](../../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3).

Os exemplos foram executados em 2026-11-14 na stack do Compose, pelo nginx, com uma wallet de
demonstração. Os ids e horários são os daquela execução.

## Convenções

| Item | Regra |
|---|---|
| Endereço | `http://localhost:8080` pelo nginx (porta em `HTTP_PORT`, ver a [configuração](configuracao.md#variáveis-do-compose)) |
| Corpo | `Content-Type: application/json`, até 16 KiB; campos desconhecidos são rejeitados |
| Dinheiro | objeto `{"amount": "25.00", "currency": "BRL"}`; `amount` é texto com exatamente duas casas, sem sinal, até `999999999999999.99`, nunca arredondado; moedas aceitas: `BRL` e `USD` |
| Ids | `walletId`, `playerId` e `transactionId` são UUIDs |
| `X-Correlation-Id` | Enviado pelo cliente (`^[A-Za-z0-9._:-]{1,128}$`) ou gerado; volta em toda resposta e nos logs |
| `X-Instance-Id` | Instância que respondeu (`app-1`, `app-2` ou `app-3` na stack) |
| Autenticação | Ponto de extensão sem efeito hoje (adaptador `noop`); os health checks são públicos |

### Corpo de erro

Todo erro sai como `application/problem+json` (RFC 9457). Exemplo real, com `Content-Type` errado:

```json
{
  "type": "urn:wagering:error:UNSUPPORTED_MEDIA_TYPE",
  "title": "UNSUPPORTED_MEDIA_TYPE",
  "status": 415,
  "code": "UNSUPPORTED_MEDIA_TYPE",
  "detail": "Content-Type precisa ser application/json",
  "retryable": false,
  "correlationId": "01a1d840-7bd5-7576-83e5-931aa251d10c"
}
```

- `code` é sempre um código do [catálogo de erros](#catálogo-de-erros).
- `retryable` só é `true` nos `503`, que também trazem o header `Retry-After`.
- Erros de contrato trazem `issues`, com o campo e o motivo (ex.: `"initialBalance.amount: INVALID_AMOUNT:SCALE"`).
- A ordem de checagem no POST é: `Content-Type` (415), tamanho (413), JSON (400), header e corpo
  (400), provedor (403), idempotência (409) e só então a wallet e as regras de negócio.

## Wallets

### `POST /wallets`

Cria a wallet de um player numa moeda.

```json
{ "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa", "initialBalance": { "amount": "100.00", "currency": "BRL" } }
```

Resposta `201`, com `Location: /wallets/{id}`:

```json
{
  "id": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

- Com saldo inicial maior que zero, a mesma transação SQL grava a transação interna `OPENING` e o
  lançamento `CREDIT` da versão 1. Com `0.00`, não há lançamento.
- Erros: `400` (`VALIDATION_ERROR`, `INVALID_AMOUNT`, `UNSUPPORTED_CURRENCY`), `409`
  `WALLET_ALREADY_EXISTS` com `existingWalletId` quando o player já tem wallet nessa moeda.

### `GET /wallets/{walletId}`

Saldo e versão atuais. Resposta `200`:

```json
{
  "id": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
  "balance": { "amount": "120.00", "currency": "BRL" },
  "version": 3,
  "createdAt": "2026-11-14T04:11:04.079Z",
  "updatedAt": "2026-11-14T04:11:05.647Z"
}
```

Erros: `400` `VALIDATION_ERROR` (id fora do formato UUID), `404` `WALLET_NOT_FOUND`.

### `GET /wallets/{walletId}/ledger?limit={n}&cursor={c}`

Lançamentos em ordem crescente de `walletVersion`, paginados por cursor.

| Parâmetro | Regra |
|---|---|
| `limit` | 1 a 200; padrão 50 |
| `cursor` | Valor de `nextCursor` da página anterior; opaco; só vale para a mesma wallet |

Resposta `200` com `limit=2` (um lançamento mostrado):

```json
{
  "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "entries": [
    {
      "id": "01a1d840-7418-77b6-8dc4-b483dab21034",
      "transactionId": "01a1d840-7415-701f-a37b-65020098a1aa",
      "direction": "DEBIT",
      "money": { "amount": "30.00", "currency": "BRL" },
      "balanceBefore": { "amount": "100.00", "currency": "BRL" },
      "balanceAfter": { "amount": "70.00", "currency": "BRL" },
      "walletVersion": 2,
      "createdAt": "2026-11-14T04:11:05.110Z"
    }
  ],
  "nextCursor": "eyJ2IjoxLCJ3IjoiMDFhMWQ4NDAtNzAwZi03M2RlLWE1MWEtMjg4YzkxYmZkOWVkIiwicyI6Mn0"
}
```

`nextCursor` é `null` na última página. Erros: `400` `INVALID_CURSOR` (cursor ou `limit`
inválidos), `404` `WALLET_NOT_FOUND`.

### `POST /wallets/{walletId}/reconciliation`

Compara o saldo gravado com a soma do ledger, só com leitura. Uma divergência é registrada em log
e métrica, mas nunca corrigida. Resposta `200` sempre que a checagem roda:

```json
{
  "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "storedBalance": { "amount": "120.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "120.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 3,
  "issues": []
}
```

## Transações

### `POST /wagering/transactions`

Submete uma operação. O header `Idempotency-Key` é obrigatório (`^[!-~]{1,255}$`, única no
sistema, inclusive entre provedores; o formato `{providerId}:{externalTransactionId}` é recomendado).

| Campo | Regra |
|---|---|
| `providerId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` e presente em `PROVIDER_IDS` |
| `externalTransactionId`, `roundId`, `gameId` | 1 a 128 caracteres ASCII imprimíveis |
| `playerId`, `walletId` | UUID; a wallet precisa ser desse player e da moeda de `money` |
| `kind` | `BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK` (`OPENING` é interno) |
| `money` | Ver [Convenções](#convenções); maior que zero, exceto `LOSS`, que aceita `0.00` |
| `referenceExternalTransactionId` | Opcional; regras por tipo na tabela abaixo |

| `kind` | Efeito no saldo | Referência |
|---|---|---|
| `BET` | Débito | Proibida (`REFERENCE_NOT_ALLOWED`) |
| `WIN` | Crédito | Opcional; se houver, aponta para uma `BET` |
| `LOSS` | Nenhum | Opcional; se houver, aponta para uma `BET` |
| `REFUND` | Crédito | Obrigatória (`REFERENCE_REQUIRED`); aponta para uma `BET` |
| `ROLLBACK` | Inverso da referência | Obrigatória; aponta para uma `BET`, um `WIN` ou um `REFUND` |

Exemplo de corpo:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1794629463",
  "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
  "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "roundId": "round-1794629463",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "30.00", "currency": "BRL" }
}
```

As respostas `200`, `202` e `422` trazem `Location: /wagering/transactions/{id}`.

| Status | Quando | Corpo |
|---|---|---|
| `200` | Operação aplicada (`PROCESSED`) | `{transactionId, status, balance, idempotentReplay}` |
| `202` | A referência ainda não tem desfecho (`PENDING_REFERENCE`) | o mesmo formato do `200` |
| `422` | Rejeitada por regra de negócio (`REJECTED`, gravada) | `problem+json` com `transaction {transactionId, status, failureCode, balance}` |

`balance` é o saldo observado na decisão (ou no aceite, no `202`), nunca o saldo atual. Exemplos
reais:

```json
{"transactionId":"01a1d840-7415-701f-a37b-65020098a1aa","status":"PROCESSED","balance":{"amount":"70.00","currency":"BRL"},"idempotentReplay":false}
```

```json
{"transactionId":"01a1d840-7937-7019-b94f-6d18a61fe369","status":"PENDING_REFERENCE","balance":{"amount":"120.00","currency":"BRL"},"idempotentReplay":false}
```

```json
{
  "type": "urn:wagering:error:INSUFFICIENT_FUNDS",
  "title": "INSUFFICIENT_FUNDS",
  "status": 422,
  "code": "INSUFFICIENT_FUNDS",
  "detail": "transação rejeitada por regra de negócio: INSUFFICIENT_FUNDS",
  "retryable": false,
  "correlationId": "01a1d840-783c-74e5-819a-047e9676e0ad",
  "transaction": {
    "transactionId": "01a1d840-784d-76d8-85e8-13be09f17f48",
    "status": "REJECTED",
    "failureCode": "INSUFFICIENT_FUNDS",
    "balance": { "amount": "120.00", "currency": "BRL" }
  },
  "idempotentReplay": false
}
```

**Repetição (replay).** A mesma key com o mesmo corpo devolve o status e o corpo da primeira
resposta, só com `idempotentReplay: true`, mesmo que a pendência já tenha sido resolvida. O
desfecho atual aparece no GET. A mesma key com outro corpo é `409` `IDEMPOTENCY_KEY_REUSED`; uma key
nova com um `externalTransactionId` já usado é `409` `EXTERNAL_TRANSACTION_ID_CONFLICT`. As regras
estão no ARCHITECTURE, [§1](../../ARCHITECTURE.md#1-contexto-drivers-e-não-escopo).

**Pendências.** Uma transação `PENDING_REFERENCE` é decidida pelo worker quando a referência ganha
desfecho, ou rejeitada com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED` depois do prazo
(`PENDING_REFERENCE_TTL_MS`, padrão 30 min). Detalhes no ARCHITECTURE,
[§13](../../ARCHITECTURE.md#13-pending_reference-e-worker-de-pendências-f4).

### `GET /wagering/transactions/{transactionId}`

### `GET /providers/{providerId}/wagering/transactions/{externalTransactionId}`

As duas rotas devolvem a mesma visão do estado atual. Resposta `200`:

```json
{
  "transactionId": "01a1d840-7415-701f-a37b-65020098a1aa",
  "providerId": "provider-a",
  "externalTransactionId": "bet-1794629463",
  "walletId": "01a1d840-700f-73de-a51a-288c91bfd9ed",
  "playerId": "c808043a-bbcd-42c7-96eb-ffa960b37faa",
  "roundId": "round-1794629463",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "30.00", "currency": "BRL" },
  "referenceExternalTransactionId": null,
  "referenceTransactionId": null,
  "status": "PROCESSED",
  "failureCode": null,
  "balance": { "amount": "70.00", "currency": "BRL" },
  "walletVersion": 2,
  "decidedAt": "2026-11-14T04:11:05.116Z",
  "initialStatus": "PROCESSED",
  "acceptedBalance": { "amount": "70.00", "currency": "BRL" },
  "acceptedWalletVersion": 2,
  "acceptedAt": "2026-11-14T04:11:05.116Z",
  "createdAt": "2026-11-14T04:11:05.109Z"
}
```

| Campo | Significado |
|---|---|
| `status`, `failureCode` | Estado atual e, se rejeitada, o código |
| `balance`, `walletVersion`, `decidedAt` | Saldo, versão e instante da decisão; `null` enquanto pendente |
| `initialStatus`, `acceptedBalance`, `acceptedWalletVersion`, `acceptedAt` | O que foi respondido na primeira submissão |
| `referenceTransactionId` | Id interno da referência, preenchido quando a operação foi aplicada |

Erros: `400` `VALIDATION_ERROR` (parâmetro fora do formato), `404` `TRANSACTION_NOT_FOUND`.

## Health e métricas

| Rota | Resposta |
|---|---|
| `GET /health/live` | `200` `{"status":"ok","instance":"app-3","uptimeS":43069}`; não consulta dependências |
| `GET /health/ready` | `200` `{"status":"ready","instance":"app-2","draining":false,"checks":{"postgres":"up","sqs":"up"}}`; `503` com `"not_ready"` se estiver drenando ou se o PostgreSQL ou o SQS não responderem |
| `GET /metrics` | Formato Prometheus, em cada instância; o nginx responde `404` a essa rota. A lista de métricas está no ARCHITECTURE, [§17](../../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) |

A rota `POST /__test/fault/{point}` existe só com `NODE_ENV=test`, para os testes de queda, e não
faz parte da API.

## Catálogo de erros

"Grava" indica se o erro deixa uma transação gravada. "Na fila" é o que o consumidor SQS faz com a
mensagem: confirma (`ACK`), devolve para nova tentativa (`RETRY`), descarta na DLQ (`DLQ`) ou
registra o descarte no PostgreSQL antes de enviar à DLQ (`DEAD_LETTER`).

| Código | HTTP | Retentável | Grava | Na fila | O provedor deve |
|---|---|---|---|---|---|
| `VALIDATION_ERROR` | 400 | não | não | DLQ | corrigir e reenviar |
| `MALFORMED_JSON` | 400 | não | não | DLQ | corrigir e reenviar |
| `IDEMPOTENCY_KEY_MISSING` | 400 | não | não | DLQ | corrigir e reenviar |
| `IDEMPOTENCY_KEY_INVALID` | 400 | não | não | DLQ | corrigir e reenviar |
| `INVALID_AMOUNT` | 400 | não | não | DLQ | corrigir e reenviar |
| `UNSUPPORTED_CURRENCY` | 400 | não | não | DLQ | corrigir e reenviar |
| `KIND_NOT_ALLOWED` | 400 | não | não | DLQ | corrigir e reenviar |
| `REFERENCE_REQUIRED` | 400 | não | não | DLQ | corrigir e reenviar |
| `REFERENCE_NOT_ALLOWED` | 400 | não | não | DLQ | corrigir e reenviar |
| `SELF_REFERENCE` | 400 | não | não | DLQ | corrigir e reenviar |
| `WALLET_PLAYER_MISMATCH` | 400 | não | não | DLQ | corrigir e reenviar |
| `CURRENCY_MISMATCH` | 400 | não | não | DLQ | corrigir e reenviar |
| `INVALID_CURSOR` | 400 | não | não | DLQ | corrigir e reenviar |
| `AUTHENTICATION_REQUIRED` | 401 | não | não | DLQ | corrigir e reenviar |
| `PROVIDER_NOT_RECOGNIZED` | 403 | não | não | DLQ | corrigir e reenviar |
| `PROVIDER_IDENTITY_MISMATCH` | 403 | não | não | DLQ | corrigir e reenviar |
| `WALLET_NOT_FOUND` | 404 | não | não | DEAD_LETTER | corrigir e reenviar |
| `ROUTE_NOT_FOUND` | 404 | não | não | DLQ | corrigir e reenviar |
| `TRANSACTION_NOT_FOUND` | 404 | não | não | DLQ | corrigir e reenviar |
| `IDEMPOTENCY_KEY_REUSED` | 409 | não | não | DEAD_LETTER | não reenviar |
| `EXTERNAL_TRANSACTION_ID_CONFLICT` | 409 | não | não | DEAD_LETTER | não reenviar |
| `WALLET_ALREADY_EXISTS` | 409 | não | não | DEAD_LETTER | não reenviar |
| `PAYLOAD_TOO_LARGE` | 413 | não | não | DLQ | corrigir e reenviar |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | não | não | DLQ | corrigir e reenviar |
| `INSUFFICIENT_FUNDS` | 422 | não | sim | ACK | desistir; outra operação exige novo `externalTransactionId` |
| `REVERSAL_INSUFFICIENT_FUNDS` | 422 | não | sim | ACK | desistir |
| `BALANCE_LIMIT_EXCEEDED` | 422 | não | sim | ACK | desistir |
| `REFERENCE_NOT_FOUND` | 422 | não | sim | ACK | desistir |
| `REFERENCE_NOT_PROCESSED` | 422 | não | sim | ACK | desistir |
| `REFERENCE_SCOPE_MISMATCH` | 422 | não | sim | ACK | desistir |
| `INVALID_REFERENCE_KIND` | 422 | não | sim | ACK | desistir |
| `REFERENCE_AMOUNT_MISMATCH` | 422 | não | sim | ACK | desistir |
| `REVERSAL_KIND_ALREADY_USED` | 422 | não | sim | ACK | desistir |
| `REFERENCE_ALREADY_REVERSED` | 422 | não | sim | ACK | desistir |
| `REFERENCED_BET_REVERSED` | 422 | não | sim | ACK | desistir |
| `BET_ALREADY_SETTLED` | 422 | não | sim | ACK | desistir |
| `INTERNAL_ERROR` | 500 | não | não | DLQ | escalar |
| `PROCESSING_PERMANENT_FAILURE` | 500 | não | sim | DLQ | escalar |
| `DATABASE_UNAVAILABLE` | 503 | sim | não | RETRY | reenviar com a mesma key |
| `CONCURRENCY_CONFLICT` | 503 | sim | não | RETRY | reenviar com a mesma key |
| `SERVICE_SHUTTING_DOWN` | 503 | sim | não | RETRY | reenviar com a mesma key |
| `UNSUPPORTED_MESSAGE_TYPE` | só na fila | não | não | DLQ | corrigir o produtor |
| `MESSAGE_ID_PAYLOAD_MISMATCH` | só na fila | não | não | DEAD_LETTER | não reenviar |
| `MESSAGE_TOO_LARGE` | só na fila | não | não | DLQ | corrigir o produtor |

As regras de reversão por trás de `REVERSAL_KIND_ALREADY_USED`, `REFERENCE_ALREADY_REVERSED`,
`REFERENCED_BET_REVERSED` e `BET_ALREADY_SETTLED` estão no ARCHITECTURE,
[§11](../../ARCHITECTURE.md#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c).
