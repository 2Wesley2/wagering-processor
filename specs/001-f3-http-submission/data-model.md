# Data Model: F3

Nenhuma tabela ou coluna nova: a migration `0001` já tem tudo. A F3 passa a gravar e ler:

## wager_transactions (já existe)

| Uso na F3 | Colunas |
|---|---|
| Resposta original (imutável, I1) | `initial_status`, `accepted_balance`, `accepted_wallet_version`, `accepted_at`, `failure_code` quando `initial_status = REJECTED`, `correlation_id` |
| Estado atual (GET) | `status`, `failure_code`, `result_balance`, `result_wallet_version`, `decided_at`, `reference_transaction_id` |
| Idempotência | `idempotency_key` (UNIQUE global, `COLLATE "C"`), `payload_hash`, `(provider_id, external_transaction_id)` UNIQUE |

Caminhos de gravação (D26):

| Desfecho | Transação | Wallet | Ledger | Outbox |
|---|---|---|---|---|
| PROCESSED com efeito | `initial=status=PROCESSED`, accepted = result = (s', v+1) | `UPDATE … WHERE version = v` | 1 lançamento v+1 | Processed + BalanceChanged |
| PROCESSED LOSS | accepted = result = (s, v) | — | — | Processed |
| REJECTED | `failure_code`, accepted = result = (s, v) | — | — | Rejected |
| PENDING_REFERENCE | accepted = (s, v), result nulo | — | — | PendingReference |

Transições de estado: as da F1 (`WagerTransaction`); a F3 nunca muda uma transação já gravada (a
resolução de pendências é da F4).

## Resposta original (derivada)

`OriginalResponse = { transactionId, status (initial), balance (accepted), failureCode? (só REJECTED), correlationId }`

## Visão de transação (GET)

Estado atual + `balance`/`walletVersion`/`decidedAt` da decisão (nulos enquanto pendente) +
`initialStatus`, `acceptedBalance`, `acceptedWalletVersion`, `acceptedAt` para auditoria.
