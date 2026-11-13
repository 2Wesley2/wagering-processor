---

description: "Tarefas da F3 (submissão HTTP, idempotência e concorrência)"
---

# Tasks: F3 — Submissão HTTP de transações, idempotência e concorrência

**Input**: `specs/001-f3-http-submission/` (plan, spec, research, data-model, contracts/http.md, quickstart)

**Tests**: obrigatórios — cada teste leva o ID do catálogo `test/meta/required.ts` no nome.

**Fora de escopo**: worker de pendências, IT-10b, regras P1/P2 (F4); SQS (F5).

**Princípios aplicáveis** (constituição 0.3.1, rascunho): Setup e Foundational → III, IV, VIII,
XII, XIII; US1 → I, II, VI, VII; US2 → V; US3 → IV; US4 → V (estado atual × resposta original);
US5 → VIII; testes → IX.

## Phase 1: Setup

- [X] T001 Registrar `I1: 'original-response'` em `DECIDED`, mantendo `I2`, em test/meta/required.ts
- [X] T002 [P] Adicionar `AUTHENTICATION_REQUIRED` (categoria `authentication`, HTTP 401) em src/shared/error-catalog.ts e ajustar test/unit/error-catalog.test.ts
- [X] T003 [P] Adicionar à configuração `PROVIDER_IDS` (padrão `provider-a,provider-b`), `AUTHENTICATION_ADAPTER` (`noop`; `deny-all` só com `NODE_ENV=test`), `DB_QUERY_TIMEOUT_MS`, `DB_CONNECT_TIMEOUT_MS` e `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` em src/platform/config/config.ts

## Phase 2: Foundational

- [X] T004 Passar `query_timeout`, `connectionTimeoutMillis` e `keepAlive` ao pool e aplicar `idle_in_transaction_session_timeout` local na UnitOfWork em src/platform/persistence/unit-of-work.ts
- [X] T005 [P] Adicionar `lockForUpdate` (SQL `SELECT … FOR UPDATE` → `Wallet.rehydrate`) e `saveBalance` (`UPDATE … WHERE id = ? AND version = ?`, rowcount 1) ao `WalletRepository` em src/modules/wallet/application/ports.ts e src/modules/wallet/infrastructure/sql-wallet-repository.ts
- [X] T006 [P] Criar `WagerTransactionRecord` (somente leitura) em src/platform/persistence/records.ts
- [X] T007 Criar portas `TransactionStore`/`TransactionQueries`, a linha neutra `TransactionRow`, o mapeamento linha → `WagerTransaction`, `OriginalResponse` e `TransactionView` em src/modules/wagering/application/ports.ts e src/modules/wagering/application/original-response.ts
- [X] T008 Completar `SqlTransactionRepository` (gravar pendente; buscar por key e por provider+externalId sob a transação; `ReversalView` do alvo) em src/modules/wagering/infrastructure/sql-transaction-repository.ts
- [X] T009 [P] Implementar `OrmTransactionQueries` (por id, por key, por provider+externalId) em src/modules/wagering/infrastructure/transaction-read-model.ts
- [X] T010 Implementar `AuthGuard`, `@Public()`, `AuthenticationPort` (noop/deny-all) e `ProviderIdentityPort` (registro de provedores) em src/platform/http/authentication.ts; marcar health como público

## Phase 3: User Story 1 — submeter e receber o desfecho (P1) 🎯 MVP

**Independent test**: BET 25.00 sobre 1000.00 → 200 PROCESSED 975.00 + 1 débito + eventos.

- [X] T011 [US1] Implementar `SubmitWagerTransaction` (contrato → caminho rápido → lock → recheck → referência e `ReversalView` → `SettlementPolicy` → gravação por caminho P1–P4 → eventos) em src/modules/wagering/application/submit-wager-transaction.ts
- [X] T012 [US1] Criar `WageringTransactionsController` (`POST /wagering/transactions`, corpo por status, `Location`) em src/modules/wagering/http/wagering-transactions.controller.ts e registrar em src/app.module.ts, src/platform/composition.ts, src/platform/bootstrap.ts e src/platform/tokens.ts
- [X] T013 [P] [US1] Criar o verificador SQL independente (saldo = Σ ledger, cabeça, efeito por status) em test/support/verifier.ts e incluí-lo nos oráculos de test/architecture/oracle-independence.test.ts
- [X] T014 [P] [US1] Criar helpers de teste (wallet, submissão, consultas) em test/support/wagering.ts
- [X] T015 [US1] [IT-11] 422 persistido + evento + replay; rejeições de referência (escopo, kind, valor, `REVERSAL_INSUFFICIENT_FUNDS`, limite); LOSS; WIN referenciando BET; 202 pendente — em test/integration/wagering-submit.test.ts
- [X] T016 [US1] [IT-07b] Atomicidade no caminho HTTP (`uow.beforeCommit` fail e kill) em test/integration/wagering-atomicity.test.ts

## Phase 4: User Story 2 — reenvios e chaves conflitantes (P1)

**Independent test**: replay da BET com corpo idêntico depois de uma WIN; 409 entre provedores.

- [X] T017 [US2] [IT-10a] (a) replay depois de WIN, (c) key global entre provedores, (d) externalId com key nova, (e) replay após recriar a app, replay de 202 e de 422 — em test/integration/wagering-idempotency.test.ts
- [X] T018 [P] [US2] [CT-01h] 50 envios idênticos em 3 instâncias + 2 payloads × 25 em test/concurrency/duplicates.test.ts
- [X] T019 [P] [US2] [CT-10] corridas de 23505 (externalId e key em wallets diferentes) em test/concurrency/unique-races.test.ts

## Phase 5: User Story 3 — disputa pelo saldo (P1)

**Independent test**: cenário do §8 com sobreposição comprovada.

- [X] T020 [P] [US3] Criar o lock-holder com espera de waiters em `pg_stat_activity` em test/support/contention.ts
- [X] T021 [US3] [CT-02h] §8 com contenção comprovada + 100 iterações em test/concurrency/balance-race.test.ts
- [X] T022 [P] [US3] [CT-03] wallets distintas em paralelo; o lock de A não bloqueia B em test/concurrency/independent-wallets.test.ts
- [X] T023 [P] [US3] [CT-04h] ≥ 3 instâncias, carga mista, contenção de 3 `application_name` em test/concurrency/mixed-load.test.ts
- [X] T024 [P] [US3] [CT-09] hot wallet até zero em test/concurrency/hot-wallet.test.ts
- [X] T025 [P] [US3] [CT-13] hot wallet saturando o pool; health continua respondendo em test/concurrency/pool-saturation.test.ts
- [X] T026 [US3] [CT-12] instância congelada (pause + SIGSTOP) segurando o lock; sessão ociosa encerrada pelo banco; retry com a mesma key em test/concurrency/frozen-instance.test.ts

## Phase 6: User Story 4 — consulta do estado atual (P2)

- [X] T027 [US4] Implementar `GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` em src/modules/wagering/http/wagering-transactions.controller.ts
- [X] T028 [US4] [IT-15] consultas: aplicada, pendente, inexistente e id inválido em test/integration/wagering-queries.test.ts

## Phase 7: User Story 5 — falhas distinguíveis (P2)

- [X] T029 [P] [US5] Criar proxy TCP de teste (`pass`/`blackhole`) em test/support/tcp-proxy.ts
- [X] T030 [US5] [IT-12] matriz 400/401/403/404/413/415 sem efeito; correção com a mesma key em test/integration/wagering-contract.test.ts
- [X] T031 [US5] [IT-13] lock além do lock_timeout → 503; banco congelado → 503 em ≤ query_timeout + δ; commit ambíguo → replay em test/integration/wagering-transient.test.ts
- [X] T032 [US5] [IT-18] health público e autenticação no-op/deny-all em test/integration/wagering-auth.test.ts

## Phase 8: Polish

- [X] T033 Implementar `--level full` (V2b) em scripts/smoke.ts
- [X] T034 [P] Atualizar o di-smoke (QG-05) com a nova porta em test/architecture/di-smoke.test.ts
- [X] T035 Atualizar ARCHITECTURE.md (estado, seção da F3) e README.md (endpoints, smoke, "Validado em")
- [X] T036 Rodar static, unit, integration e concurrency no Dev Container (incluindo o burn-in da etapa concurrency repetida, previsto no plano; se não for executado, relatar); depois, no host, `--phase F3`, `up --build -d` e smoke `full`

## Dependencies

- Setup (T001–T003) → Foundational (T004–T010) → US1 (T011–T016) → US2, US3, US4, US5 (testes) → Polish.
- T027 depende de T009; T021–T026 dependem de T020; T031 depende de T029.

## Parallel examples

- Foundational: T005, T006 e T009 em arquivos distintos.
- US3: T022–T025 depois de T020.

## Implementation strategy

MVP = US1 (submissão + 422/202 + atomicidade). Em seguida idempotência (US2), concorrência (US3),
consultas (US4) e falhas (US5); fechamento com o smoke V2b e a validação no host.
