# Referência de comandos

Comandos de operação da aplicação (`src/cli/`) e scripts de teste e qualidade (`scripts/` e
`package.json`). Tudo roda em contêiner: o host só precisa do Docker com o Compose.

## Resumo

| Comando | Onde roda | Efeito |
|---|---|---|
| [`migrate`](#migrate) | Job do Compose, a cada `docker compose up` | Escreve: roles, banco e migrations |
| [`init-queues`](#init-queues) | Job do Compose, a cada `docker compose up` | Escreve: cria ou ajusta as filas |
| [`healthcheck`](#healthcheck) | Instância da aplicação | Só lê |
| [`boot-check`](#boot-check) | Build da imagem `runtime` | Só importa o código |
| [`verify`](#verify) | Instância da aplicação | Só lê |
| [`sqs:redrive`](#sqsredrive) | Instância da aplicação | Escreve: devolve mensagens da DLQ à fila de entrada |
| [`outbox:republish`](#outboxrepublish) | Instância da aplicação | Escreve: reenvia eventos à fila de eventos |
| [`retention:purge`](#retentionpurge) | Instância da aplicação | Escreve: apaga inbox e outbox antigas |
| [`test:all`](#testes-e-qualidade) | Contêiner `tests` | Roda a suíte |
| [`test:smoke`](#testes-e-qualidade) | Contêiner `tests`, com a stack no ar | Escreve uma wallet de demonstração no modo `full` |
| [`test:report`](#testes-e-qualidade) | Contêiner `tests` | Só lê o volume de resultados |
| [`persist:seed` e `persist:check`](#testes-e-qualidade) | Contêiner `persist-tool` | MiniStack isolado, nunca o da aplicação |
| [`typecheck`, `lint`, `format`, `format:check`](#testes-e-qualidade) | Contêiner `tests` ou Dev Container | Só leem, exceto `format`, que reescreve arquivos |

Os comandos que leem a configuração da aplicação (`verify`, `sqs:redrive`, `outbox:republish`,
`retention:purge`) usam as mesmas variáveis das instâncias; veja a
[referência de configuração](configuracao.md). Todos saem com 0 em sucesso e com 1 em falha.

## Comandos da aplicação

### `migrate`

Cria os roles `wagering_owner` e `wagering_app`, garante o banco e aplica as migrations pendentes sob
advisory lock. O Compose roda `bun src/cli/migrate.ts up` no serviço `migrate` antes de subir as
instâncias, e rodar de novo é seguro: um segundo `docker compose up -d` termina com
`"executed":[]`. Exemplo real do log:

```json
{"event":"migrate.done","direction":"up","executed":[],"alreadyApplied":4,"pending":[]}
```

Lê `PG_ADMIN_URL`, `OWNER_DB_PASSWORD` e `APP_DB_PASSWORD` (obrigatórias) e `APP_DB_NAME` (padrão
`wagering`). O argumento `down` desfaz a última migration aplicada; o Compose nunca o usa, e ele não
deve ser rodado na stack. Uma migration aplicada e depois editada faz o comando falhar (ver o
ARCHITECTURE, [§15](../../ARCHITECTURE.md#15-ambiente)).

### `init-queues`

Cria ou ajusta a DLQ, a fila de entrada e a fila de eventos, nessa ordem. Nunca faz purge nem apaga
filas. Roda no serviço `init-queues` do Compose. Os atributos estão na
[referência de mensagens](mensagens.md#filas).

### `healthcheck`

Consulta `/health/live` e `/health/ready` da própria instância e sai com 0 só se os dois responderem
200. Com `--quiet`, não imprime nada; é assim que o healthcheck do Compose o usa.

```bash
docker compose exec app-1 bun run healthcheck
```

Saída real:

```json
{
  "live": { "status": 200, "body": { "status": "ok", "instance": "app-1", "uptimeS": 43438 } },
  "ready": {
    "status": 200,
    "body": { "status": "ready", "instance": "app-1", "draining": false, "checks": { "postgres": "up", "sqs": "up" } }
  }
}
```

### `boot-check`

Importa o grafo de módulos de produção sem conectar em nada e imprime `boot_check.ok`. Roda no
build da imagem `runtime`, que só tem as dependências de produção: se o código de `src/` usar uma
dependência de desenvolvimento, o build falha.

### `verify`

Confere as invariantes do sistema inteiro num snapshot só de leitura, sem corrigir nada: saldo igual
à soma do ledger, cadeia de versões, lançamentos só de transações com efeito, uma reversão em vigor
por aposta e eventos na outbox. Sai com 1 se encontrar violação.

```bash
docker compose exec app-1 bun run verify
```

Saída real (última linha):

```json
{"event":"verify.done","consistent":true,"checks":8,"violations":[],"counters":{"wallets":"7","transactions":"22","ledger_entries":"20","pending_references":"1","outbox_unpublished":"0","dead_letters_open":"0"}}
```

### `sqs:redrive`

Devolve à fila de entrada as cópias que estão na DLQ. Rodar de novo é seguro: uma cópia antiga ou já
devolvida só é apagada.

```bash
docker compose exec app-1 bun run sqs:redrive
```

| Opção | Efeito |
|---|---|
| `--idle-rounds N` | Quantas leituras seguidas sem trabalho encerram o comando; padrão 2, mínimo 1 |

Cada cópia gera uma linha de log (`redrive.sending`, `redrive.sent`, `redrive.obsolete`,
`redrive.skipped` ou `redrive.deferred`), e o fim é a linha `redrive.done`, com as contagens
`redriven`, `obsolete`, `skipped` e `deferred`. Uma mensagem que falha de novo volta à DLQ e fica para
a execução seguinte. As regras estão no ARCHITECTURE, [§12](../../ARCHITECTURE.md#12-mensageria-e-falhas-f5).

### `outbox:republish`

Reenvia à fila de eventos eventos já publicados que ainda estão na tabela `outbox_messages`. O
`eventId` não muda, e cada execução usa um `MessageDeduplicationId` novo.

```bash
docker compose exec app-1 bun run outbox:republish --since 2026-11-13T00:00:00Z
```

| Opção | Efeito |
|---|---|
| `--since <ISO>` | Obrigatória: só eventos a partir desse instante |
| `--until <ISO>` | Só eventos até esse instante |
| `--aggregate <walletId>` | Só eventos dessa wallet |
| `--event <eventId>` | Só esse evento |

O resumo sai na linha `outbox.republished`, com `runId`, `selected`, `republished` e `failed`. Se algum
envio falhar, o comando sai com 1. Eventos ainda não publicados ficam com o publicador. Os limites da
recuperação estão no ARCHITECTURE,
[§17](../../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6).

### `retention:purge`

Roda uma vez a limpeza que o papel `outbox-publisher` já faz a cada hora: apaga a inbox processada
há mais de `RETENTION_INBOX_DAYS` dias e a outbox publicada há mais de `RETENTION_OUTBOX_DAYS` dias.
Nada financeiro e nenhum evento pendente é apagado.

```bash
docker compose exec app-1 bun run retention:purge
```

O resultado sai na linha `retention.purged`, com `inboxDeleted`, `outboxDeleted`, `inboxDays` e
`outboxDays`.

## Testes e qualidade

| Comando | O que faz |
|---|---|
| `docker compose run --rm --build tests` | Suíte completa com meta-check estrito (`scripts/test-all.ts` sem argumentos) |
| `docker compose run --rm --build tests bun scripts/test-all.ts --phase F3` | Testes existentes, estrito só para os IDs obrigatórios até a fase |
| `docker compose run --rm --build tests bun scripts/test-all.ts unit integration` | Só as etapas citadas (`static`, `conformance`, `unit`, `integration`, `concurrency`, `resilience`); o meta-check fica informativo |
| `docker compose run --rm tests bun scripts/test-all.ts --selfcheck` | Falha proposital; precisa sair com 1 |
| `docker compose run --rm --no-deps tests bun run test:smoke --level health` | Health e distribuição entre as instâncias pelo nginx; padrão quando `--level` falta |
| `docker compose run --rm --no-deps tests bun run test:smoke --level full` | Fluxo de negócio pelo nginx, com uma wallet de demonstração nova |
| `docker compose run --rm --no-deps tests bun run test:report [runId]` | Reimprime o resumo da última execução, ou da indicada, sem rodar testes |
| `docker compose --profile persist-check run --rm persist-tool bun run persist:seed` | Prepara filas e mensagens no MiniStack isolado `ministack-persist` |
| `docker compose --profile persist-check run --rm persist-tool bun run persist:check` | Registra o que sobreviveu a um reinício desse MiniStack |
| `bun run typecheck`, `bun run lint`, `bun run format:check` | `tsc --noEmit`, ESLint e Prettier; a etapa `static` já roda os três |
| `bun run format` | Reescreve os arquivos com o Prettier |

Os quatro últimos rodam dentro do contêiner `tests` ou do Dev Container. Por exemplo:
`docker compose run --rm --build --no-deps tests bun run format:check`.

O pipeline de testes está explicado no ARCHITECTURE, [§15](../../ARCHITECTURE.md#15-ambiente), e o
histórico de execuções, no [histórico de validações](../validacao.md).
