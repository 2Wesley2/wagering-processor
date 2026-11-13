# Implementation Plan: F3 — Submissão HTTP de transações, idempotência e concorrência

**Branch**: nenhuma (trabalho em `main`, sem branch própria) | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-f3-http-submission/spec.md`

## Summary

Expor `POST /wagering/transactions` e as duas consultas de transação sobre a arquitetura da F2.
Um caso de uso `SubmitWagerTransaction` (camada `application` do módulo `wagering`) valida o
contrato, faz o caminho rápido de idempotência sem lock, trava a wallet com `SELECT … FOR UPDATE`
dentro da `UnitOfWork`, decide com a `SettlementPolicy` da F1 e grava transação, saldo,
lançamento e outbox na mesma transação SQL (plano D23–D33). O replay devolve a resposta original
montada só das colunas imutáveis (`initial_status`, `accepted_*`, `failure_code` original,
`correlation_id`), conforme I1 = opção A. Sem migration nova.

## Technical Context

**Language/Version**: TypeScript 6.0.3 (strict) sobre Bun 1.4.4, só em contêineres

**Primary Dependencies**: NestJS 12.4 (Express), MikroORM 7.2.8 + pg 8.23, zod 4.6

**Storage**: PostgreSQL 18.6, migration `0001` (inalterada)

**Testing**: `bun test` via `scripts/test-all.ts`; PostgreSQL e MiniStack reais; instâncias reais
da app como processos (`test/support/instances.ts`)

**Target Platform**: Linux (Docker Compose), host Windows ou Linux

**Project Type**: web-service (monólito modular)

**Performance Goals**: sem meta de RPS; correção sob concorrência é o critério

**Constraints**: dinheiro nunca `number`; uma wallet por transação SQL; sem lock global; ack/resposta
só depois do commit; timeouts de teste lock 10 s / statement 15 s

**Scale/Scope**: ≥ 3 instâncias; cenários de 50 a 200 requisições paralelas por teste

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constituição 0.3.1 (rascunho, não ratificada; a I1 aparece lá como pendente por defasagem
documental — vale a decisão registrada em `ARCHITECTURE.md` §1).

| Princípio | Como a F3 atende | Status |
|---|---|---|
| I Precisão monetária | `Money` (bigint) do domínio; SQL com `::numeric` a partir de string | OK |
| II Wallet e ledger | débito/crédito só por `Wallet.debit/credit`; LOSS/REJECTED/PENDING sem lançamento; triggers diferidas da 0001 | OK |
| III Banco como autoridade | constraints existentes; 23505 classificado por nome | OK |
| IV Concorrência por wallet | `FOR UPDATE` por wallet + `UPDATE … WHERE version = esperada` | OK |
| V Idempotência | key global (I2), replay congelado (I1), 409 sem dados alheios | OK |
| VI Regras | precedência comum; P1/P2 lançam `ReversalRuleUndecidedError` | OK |
| VII Outbox | eventos gravados na mesma transação; publicação só na F5 | OK |
| VIII Respostas distinguíveis | catálogo único; 401 novo para autenticação negada | OK |
| IX Testes reais | IDs do catálogo, instâncias reais, verificador SQL independente | OK |
| XII Autenticação | `AuthGuard` + `AuthenticationPort` no-op, `ProviderIdentityPort` | OK |
| XIII Nomes e tipos | nomes completos; sem afirmação de tipo em dados externos | OK |

Sem violações; *Complexity Tracking* não se aplica.

## Project Structure

### Documentation (this feature)

```text
specs/001-f3-http-submission/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/http.md
├── checklists/requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
src/modules/wagering/
├── application/submit-wager-transaction.ts   # caso de uso (novo)
├── application/ports.ts                      # TransactionStore, TransactionQueries (novo)
├── application/original-response.ts          # resposta original + mapeamento de linhas (novo)
├── http/wagering-transactions.controller.ts  # POST + 2 GETs (novo)
├── infrastructure/sql-transaction-repository.ts  # + pendente, buscas, ReversalView
└── infrastructure/transaction-read-model.ts  # leituras com record do ORM (novo)
src/modules/wallet/application/ports.ts       # + lockForUpdate / saveBalance
src/modules/wallet/infrastructure/sql-wallet-repository.ts
src/platform/http/authentication.ts           # AuthGuard, @Public, portas no-op (novo)
src/platform/persistence/{unit-of-work.ts,records.ts}
src/platform/config/config.ts                 # provedores, adaptador de auth, timeouts do driver
src/shared/error-catalog.ts                   # + AUTHENTICATION_REQUIRED (401)
scripts/smoke.ts                              # --level full (V2b)
test/integration/wagering-*.test.ts           # IT-07b, IT-10a, IT-11, IT-12, IT-13, IT-15, IT-18
test/concurrency/*.test.ts                    # CT-01h, CT-02h, CT-03, CT-04h, CT-09, CT-10, CT-12, CT-13
test/support/{verifier.ts,tcp-proxy.ts,wagering.ts}
test/meta/required.ts                         # DECIDED inclui I1
```

**Structure Decision**: monólito modular existente; a F3 só acrescenta arquivos nos módulos
`wagering`, `wallet` e `platform`, respeitando `wagering → wallet → shared` (QG-03).

## Complexity Tracking

Não se aplica.
