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

<details>
<summary>Histórico completo de execuções (49 linhas, de 2026-11-11 a 2026-11-13)</summary>

Só execuções reais entram nesta tabela.

| Data | SHA | Sistema | Shell | Docker / Compose | Comando | Resultado |
|---|---|---|---|---|---|---|
| 2026-11-11 | c7143e6 + alterações não commitadas | Windows 11 Pro 10.0.26200, Docker Desktop 4.99.0 (WSL 2, kernel 6.18.58.1-microsoft-standard-WSL2) | PowerShell 7 | Engine 29.9.3 / Compose v5.7.0 | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F0` | exit 0; 29 IDs da F0 em PASS, 0 FAIL (run 35bp4epp) |
| 2026-11-11 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` duas vezes (V1), partindo de imagem inexistente | exit 0 nas duas; na 2ª: 0 migrations, filas `unchanged`, nenhum contêiner recriado, `system_identifier` do PG inalterado |
| 2026-11-11 | idem | idem | PowerShell 7 | idem | `docker compose exec app-1 bun run healthcheck` e `test:smoke --level health` (V2a) | exit 0; 60 requisições pelo nginx distribuídas entre app-1, app-2 e app-3 |
| 2026-11-11 | idem | idem | PowerShell 7 | idem | `bun scripts/test-all.ts --selfcheck` (V4) | exit 1, como esperado |
| 2026-11-11 | idem | idem | PowerShell 7 | idem | `bun.lock` regenerado sem cache + build com `--frozen-lockfile` (V6) | lockfile idêntico byte a byte; install exit 0 |
| 2026-11-11 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F1` | exit 0; 46 IDs em PASS (F0 + F1), 0 FAIL, 85 NOT IMPLEMENTED das fases seguintes (run 7u2mi0k1) |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F2` | exit 0; 60 IDs em PASS (F0 + F1 + F2), 0 FAIL, 71 NOT IMPLEMENTED das fases seguintes (run m20zohc1) |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` duas vezes com o schema da F2, `healthcheck`, `test:smoke --level health` e um `POST /wallets` manual pelo nginx | exit 0; 1ª subida aplicou a migration 0001, 2ª: 0 migrations e nenhum contêiner recriado; smoke com 3 instâncias; POST 201 |
| 2026-11-12 | sem commits (repositório Git reiniciado) | idem | PowerShell 7 | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F2`, com Prettier e eslint-plugin-sonarjs na etapa static | exit 0; 62 IDs em PASS (inclui QG-09 e QG-10), 0 FAIL, 71 NOT IMPLEMENTED das fases seguintes (run s9mtpe5q); checksum da migration 0001 inalterado |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` após os ajustes de qualidade, `healthcheck` e `test:smoke` | exit 0; 0 migrations; app-1..3 healthy; smoke com 3 instâncias |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F2`, depois da correção do meta-check (escopo por ID, BLOCKED acima de PASS) e da QG-10 por severidade | exit 0; 62 IDs em PASS, 0 FAIL, 0 BLOCKED, nenhum obrigatório até F2 fora de PASS, 71 NOT IMPLEMENTED das fases seguintes (run yn1ok2ao) |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --build tests` (suíte completa, meta-check estrito) | exit 1, como esperado: todas as etapas OK, 62 PASS e 71 IDs obrigatórios `NOT IMPLEMENTED` (F3–F6) listados (run su33y8do). Não é o V3: não foi num clone novo |
| 2026-11-12 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F3` | exit 0; 76 IDs em PASS (F0–F3), 0 FAIL, 0 BLOCKED, nenhum obrigatório até F3 fora de PASS, 57 NOT IMPLEMENTED das fases F4–F6 (run ev0nso1k) |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` com a F3 | exit 0; `migrate` executou `[]` (0001 já aplicada); app-1..3 healthy |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b) | exit 0; wallet → BET → WIN → replay → 2 consultas → reconciliação consistente; respostas de app-1, app-2 e app-3 |
| 2026-11-12 | idem | idem | Dev Container (`wagering-dev`) | idem | burn-in: `bun scripts/test-all.ts concurrency` 20 vezes seguidas | 1ª série: 19/20 (o CT-13 recebeu 503 retentável na espera pelo pool e o teste exigia 200 em tudo; a expectativa foi corrigida para o contrato de reenvio com a mesma key). 2ª série, com o teste ajustado: 20/20 |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F3`, depois do ajuste do CT-13 | exit 0; 76 PASS, 0 FAIL, 0 BLOCKED, 57 NOT IMPLEMENTED das fases F4–F6 (run 6pl5sain) |
| 2026-11-12 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts static unit integration concurrency` com a F4 | 1ª rodada: exit 1, 3 falhas de integração e 1 de concorrência (a 0002 falhava num banco com dados da F3 por eventos de trigger pendentes, 55006; o worker arredondava instantes do PostgreSQL para milissegundos). Corrigidas; 2ª rodada: exit 0, 261 casos, 0 falhas |
| 2026-11-12 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F4` | exit 0; 101 IDs em PASS (F0–F4), 0 FAIL, 0 BLOCKED, 32 NOT IMPLEMENTED das fases F5–F6 (run 8gqctrti); corrida no prazo do CT-07h: 50 iterações, 23 resolvidas, 27 rejeitadas, 0 divergências do oráculo |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` com a F4, sobre o banco da stack com dados da F3 | exit 0; `migrate` executou `['Migration0002ReversalsAndPendingReferences']`; as 4 transações existentes preservadas; app-1..3 healthy; healthcheck live 200 / ready 200 |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b) com a F4 | exit 0; wallet → BET → WIN → replay → 2 consultas → reconciliação consistente; respostas de app-1, app-2 e app-3 |
| 2026-11-12 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts integration` com o novo IT-26 (g), antes da correção do worker | exit 1, como esperado: 2 falhas reproduzindo o defeito (ROLLBACK da cadeia ROLLBACK → REFUND → BET rejeitado com `REFERENCE_NOT_PROCESSED` antes de o REFUND ser avaliado; saldo final 100.00 em vez de 90.00; o mesmo com `WORKER_BATCH_SIZE=1`); a contraprova passou |
| 2026-11-12 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F4`, depois da correção do worker | exit 0; 101 IDs em PASS, 0 FAIL, 0 BLOCKED, 32 NOT IMPLEMENTED das fases F5–F6 (run zgx1r9hc); IT-26 (g): REFUND e ROLLBACK aplicados uma vez cada, saldo 90.00, também com lote 1 |
| 2026-11-12 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts integration` com o novo IT-26 (h), antes da correção | exit 1, como esperado: os dois ROLLBACKs que referenciam um ao outro continuaram `PENDING_REFERENCE` 15 s depois do prazo; o IT-26 (e) também falhou porque o worker do caso (h) não era parado na falha (o teste passou a usar `try/finally`) |
| 2026-11-12 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F4`, depois da correção de dependências inválidas | exit 0; 101 IDs em PASS, 0 FAIL, 0 BLOCKED, 32 NOT IMPLEMENTED das fases F5–F6 (run 8mp3hb6s); IT-26 (h): os dois REJECTED `INVALID_REFERENCE_KIND`, saldo 100.00 na versão 1, nenhum lançamento; IT-26 (g) continua passando |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` com a imagem corrigida, volumes preservados | exit 0; app-1..3 recriados com o worker corrigido e healthy; `migrate` executou `[]`; wallets, transações e lançamentos iguais antes e depois (3, 7, 7) |
| 2026-11-12 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b) com a imagem corrigida | exit 0; wallet → BET → WIN → replay → 2 consultas → reconciliação consistente; respostas de app-1, app-2 e app-3 |
| 2026-11-12/13 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts static unit integration concurrency resilience` com a F5, em rodadas sucessivas | 1ª rodada (integration): 3 falhas (boot listava todas as migrations como pendentes num banco só até a 0002; messageId de teste com 174 caracteres em vez de 200; DLQ com cópias de testes anteriores). 2ª: 5 falhas (MiniStack não devolve `MessageDeduplicationId` no Receive; nova execução do redrive terminava antes de a cópia voltar a ficar visível; CT-12 devolveu 500 uma vez; IT-28 saía com 1 porque o fechamento do pool esperava a transação devolvida; IT-30 em cascata). 3ª: 1 falha de comparação no teste. Todas corrigidas; o CT-12 passou na repetição e a classificação de conexão perdida foi ampliada |
| 2026-11-13 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F5` | exit 0; 128 IDs em PASS (F0–F5), 0 FAIL, 0 BLOCKED, 0 SKIPPED, 5 NOT IMPLEMENTED da fase F6 (run xgmgezbr); integration 152, concurrency 26 e resilience 9 casos sem falha |
| 2026-11-13 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts integration resilience` com a correção da identidade do descarte no redrive | exit 0; integration 153 e resilience 9 casos sem falha; novo IT-21g (JSON malformado voltando à DLQ durante o redrive): o comando terminou em 4,8 s, cada descarte reenviado uma vez, 1 cópia por descarte na tentativa 2 com corpo intacto, nenhum lançamento novo |
| 2026-11-13 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F5`, depois da correção | exit 0; 128 IDs em PASS, 0 FAIL, 0 BLOCKED, 5 NOT IMPLEMENTED da F6 (run pg5j32eo); IT-21g malformado: redrive em 5,0 s, os dois descartes em IN_DLQ tentativa 2; IT-21j continua passando |
| 2026-11-13 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` com a F5, volumes preservados | exit 0; `migrate` executou `['Migration0003InboxAndDeadLetter']`; app-1..3 healthy, cada uma com `consumer.started`, `outbox_publisher.started` e `pending_reference_worker.started`; wallets, transações e lançamentos iguais antes e depois (4, 10, 10); os 20 eventos que estavam na outbox foram publicados |
| 2026-11-13 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b) com a imagem da F5 | exit 0; wallet → BET → WIN → replay → 2 consultas → reconciliação consistente; respostas de app-1, app-2 e app-3; outbox com 0 de 26 eventos pendentes depois do smoke |
| 2026-11-13 | idem | idem | PowerShell 7 (host); `ministack-persist` isolado (profile `persist-check`) | idem | V9a: `persist:seed r1`, `restart ministack-persist`, `persist:check r1` | log `saved sqs state` no encerramento e `loaded` na subida; filas e atributos, 3 mensagens, a mensagem em voo continuou em voo, receive count e cache de deduplicação preservados (sonda descartada, contagem 3 → 3). As duas primeiras tentativas do runbook foram inconclusivas por defeito do script (sonda de dedup sem relação com o seed; mensagens da rodada anterior bloqueando os grupos FIFO) e o script foi corrigido |
| 2026-11-13 | idem | idem | idem | idem | V9b: `persist:seed r2`, `kill -s SIGKILL ministack-persist`, `up -d`, `persist:check r2` e `r1` | sem linha `saved`; filas e mensagens da rodada r2 (posteriores ao último encerramento normal) perdidas por completo; a rodada r1 voltou como estava no snapshot anterior (snapshot antigo restaurado) |
| 2026-11-13 | idem | idem | Dev Container (`wagering-dev`) | idem | `bun scripts/test-all.ts static unit integration` com a F6, 1ª rodada | exit 1: UT-13 (o papel `events-projection` entrou nos papéis padrão; retirado do padrão e do compose para não competir com consumidores reais da fila de eventos) e IT-31 (`sqs_queue_messages` sem amostras: o prom-client lê as métricas em paralelo e o gauge era lido antes da coleta; cada gauge passou a aguardar a mesma coleta). Rodada seguinte com todas as etapas: exit 0 |
| 2026-11-13 | idem | idem | PowerShell 7 (host); comandos de desenvolvimento no Dev Container | idem | `docker compose run --rm --build tests bun scripts/test-all.ts --phase F6` | exit 0; 133 IDs em PASS (F0–F6), 0 FAIL, 0 BLOCKED, 0 SKIPPED, 0 NOT IMPLEMENTED (run 0mx0nkgr); integration 154, concurrency 26 e resilience 18 casos sem falha; CT-08 SIGKILL com 19 requisições HTTP reenviadas pela mesma key e 0 duplicatas |
| 2026-11-13 | idem | idem | PowerShell 7 | idem | `docker compose up --build -d` com a F6, volumes preservados | exit 0; `migrate` executou `['Migration0004RetentionAndProjection']`; app-1..3 healthy com consumidor, publicador e worker; wallets, transações, lançamentos e eventos iguais antes e depois (5, 13, 13, 26); `/metrics` com gauges de outbox, pendências e filas; `/metrics` pelo nginx → 404 |
| 2026-11-13 | idem | idem | PowerShell 7 | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b) com a imagem da F6 | exit 0; wallet → BET → WIN → replay → 2 consultas → reconciliação consistente; respostas de app-1, app-2 e app-3 |
| 2026-11-13 | sem commits (cópia dos arquivos de trabalho) | idem | PowerShell 7 (host), **validação em cópia limpa**: cópia temporária dos 255 arquivos de entrega, sem `.git`, `node_modules`, `.env` nem resultados antigos; projeto Compose isolado `wagering-f7clean`, volumes próprios, `HTTP_PORT=18080` | idem | `docker compose config --quiet` e `docker compose up --build -d` (1ª subida) | exit 0 nos dois; `migrate` executou as 4 migrations num banco vazio; app-1..3 healthy; healthcheck live 200 / ready 200; `GET /health/ready` pela porta 18080 → 200 |
| 2026-11-13 | idem | idem | idem | idem | `docker compose run --rm --no-deps tests bun run test:smoke --level full` (V2b / E2E-01) e `exec app-1 bun run verify` | exit 0; fluxo completo com respostas de app-1, app-2 e app-3; `verify` consistente |
| 2026-11-13 | idem | idem | idem | idem | `docker compose up --build -d` de novo (V1) | exit 0; nenhum contêiner recriado; `migrate` executou `[]`; as 3 filas `unchanged` |
| 2026-11-13 | idem | idem | idem | idem | `docker compose run --rm --build tests`: suíte completa, sem `--phase`, meta-check estrito (V3 em cópia limpa) | **exit 0**; modo completo (estrito); 133 IDs em PASS, sendo 132 obrigatórios e 1 informativo (SPK-01); 0 FAIL, 0 BLOCKED, 0 SKIPPED, 0 NOT IMPLEMENTED (run d4kexx29). Validação em cópia limpa; o teste num clone Git real continua pendente; static, conformance 22, unit 87, integration 155, concurrency 26 e resilience 18 casos sem falha; 623 s; pico de memória do contêiner 1347 MiB. Rodou com a stack isolada no ar, e os contêineres dela continuaram intactos (parte do V8) |
| 2026-11-13 | idem | idem | idem | idem | `docker compose run --rm tests bun scripts/test-all.ts --selfcheck` (V4) | exit 1, como esperado |
| 2026-11-13 | idem | idem | idem | idem | V6: build com `--frozen-lockfile` e `bun.lock` regenerado do zero | as imagens foram construídas com `--frozen-lockfile` sem alterar o `bun.lock` versionado; a resolução do zero hoje difere em uma dependência transitiva (`encodeurl` 2.0.3, publicada depois do lock, em vez da 2.0.2 travada): é para isso que o lock é versionado; o lock não foi alterado |
| 2026-11-13 | idem | idem | idem | idem | V7: 90 apostas pelo nginx com `docker compose kill -s SIGKILL app-2` no meio, `up -d`, `exec app-1 bun run verify` | 90 respostas 200, 0 falhas; app-2 voltou healthy; `verify` consistente (99 transações, 99 lançamentos) |
| 2026-11-13 | idem | idem | idem | idem | V9c: tráfego, `kill -s SIGKILL ministack`, `up -d`, `exec app-1 bun run outbox:republish --since <t0>`, `verify` | a fila de eventos caiu de 222 para 0 mensagens (sem snapshot salvo); filas reprovisionadas; o republish reenviou os 24 eventos desde t0 (24 na fila depois); `verify` consistente. Os eventos anteriores a t0 continuam na outbox e voltariam com um `--since` mais antigo |
| 2026-11-13 | idem | idem | idem | idem | V5: `docker compose logs`, `docker compose --profile "*" down` (sem `-v`) e `up -d` | dados preservados (9 wallets, 111 transações, 111 lançamentos antes e depois); `migrate` executou `[]`. Ao final o projeto isolado foi parado com `down`, sem `-v`; a stack principal (`wagering`) continuou rodando, intacta |
| 2026-11-13 | `6cb10ec` (clone Git real) | idem | PowerShell 7 (host), **validação em clone Git real**: `git clone --no-local` do repositório local (80 commits) para uma pasta temporária, sem `node_modules` nem `.env`; projeto Compose isolado `wagering-gitclone` | idem | `docker compose -p wagering-gitclone run --rm --build tests`: suíte completa, sem `--phase`, meta-check estrito (V3 em clone Git real) | **exit 0**; modo completo (estrito); 133 IDs em PASS, sendo 132 obrigatórios e 1 informativo (SPK-01); 0 FAIL, 0 BLOCKED, 0 SKIPPED, 0 NOT IMPLEMENTED (run ixbxe23v); static, conformance 22, unit 87, integration 155, concurrency 26 e resilience 18 casos sem falha; 650 s; pico de memória do contêiner 1357 MiB. Rodou com a stack principal e o Dev Container no ar, e os contêineres da stack continuaram intactos |

Nota sobre as linhas anteriores a `yn1ok2ao`: até então o escopo estrito do meta-check comparava
objetos copiados e nunca encontrava um ID, então o exit 0 daquelas execuções `--phase` veio só das
etapas. Os números registrados nelas (29, 46, 60 e 62 PASS, 0 FAIL) cobrem todos os IDs obrigatórios
até a fase de cada execução, então a conclusão de cada linha se mantém; o histórico foi preservado.

</details>

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
