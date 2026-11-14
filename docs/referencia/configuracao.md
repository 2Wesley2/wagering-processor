# Referência de configuração

Variáveis de ambiente da aplicação, com o padrão, a faixa aceita e o efeito de cada uma. A fonte é
[`src/platform/config/config.ts`](../../src/platform/config/config.ts); os valores que a stack usa
vêm do [`docker-compose.yml`](../../docker-compose.yml).

## Como a configuração é lida

- A aplicação e os comandos `verify`, `sqs:redrive`, `outbox:republish` e `retention:purge` leem o
  ambiente por `loadConfig`. Um valor fora da faixa ou uma combinação incoerente impede a subida:
  o processo registra o erro e sai com 1.
- Regras entre variáveis, conferidas no boot:
  - `DB_QUERY_TIMEOUT_MS` precisa ser maior que `DB_STATEMENT_TIMEOUT_MS`, para o banco cancelar a
    consulta antes de o cliente desistir.
  - `SQS_WAIT_TIME_S` × 1000 < `SHUTDOWN_DRAIN_MS` < `SHUTDOWN_HARD_TIMEOUT_MS`.
  - `FAULT_INJECTION` e `FAULT_PLAN` só são aceitas com `NODE_ENV=test`.
  - `AUTHENTICATION_ADAPTER=deny-all` só é aceito com `NODE_ENV=test`.
- Sem padrão, e portanto obrigatórias: `DATABASE_URL` e `SQS_ENDPOINT`.

## Como mudar um valor na stack

O Compose lê o arquivo `.env` da raiz, criado a partir do
[`.env.example`](../../.env.example). Esse arquivo só controla as variáveis da seção
[Variáveis do Compose](#variáveis-do-compose). As demais estão fixas no `docker-compose.yml`, nos
blocos `x-app-env` e `x-queues-env`, e mudam editando esse arquivo.

Na tabela, "Stack" é o valor que o `docker-compose.yml` passa às instâncias `app-1` a `app-3`.
"Padrão" vale quando a variável não é definida.

## Processo e HTTP

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `NODE_ENV` | `production` | `production`, `test`, `development` | Modo do processo; `test` libera os recursos só de teste | `production` |
| `APP_ROLES` | `api,consumer,outbox-publisher,pending-reference-worker` | lista separada por vírgula com `api`, `consumer`, `outbox-publisher`, `pending-reference-worker`, `events-projection` | Papéis ligados no processo; `events-projection` fica fora do padrão | o padrão |
| `INSTANCE_ID` | nome do host (até 64 caracteres) | `^[A-Za-z0-9._-]{1,64}$` | Identifica a instância nos logs e no header `X-Instance-Id` | `app-1`, `app-2`, `app-3` |
| `PORT` | `3000` | 0 a 65535 | Porta HTTP da instância | `3000` |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` | Nível dos logs | `${LOG_LEVEL:-info}` |
| `HEALTH_TIMEOUT_MS` | `1000` | 100 a 10000 | Prazo das sondas de PostgreSQL e SQS do `/health/ready` | o padrão |

## PostgreSQL

Os motivos dos timeouts estão no ARCHITECTURE,
[§6, 10 e 14](../../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3).

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `DATABASE_URL` | obrigatória | URL `postgres://` ou `postgresql://` | Conexão da aplicação (role `wagering_app`) | `postgres://wagering_app:…@postgres:5432/wagering` |
| `DB_POOL_MAX` | `10` | 1 a 100 | Conexões no pool da instância | `10` |
| `DB_LOCK_TIMEOUT_MS` | `2000` | 1 a 600000 | `lock_timeout` da transação: quanto esperar pelo lock da wallet | o padrão |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | 1 a 600000 | `statement_timeout` da transação | o padrão |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `15000` | 1 a 600000 | Encerra a sessão parada no meio de uma transação | o padrão |
| `DB_QUERY_TIMEOUT_MS` | `6000` | 1 a 600000, maior que `DB_STATEMENT_TIMEOUT_MS` | Prazo do cliente `pg` para uma consulta | o padrão |
| `DB_CONNECT_TIMEOUT_MS` | `2000` | 1 a 600000 | Prazo do cliente `pg` para abrir uma conexão | o padrão |

## Provedores e autenticação

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `PROVIDER_IDS` | `provider-a,provider-b` | lista não vazia; cada id em `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` | Provedores aceitos; os demais recebem 403 `PROVIDER_NOT_RECOGNIZED` | o padrão |
| `AUTHENTICATION_ADAPTER` | `noop` | `noop`; `deny-all` só com `NODE_ENV=test` | Adaptador da porta de autenticação | o padrão |

## Worker de pendências

A regra de prazo está no ARCHITECTURE,
[§13](../../ARCHITECTURE.md#13-pending_reference-e-worker-de-pendências-f4).

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `PENDING_REFERENCE_TTL_MS` | `1800000` (30 min) | 1 a 86400000 | Prazo de uma pendência, contado do aceite no relógio do PostgreSQL | o padrão |
| `WORKER_POLL_INTERVAL_MS` | `1000` | 10 a 600000 | Intervalo entre ciclos do worker | o padrão |
| `WORKER_BATCH_SIZE` | `50` | 1 a 500 | Pendências reivindicadas por ciclo | o padrão |
| `WORKER_LEASE_MS` | `30000` | 100 a 600000 | Validade da reserva (lease) de cada pendência | o padrão |
| `WORKER_BACKOFF_BASE_MS` | `1000` | 1 a 600000 | Base do backoff de reagendamento | o padrão |
| `WORKER_BACKOFF_MAX_MS` | `60000` | 1 a 3600000 | Teto do backoff de reagendamento | o padrão |

## SQS

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `AWS_REGION` | `us-east-1` | texto não vazio | Região do cliente SQS | `us-east-1` |
| `SQS_ENDPOINT` | obrigatória | URL `http://` ou `https://` | Endereço do SQS (MiniStack na stack) | `http://ministack:4566` |
| `SQS_INBOUND_QUEUE` | `wager-transactions.fifo` | texto não vazio | Fila de entrada das transações | o padrão |
| `SQS_DLQ` | `wager-transactions-dlq.fifo` | texto não vazio | Dead-letter queue da fila de entrada | o padrão |
| `SQS_EVENTS_QUEUE` | `wagering-events.fifo` | texto não vazio | Fila dos eventos de integração | o padrão |
| `SQS_WAIT_TIME_S` | `10` | 0 a 20 | Espera do long poll em cada recebimento | `10` |
| `SQS_VISIBILITY_TIMEOUT_S` | `30` | 1 a 43200 | Visibilidade das mensagens recebidas | `30` |
| `SQS_MAX_RECEIVE_COUNT` | `8` | 1 a 1000 | Recebimentos sem `ack` antes de a fila mover a mensagem para a DLQ | `8` |
| `SQS_PROVISION_ON_BOOT` | `0` | `0` ou `1` | Com `1`, recria as filas no boot e quando o SQS responde `QueueDoesNotExist`, sem purge | `1` |
| `REDRIVE_VISIBILITY_TIMEOUT_S` | `30` | 1 a 43200 | Visibilidade das cópias lidas da DLQ pelo `sqs:redrive` | o padrão |

O job `init-queues` lê `SQS_ENDPOINT`, `AWS_REGION`, os três nomes de fila, `SQS_WAIT_TIME_S`,
`SQS_VISIBILITY_TIMEOUT_S` e `SQS_MAX_RECEIVE_COUNT` por conta própria, com os mesmos padrões.

## Consumidor da fila de entrada

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `CONSUMER_NAME` | `wager-transactions` | `^[A-Za-z0-9._:-]{1,64}$` | Nome do consumidor; faz parte da identidade da inbox e da dead-letter | o padrão |
| `CONSUMER_POLLERS` | `4` | 1 a 32 | Recebimentos simultâneos por instância | o padrão |
| `CONSUMER_RETRY_BASE_S` | `1` | 0 a 900 | Base do backoff de reentrega em erro transitório | o padrão |
| `CONSUMER_RETRY_MAX_S` | `60` | 0 a 900 | Teto do backoff de reentrega | o padrão |
| `DEAD_LETTER_STUCK_AFTER_MS` | `900000` (15 min) | 1 a 86400000 | Idade de um descarte em `PENDING_DLQ` que gera o alerta `dead_letter_pending_stuck` | o padrão |
| `CONSUMER_BREAKER_OPEN_MS` | `5000` | 100 a 600000 | Tempo em que a recepção fica suspensa quando o PostgreSQL falha | o padrão |

## Outbox e retenção

A retenção e a republicação estão explicadas no ARCHITECTURE,
[§17](../../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6).

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `OUTBOX_POLL_INTERVAL_MS` | `200` | 10 a 600000 | Intervalo entre ciclos do publicador | o padrão |
| `OUTBOX_BATCH_SIZE` | `10` | 1 a 10 | Eventos por envio (`SendMessageBatch` aceita até 10) | o padrão |
| `OUTBOX_LEASE_MS` | `30000` | 100 a 600000 | Validade da reserva de um lote | o padrão |
| `OUTBOX_BACKOFF_BASE_MS` | `1000` | 1 a 600000 | Base do backoff de reenvio | o padrão |
| `OUTBOX_BACKOFF_MAX_MS` | `300000` (5 min) | 1 a 3600000 | Teto do backoff de reenvio | o padrão |
| `RETENTION_INBOX_DAYS` | `30` | 30 a 3650 | Idade a partir da qual a inbox processada é apagada | o padrão |
| `RETENTION_OUTBOX_DAYS` | `7` | 7 a 3650 | Idade, contada da publicação, a partir da qual a outbox publicada é apagada | o padrão |
| `RETENTION_BATCH_SIZE` | `1000` | 1 a 10000 | Tamanho do lote da limpeza | o padrão |
| `RETENTION_INTERVAL_MS` | `3600000` (1 h) | 1000 a 86400000 | Intervalo da limpeza automática no papel `outbox-publisher` | o padrão |

## Encerramento

A sequência de encerramento está no ARCHITECTURE, [§12](../../ARCHITECTURE.md#12-mensageria-e-falhas-f5)
e [§15](../../ARCHITECTURE.md#15-ambiente).

| Variável | Padrão | Aceito | Efeito | Stack |
|---|---|---|---|---|
| `SHUTDOWN_DRAIN_MS` | `20000` | 0 a 600000 | Espera pelo trabalho em andamento depois do `SIGTERM` | `20000` |
| `SHUTDOWN_HARD_TIMEOUT_MS` | `30000` | 1 a 600000 | Limite total; ao estourar, o processo sai com 1 | `30000` |
| `READINESS_DRAIN_DELAY_MS` | `0` | 0 a 60000 | Espera entre marcar o `ready` como 503 e começar a drenar | o padrão |
| `SHUTDOWN_CLOSE_TIMEOUT_MS` | `2000` | 100 a 60000 | Prazo de cada fechamento de recurso (pool, clientes) depois do HTTP | o padrão |

## Só para testes

Fora de `NODE_ENV=test`, `FAULT_INJECTION` e `FAULT_PLAN` impedem a aplicação de subir.

| Variável | Padrão | Aceito | Efeito |
|---|---|---|---|
| `EXIT_ON_STDIN_EOF` | `0` | `0` ou `1` | Com `1`, a instância sai quando a entrada padrão fecha; o harness usa isso para não deixar processos órfãos |
| `FAULT_INJECTION` | ausente | só `enabled` | Liga a injeção de falhas |
| `FAULT_PLAN` | ausente | JSON: lista de `{point, match?, action}`; exige `FAULT_INJECTION=enabled` | Pontos de falha a acionar; `action` é `kill`, `pause`, `fail` ou `failOnce` |

Os pontos aceitos em `point` estão em `FAULT_POINTS`, no mesmo arquivo `config.ts`.

## Variáveis do Compose

Lidas do `.env` pelo `docker-compose.yml`, não pela aplicação diretamente.

| Variável | Padrão | Efeito |
|---|---|---|
| `HTTP_PORT` | `8080` | Porta publicada do nginx no host |
| `HTTP_BIND` | `127.0.0.1` | Interface do host em que o nginx é publicado |
| `POSTGRES_PASSWORD` | `postgres` | Senha do superusuário; só vale na criação do volume do banco |
| `OWNER_DB_PASSWORD` | `wagering_owner` | Senha do role `wagering_owner`, usada pelo job `migrate` |
| `APP_DB_PASSWORD` | `wagering_app` | Senha do role `wagering_app`, usada pelo `migrate` e pela `DATABASE_URL` das instâncias |
| `LOG_LEVEL` | `info` | Repassado às instâncias e aos jobs |

O job `migrate` também lê `PG_ADMIN_URL` (obrigatória), `APP_DB_NAME` (padrão `wagering`),
`OWNER_DB_PASSWORD` e `APP_DB_PASSWORD` (obrigatórias), que o `docker-compose.yml` monta a partir das
variáveis acima.
