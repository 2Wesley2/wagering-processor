# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND e
ROLLBACK) recebidas de múltiplos provedores de jogos, por HTTP e por uma fila SQS. Ele mantém o
saldo materializado de cada wallet consistente com um ledger imutável, com idempotência
persistente, e publica eventos de integração. O enunciado está em
[docs/CHALLENGE.md](docs/CHALLENGE.md). Stack: Bun, TypeScript estrito, NestJS, PostgreSQL, SQS
(emulado pelo MiniStack) e Docker Compose.

> **A suíte completa passou em uma cópia limpa no Windows 11 com Docker Desktop e WSL 2** (ver
> [Validado em](#validado-em)).

Para avaliar o projeto, siga nesta ordem: [Pré-requisitos](#pré-requisitos),
[Subir e verificar o serviço](#subir-e-verificar-o-serviço) e
[Rodar a suíte completa](#rodar-a-suíte-completa). As decisões e as limitações estão em
[ARCHITECTURE.md](ARCHITECTURE.md); a rastreabilidade enunciado → testes, em
[docs/traceability.md](docs/traceability.md). Para consultar os termos do domínio e siglas como
`F3`, veja o [glossário do projeto](docs/glossario.md).

## Pré-requisitos

Só Docker, com o comando `docker compose` disponível. Não é preciso instalar Bun, Node.js,
PostgreSQL nem MiniStack no host: tudo roda em contêineres Linux.

- **Windows 11:** Docker Desktop com backend WSL 2, em modo *Linux containers*.
- **Linux:** Docker Engine com o plugin Compose (comando `docker compose`).

Os comandos abaixo são os mesmos no PowerShell (7 ou 5.1) e no bash. Rode cada
linha separadamente, na raiz do repositório.

## Subir e verificar o serviço

1. Confira o Docker e a configuração do Compose:

   ```bash
   docker version
   docker compose version
   docker compose config --quiet
   ```

   O `docker version` precisa mostrar o servidor com `OS/Arch: linux/…`. O
   `config --quiet` não imprime nada quando o `docker-compose.yml` e o `.env` são válidos.

2. Suba a stack:

   ```bash
   docker compose up --build -d
   ```

   Na primeira subida o Compose constrói as imagens, sobe PostgreSQL e MiniStack,
   espera os health checks, roda os jobs `migrate` (roles, banco, migrations) e
   `init-queues` (filas FIFO e DLQ) e só então sobe três instâncias da aplicação
   atrás do nginx. Subir de novo é seguro: os jobs são idempotentes e não apagam dados.

   A API fica em `http://localhost:8080` (só na interface local). Para mudar a porta
   ou as senhas locais, copie `.env.example` para `.env` e edite (opcional).

3. Confira o estado, a saúde e as invariantes:

   ```bash
   docker compose ps
   docker compose exec app-1 bun run healthcheck
   docker compose exec app-1 bun run verify
   ```

   - `docker compose ps`: `app-1`, `app-2`, `app-3`, `postgres` e `ministack` aparecem
     `(healthy)`, e o `nginx`, `Up`.
   - `healthcheck`: imprime um JSON com `live` e `ready` em `"status": 200`; em `ready`,
     `checks` traz `"postgres": "up"` e `"sqs": "up"`.
   - `verify`: confere as invariantes do sistema inteiro (saldo = soma do ledger, cadeia de
     versões, lançamentos só de transações com efeito, uma reversão em vigor por aposta,
     eventos na outbox) num snapshot só de leitura, sem corrigir nada. Imprime uma linha
     JSON `verify.done` com `"consistent": true` e sai com 1 se encontrar violação.

   Os mesmos sinais de saúde existem por HTTP:

   - `GET /health/live`: o processo está vivo.
   - `GET /health/ready`: pronto para tráfego (não está drenando, PostgreSQL e SQS respondem).

4. Opcional: percorra o fluxo de negócio pelo nginx, com a stack no ar:

   ```bash
   docker compose run --rm --no-deps tests bun run test:smoke --level full
   ```

   O nível `full` (V2b) cria uma wallet de demonstração nova a cada execução, com R$ 100,00
   (nada é apagado). A BET de R$ 30,00 deixa R$ 70,00, e o WIN de R$ 50,00, que referencia a
   BET, leva o saldo a R$ 120,00. O replay da BET devolve os R$ 70,00 da resposta original, com
   `idempotentReplay: true`, e a reconciliação confirma R$ 120,00 e três lançamentos (abertura,
   BET e WIN). Cada passo imprime `ok`, e a última linha começa com `SMOKE full: OK`. Para
   conferir só o health e a distribuição entre as instâncias:
   `docker compose run --rm --no-deps tests bun run test:smoke --level health`.

## Rodar a suíte completa

```bash
docker compose run --rm --build tests
```

Os testes rodam no contêiner `tests`, contra um PostgreSQL e um MiniStack de
teste próprios (perfil `test`), separados dos dados da aplicação. O comando roda
todas as etapas e termina com a linha `RESULTADO: OK (exit 0) em … s` quando tudo passa. Na
execução de referência (d4kexx29) levou 623 s, com pico de memória de 1347 MiB no
contêiner.

- Sem argumentos, a suíte completa roda com **meta-check estrito**. O catálogo tem 133 IDs:
  os 132 obrigatórios precisam estar em PASS (qualquer FAIL, BLOCKED, SKIPPED ou NOT
  IMPLEMENTED dá exit ≠ 0), e um é informativo (SPK-01, o spike de MikroORM 7 + ALS + pg no
  Bun): aparece no relatório, mas fica fora do escopo estrito (se o teste dele falhar, a etapa
  falha do mesmo jeito). Desde a F6 todos os IDs existem, e o comando termina com exit 0 quando
  tudo passa (ver [Validado em](#validado-em)). As execuções antigas registradas com exit 1
  "como esperado" são de quando as fases seguintes ainda não existiam.
- Um ID marcado como `BLOCKED` por um pré-requisito não conta como PASS, mesmo que algum caso
  dele tenha passado; uma falha real continua `FAIL`.

### Outros comandos de teste

```bash
docker compose run --rm --build tests bun scripts/test-all.ts --phase F0
docker compose run --rm --build tests bun scripts/test-all.ts unit
docker compose run --rm --no-deps tests bun run test:report
```

- `--phase Fn` roda os testes existentes e é estrito só para os IDs até a fase `n`.
- Etapas disponíveis: `static`, `conformance`, `unit`, `integration`, `concurrency`, `resilience`.
  Ao citar etapas, o meta-check é só informativo e o exit vem das etapas executadas.
- `test:report` reimprime o resumo da última execução a partir do volume `test-artifacts`, sem
  rodar testes.
- A etapa `static` roda `tsc`, ESLint com `--max-warnings 0` (com as regras do plugin
  eslint-plugin-sonarjs; não é o SonarQube completo) e `prettier --check`. Para conferir só a formatação:
  `docker compose run --rm --build --no-deps tests bun run format:check`.
- Prova de que falhas chegam ao exit code: `docker compose run --rm tests bun scripts/test-all.ts --selfcheck` (deve sair com 1).

## Integração contínua (GitHub Actions)

O workflow [`.github/workflows/ci.yml`](.github/workflows/ci.yml) roda a mesma suíte completa desta
página num runner `ubuntu-24.04` do GitHub.

| Item | Valor |
|---|---|
| Gatilhos | push na `main`, pull request e disparo manual (`workflow_dispatch`) |
| Job | "Suíte completa (Docker Compose)", com limite de 45 min |
| Passos | versões do Docker e do Compose; `docker compose config --quiet`; `docker compose run --rm --build tests`; depois, mesmo em caso de falha, o resumo do `test:report` e `docker compose --profile test down -v` |
| Permissões | nenhuma por padrão; o job só lê o repositório (`contents: read`) e não usa segredos |
| Actions de terceiros | só `actions/checkout`, fixada por SHA (v7.0.1) e sem guardar a credencial no checkout |
| Execuções repetidas | em pull request, um push novo cancela a execução anterior; na `main`, cada commit roda até o fim |

O job falha nas mesmas condições da execução local: uma etapa com falha ou um ID obrigatório fora de
`PASS`. Como não há segredos, pull requests de forks rodam com o token só de leitura que o GitHub dá
a eles.

Comandos úteis, com o GitHub CLI (`gh`) autenticado no repositório:

```bash
gh workflow enable ci.yml
gh workflow run ci.yml
gh run list --workflow ci.yml
gh run watch
```

`gh run watch` acompanha a execução escolhida até o fim; a última linha do passo da suíte começa com
`RESULTADO:`, como na execução local.

**Situação atual:** o workflow está desativado no GitHub e ainda não tem execução registrada. Para
ativá-lo, use `gh workflow enable ci.yml`. Enquanto nenhuma execução passar, a validação registrada
em [Validado em](#validado-em) continua sendo a do Windows 11.

Para conferir o workflow antes de um commit, sem instalar nada no host:

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -no-color
```

Sem erros, o comando não imprime nada e sai com 0.

## Validado em

| Item | Valor |
|---|---|
| Sistema | Windows 11 Pro 10.0.26200 |
| Docker | Docker Desktop 4.99.0 com backend WSL 2 (kernel 6.18.58.1-microsoft-standard-WSL2); Engine 29.9.3 |
| Docker Compose | v5.7.0 (versão validada) |
| Shell | PowerShell 7 no host; rodadas de desenvolvimento no Dev Container (`wagering-dev`) |
| Suíte completa | run d4kexx29 (2026-11-13): **exit 0**; 133 IDs em PASS, sendo 132 obrigatórios e 1 informativo (SPK-01); 0 FAIL, 0 BLOCKED, 0 SKIPPED, 0 NOT IMPLEMENTED |
| Onde | cópia limpa dos arquivos de entrega (sem `.git`, `node_modules`, `.env` nem resultados antigos), num projeto Compose isolado |
| Clone Git real | run ixbxe23v (2026-11-13): **exit 0** num `git clone --no-local` do histórico (HEAD `6cb10ec`), num projeto Compose isolado; 133 IDs em PASS, 0 FAIL, 0 BLOCKED, 0 SKIPPED, 0 NOT IMPLEMENTED |
| Depois de `6cb10ec` | os commits seguintes alteram só documentação em Markdown (`README.md`, `ARCHITECTURE.md`, `docs/traceability.md` e `docs/glossario.md`): o registro desta validação, o glossário, as legendas e a pontuação. Código, testes e configuração continuam os de `6cb10ec`. Nenhum teste nem imagem lê esses arquivos, e a suíte não foi executada de novo nesses commits |

Os códigos `V` nesta seção e no histórico identificam as verificações da stack e da entrega:

| Código | O que confere |
|---|---|
| V1 | Subir a stack duas vezes: a segunda não aplica migrations nem recria contêineres |
| V2a / V2b | Smoke pelo nginx: só health e distribuição entre as instâncias / fluxo de negócio completo |
| V3 | Suíte completa com meta-check estrito numa cópia limpa ou num clone novo |
| V4 | Falha proposital (`--selfcheck`), que precisa terminar com exit ≠ 0 |
| V5 | Logs, `down` sem `-v` e dados preservados na volta |
| V6 | `bun.lock` reproduzido com `--frozen-lockfile` |
| V7 | `SIGKILL` numa instância sob tráfego, seguido de `verify` consistente |
| V8 | Isolamento entre a suíte e a stack da aplicação; a variante com `wsl --shutdown` não foi executada |
| V9a / V9b / V9c | MiniStack isolado: reinício normal / queda abrupta; perda do broker na stack seguida de `outbox:republish` |

Ainda não executado: PowerShell 5.1, Linux nativo, o V8 completo (`wsl --shutdown` com a stack no
ar), `down -v` num clone descartável e o teste de carga opcional (`test:load`, não implementado).
Os volumes do projeto isolado da F7 (`wagering-f7clean_*`) ficaram no host; para removê-los, se
quiser: `docker compose -p wagering-f7clean --profile "*" down -v` (apaga só os dados desse projeto).

O histórico completo, com as 49 execuções registradas de 2026-11-11 a 2026-11-13, está em
[docs/validacao.md](docs/validacao.md).

## O que está implementado

- Infraestrutura de contêineres, domínio e schema financeiro no PostgreSQL.
- Endpoints de wallet e submissão de transações por HTTP e pela fila SQS: mesmo caso de uso,
  inbox na mesma transação SQL e ack depois do commit.
- Regras de reversão (P1 = C, P2 = (c)) e worker de pendências.
- Publicador da outbox, DLQ com registro no PostgreSQL e `sqs:redrive`.
- Logs e métricas do §12, limpeza por retenção, `outbox:republish` e `verify`.

## API HTTP

Criar uma wallet com saldo inicial:

```bash
curl -s -X POST http://localhost:8080/wallets -H "content-type: application/json" -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

O `playerId` do exemplo é fixo: se a wallet desse player em BRL já existir, repetir o comando
devolve 409 `WALLET_ALREADY_EXISTS` com o `existingWalletId`. Para criar outra, troque o
`playerId`. O smoke não esbarra nisso, porque gera um `playerId` novo a cada execução.

| Método e rota | Resposta principal |
|---|---|
| `POST /wallets` | 201 com `Location` |
| `GET /wallets/:id` | 200 com saldo e versão atuais |
| `GET /wallets/:id/ledger?limit=50&cursor=…` | 200 com os lançamentos em ordem de `walletVersion` |
| `POST /wallets/:id/reconciliation` | 200 com a comparação entre o saldo e Σ ledger |
| `POST /wagering/transactions` | 200 aplicada, 202 aguardando referência ou 422 rejeitada |
| `GET /wagering/transactions/:id` | 200 com o estado atual da transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | a mesma visão, pelo id do provedor |

O 202 indica que a transação referenciada ainda não tem desfecho: ela não chegou, ou chegou e
também está `PENDING_REFERENCE`. A nova transação fica `PENDING_REFERENCE` até o worker (papel
`pending-reference-worker`, ligado nas três instâncias) decidi-la quando a referência tiver
desfecho, ou rejeitá-la com `REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED` depois do prazo
`PENDING_REFERENCE_TTL_MS` (padrão 30 min, contado pelo relógio do PostgreSQL). Repetir o POST com
a mesma `Idempotency-Key` e o mesmo payload devolve o código e o corpo da primeira resposta, só com
`idempotentReplay: true`; isso vale também para o 202 de uma pendência já resolvida. O GET mostra o
estado atual da transação: o desfecho, o saldo e a versão da decisão (nulos enquanto pendente) e o
estado e o saldo do aceite. O desfecho também sai nos eventos. As regras de reversão (REFUND e
ROLLBACK) estão na [§11 do ARCHITECTURE.md](ARCHITECTURE.md#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c).

Outros comportamentos da API:

- `POST /wallets` com saldo inicial maior que zero grava a transação interna OPENING e o
  lançamento CREDIT na mesma transação SQL. Uma segunda wallet para o mesmo player e a mesma moeda
  recebe 409 `WALLET_ALREADY_EXISTS` com `existingWalletId`. Wallet inexistente: 404
  `WALLET_NOT_FOUND`.
- O ledger usa cursor opaco e `limit` de 1 a 200.
- A reconciliação sinaliza, loga e conta uma divergência, mas nunca a corrige.
- `POST /wagering/transactions` exige o header `Idempotency-Key`, única no sistema. Chave ou
  externalId em conflito: 409. Rejeição de negócio: 422 em problem+json com `transaction`. Erro
  transitório: 503; reenvie com a mesma key. Transação inexistente: 404 `TRANSACTION_NOT_FOUND`.
- Erros saem como `application/problem+json` com `code`, `retryable` e `correlationId`.
- Provedores aceitos: `PROVIDER_IDS` (padrão `provider-a,provider-b`). Autenticação: ponto de
  extensão no-op (ver [ARCHITECTURE.md](ARCHITECTURE.md)); os health checks são públicos.

## Processamento pelo SQS

A fila de entrada `wager-transactions.fifo` recebe mensagens `WagerTransactionRequested` com o
mesmo contrato do POST e a `idempotencyKey` dentro de `data`. O consumidor chama o mesmo caso de uso
do HTTP, grava a inbox na mesma transação SQL da decisão e só confirma a mensagem (ack) depois do
commit. Uma reentrega já registrada na inbox é confirmada sem novo efeito.

- **Erros de negócio:** a mensagem é confirmada, com a transação REJECTED persistida.
- **Erros permanentes** (contrato inválido, conflito de key, provedor desconhecido ou wallet
  inexistente): a mensagem vai para a DLQ `wager-transactions-dlq.fifo`, com o motivo no atributo
  `dlqReason`.
- **Erros transitórios:** a mensagem volta à fila com backoff; esgotado o `maxReceiveCount`, a
  RedrivePolicy do broker a move para a DLQ.

Os eventos de integração saem na fila de eventos `wagering-events.fifo` (MessageGroupId =
walletId). A stack não consome essa fila: ela é para consumidores externos e guarda as mensagens
por 14 dias.

## Operação e recuperação

**Redrive da DLQ.** Para devolver à fila de entrada o que estiver na DLQ (seguro rodar de novo):

```bash
docker compose exec app-1 bun run sqs:redrive
```

**Republicação da outbox.** Se eventos já publicados se perderem no broker, um operador os reenvia
(o eventId não muda; cada execução usa um MessageDeduplicationId novo):

```bash
docker compose exec app-1 bun run outbox:republish --since 2026-11-13T00:00:00Z
```

Filtros opcionais: `--until <ISO>`, `--aggregate <walletId>` e `--event <eventId>`. A republicação
manual alcança os eventos **publicados que ainda estiverem na tabela `outbox_messages`**; os que ainda
aguardam publicação ficam com o publicador, que continua tentando.

**Retenção.** A limpeza apaga a outbox publicada há mais de `RETENTION_OUTBOX_DAYS` dias (padrão 7,
configurável, mínimo 7) e a inbox com mais de `RETENTION_INBOX_DAYS` dias (padrão 30, mínimo 30);
nada financeiro e nenhum evento pendente é apagado. Ela roda sozinha a cada hora no papel
`outbox-publisher` e também por `docker compose exec app-1 bun run retention:purge`.

**Métricas.** Prometheus em `GET /metrics` de cada instância (bloqueado no nginx; dentro da rede do
compose). Lista e significado no ARCHITECTURE.md §17.

## Logs

```bash
docker compose logs -f --tail 100 app-1 app-2 app-3
docker compose logs migrate init-queues
```

Os logs da aplicação são JSON, um por linha, com `instance`, `correlationId` e `event`.

## Parar

```bash
docker compose --profile "*" down
```

Para os contêineres de todos os perfis e **mantém** os dados (volumes).

## Limpeza completa (irreversível)

```bash
docker compose --profile "*" down -v
```

**Apaga de forma irreversível** o banco (wallets, ledger, outbox), o estado do
MiniStack e os artefatos de teste. Use só quando quiser recomeçar do zero.

## Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| `port is already allocated` na 8080 | Outra aplicação usa a porta: defina `HTTP_PORT` no `.env` |
| Build ou testes morrem sem mensagem (exit 137) | Memória da VM do WSL 2 insuficiente: aumente `memory` em `%UserProfile%\.wslconfig` e rode `wsl --shutdown` |
| `no matching manifest for windows/amd64` | Docker Desktop em modo Windows containers: troque para Linux containers |
| Erros estranhos em scripts depois de clonar no Windows | Conversão CRLF: o `.gitattributes` força LF; rode `git add --renormalize .` |
| Depois de reiniciar o Docker ou o Windows a API não responde | Rode `docker compose up -d` |

## Limitações do emulador (MiniStack)

- A persistência do MiniStack é *best-effort*: o estado só é gravado no
  encerramento normal do emulador. Observado (runbooks V9a/V9b, emulador isolado):
  no reinício normal filas, mensagens, mensagens em voo, receive count e cache de
  deduplicação sobreviveram; na queda abrupta (SIGKILL) tudo desde o último
  encerramento normal foi perdido e um snapshot antigo voltou.
  **A persistência do MiniStack não está comprovada para queda abrupta.**
- **A recuperação de eventos publicados é manual (`outbox:republish`) e limitada
  ao que permanecer na outbox** (eventos publicados que ainda estão na tabela; a retenção os
  apaga depois de `RETENTION_OUTBOX_DAYS` dias, padrão 7).
- **O reenvio de entradas perdidas depende do produtor e não é automático.**
- O estado financeiro nunca depende do emulador: saldo, ledger, idempotência e
  inbox vivem no PostgreSQL.
- O MiniStack não devolve o atributo `MessageDeduplicationId` no `ReceiveMessage` e não valida o
  limite de 128 caracteres; o formato do id é garantido pela aplicação (UT-14) e o id enviado é
  registrado nos logs `dlq.sent` e `redrive.sending`.
