# Contrato HTTP da F3

Erros sempre em `application/problem+json` (`type`, `title`, `status`, `code`, `detail`,
`retryable`, `correlationId`). Toda resposta leva `X-Instance-Id` e `X-Correlation-Id`.

## POST /wagering/transactions

Header `Idempotency-Key` obrigatório (`^[!-~]{1,255}$`). Corpo do §9 (`referenceExternalTransactionId`
opcional), `.strict()`.

| Situação | HTTP | Corpo |
|---|---|---|
| Aplicada | 200 | `{transactionId, status: "PROCESSED", balance, idempotentReplay}` |
| Aceita aguardando referência | 202 | `{transactionId, status: "PENDING_REFERENCE", balance, idempotentReplay}` |
| Rejeitada por regra | 422 | problem+json, `code = failureCode`, `transaction: {transactionId, status: "REJECTED", failureCode, balance}`, `idempotentReplay` |
| Replay (mesma key e payload) | o da 1ª resposta | o corpo da 1ª resposta, só com `idempotentReplay: true` |
| Contrato inválido | 400 | `VALIDATION_ERROR`, `MALFORMED_JSON`, `IDEMPOTENCY_KEY_MISSING`/`INVALID`, `INVALID_AMOUNT`, `UNSUPPORTED_CURRENCY`, `KIND_NOT_ALLOWED`, `REFERENCE_REQUIRED`/`NOT_ALLOWED`, `SELF_REFERENCE`, `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH` |
| Autenticação negada | 401 | `AUTHENTICATION_REQUIRED` |
| Provedor não reconhecido | 403 | `PROVIDER_NOT_RECOGNIZED` |
| Wallet inexistente | 404 | `WALLET_NOT_FOUND` |
| Conflito | 409 | `IDEMPOTENCY_KEY_REUSED` (sem dados da transação existente), `EXTERNAL_TRANSACTION_ID_CONFLICT` |
| Corpo > 16 KiB / mídia | 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| Transitório | 503 + `Retry-After` | `CONCURRENCY_CONFLICT`, `DATABASE_UNAVAILABLE` |
| Interno | 500 | `INTERNAL_ERROR` (inclui caso dependente de P1/P2) |

200/202/422 levam `Location: /wagering/transactions/{transactionId}`.

## GET /wagering/transactions/:transactionId e GET /providers/:providerId/wagering/transactions/:externalTransactionId

200 com:

```json
{
  "transactionId": "…", "providerId": "provider-a", "externalTransactionId": "…",
  "walletId": "…", "playerId": "…", "roundId": "…", "gameId": "…", "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": null, "referenceTransactionId": null,
  "status": "PROCESSED", "failureCode": null,
  "balance": { "amount": "975.00", "currency": "BRL" }, "walletVersion": 2, "decidedAt": "…",
  "initialStatus": "PROCESSED",
  "acceptedBalance": { "amount": "975.00", "currency": "BRL" }, "acceptedWalletVersion": 2,
  "acceptedAt": "…", "createdAt": "…"
}
```

`balance`, `walletVersion` e `decidedAt` são da decisão (nulos enquanto pendente), nunca o saldo
atual da wallet. Id inválido → 400 `VALIDATION_ERROR`; inexistente → 404 `TRANSACTION_NOT_FOUND`.
