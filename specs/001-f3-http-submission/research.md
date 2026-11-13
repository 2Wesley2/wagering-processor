# Research: F3

Não havia "NEEDS CLARIFICATION": as decisões vêm do plano (D23–D33) e de I1/I2. Registro só as
escolhas de desenho que o plano deixava em aberto.

## R1 — Onde decidir replay × conflito

- **Decision**: caminho rápido sem lock (read model) e nova checagem sob o lock da wallet; 23505 em
  `wtx_idempotency_key_uq` ou `wtx_provider_external_uq` relê e classifica.
- **Rationale**: duplicatas na mesma wallet viram replay pela fila do lock; duplicatas que miram
  wallets diferentes só se encontram no índice único (D26, D27).
- **Alternatives**: estado "em andamento" persistido (rejeitado: D27 dispensa; cria limpeza e órfãos).

## R2 — Corpo da resposta original (I1 = A)

- **Decision**: 200/202 com `{transactionId, status, balance, idempotentReplay}`; 422 em
  `application/problem+json` com `code = failureCode`, `transaction {transactionId, status,
  failureCode, balance}` e `idempotentReplay`. `detail` é fixo por código e `correlationId` é o
  gravado na transação, para o corpo do replay ser idêntico. 200/202/422 levam
  `Location: /wagering/transactions/:id`.
- **Rationale**: o §9 pede "mesma resposta"; nada no corpo pode depender da requisição de replay.
- **Alternatives**: correlationId da requisição atual no corpo (rejeitado: quebraria a igualdade).

## R3 — Reversões dependentes de P1/P2

- **Decision**: `ReversalView` lida sob o lock; para WIN/LOSS só entram as reversões do alvo; para
  REFUND/ROLLBACK entram também os WIN que liquidam o alvo. Visão não vazia → a regra indecidida
  lança `ReversalRuleUndecidedError` → 500 sem gravar nada.
- **Rationale**: vários WIN por BET são permitidos (A10) e nenhuma opção de P2 os afeta; só os casos
  realmente dependentes falham alto.

## R4 — Timeouts do driver e sessão ociosa

- **Decision**: `query_timeout`, `connectionTimeoutMillis` e `keepAlive` passados ao pool do `pg`
  (via `driverOptions` do MikroORM 7); `idle_in_transaction_session_timeout` aplicado por
  `set_config(..., true)` na UnitOfWork, junto de lock/statement timeout.
- **Rationale**: D25; o `query_timeout` cobre o banco que não responde (IT-13), e a sessão ociosa
  em transação libera a wallet de uma instância congelada (CT-12).

## R5 — Autenticação (U1)

- **Decision**: `APP_GUARD` com `AuthenticationPort` (`noop` por padrão; `deny-all` aceito só com
  `NODE_ENV=test`, para o IT-18) e `@Public()` nos health checks; `ProviderIdentityPort` confere o
  registro `PROVIDER_IDS` (padrão `provider-a,provider-b`). Código novo `AUTHENTICATION_REQUIRED` (401).
- **Rationale**: ponto de extensão explícito exigido pelo §2 sem implementar IdP.

## R6 — Prova de contenção e de falha nos testes

- **Decision**: um cliente de teste segura `FOR UPDATE` na wallet e espera, em `pg_stat_activity`,
  backends `app:<instância>` em espera de lock antes de soltar; banco "congelado" por um proxy TCP
  de teste (`pass`/`blackhole`), sem docker.sock (D46, D47, D52).
