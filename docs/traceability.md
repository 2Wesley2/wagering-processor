# Rastreabilidade: enunciado → decisões → testes

Cada linha liga um requisito do enunciado ([docs/CHALLENGE.md](CHALLENGE.md)) às decisões do
[ARCHITECTURE.md](../ARCHITECTURE.md) e aos testes que o comprovam. Os IDs entre colchetes aparecem
no nome dos casos de teste (`[IT-21j] …`). O catálogo (`test/meta/required.ts`) tem 133 IDs: 132
obrigatórios e um informativo (SPK-01, o spike de MikroORM 7 + ALS + pg no Bun). O meta-check
estrito (QG-08) exige PASS nos 132 obrigatórios; o informativo aparece no relatório sem entrar
nessa exigência.

**Status:** "PASS" significa que todos os IDs da linha passaram na suíte completa com meta-check
estrito da execução `d4kexx29` (2026-11-13, Windows 11 + Docker Desktop/WSL 2), feita em cópia
limpa dos arquivos de entrega: os 133 IDs ficaram em PASS. A execução `ixbxe23v`, num clone Git
real do histórico, repetiu o resultado (ver README, "Validado em"). Verificações de stack (V*) e
itens fora do catálogo indicam o próprio resultado.

Prioridade: P0 = núcleo ou eliminatório; P1 = exigido; P2 = opcional.

**Como ler as colunas.**

- `§` na coluna "Requisito" é uma seção do enunciado ([CHALLENGE.md](CHALLENGE.md)); na coluna
  "Decisões", é uma seção do [ARCHITECTURE.md](../ARCHITECTURE.md).
- `Dnn` na coluna "Decisões" é o número de uma decisão do plano de implementação usado no
  desenvolvimento. O plano não faz parte do repositório; a tabela abaixo dá o tema de cada código e
  onde ele está explicado.
- Na coluna "Testes", `h` e `s` no fim do ID são as variantes HTTP e SQS do mesmo cenário
  (`CT-01h`, `CT-01s`); outra letra indica um subcaso (`IT-21b`). Os termos estão no
  [glossário](glossario.md).

| Prefixo | Família de requisitos | Prefixo | Família de requisitos |
|---|---|---|---|
| DOM | Garantias gerais do domínio | IDP | Idempotência |
| MOD | Modelagem do domínio | AUTH | Autenticação |
| MON | Valores monetários | HC | Health check |
| WAL | Carteira | SQS | Mensageria pela fila |
| WTX | Transação de aposta | INB, OUT, OBX | Inbox, outbox e publicadores da outbox |
| LED | Ledger | EVT | Eventos de integração |
| BR | Regras de negócio dos tipos de operação | OBS | Observabilidade |
| REF | Referências pendentes | DOC | Documentação |
| FC | Códigos de falha | TST | Testes exigidos |
| CC | Concorrência | STK | Stack obrigatória |
| CON | Restrições técnicas do enunciado | ENV | Ambiente em contêineres |
| API | API HTTP | LOAD, OPT | Teste de carga e itens opcionais |

| Decisão | Tema | Onde está explicada |
|---|---|---|
| D05 | Representação do dinheiro (`Money`) | [§4](../ARCHITECTURE.md#4-money) |
| D06 | Carteira: abertura, débito e crédito | [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D07 | Transação de aposta: tipos, estados e transições | [§8 e 9](../ARCHITECTURE.md#89-transições-de-estado-e-errorcatalog-f1) |
| D08 | Lançamento do ledger | [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D09 | Política de liquidação e ordem das regras | [§8 e 9](../ARCHITECTURE.md#89-transições-de-estado-e-errorcatalog-f1) |
| D11 | Catálogo de erros | [§8 e 9](../ARCHITECTURE.md#89-transições-de-estado-e-errorcatalog-f1) |
| D15 | Dinheiro no banco (`DOMAIN money_amount`) | [§4](../ARCHITECTURE.md#4-money) e [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D16 | Tabelas e constraints | [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D17 | Saldo igual ao ledger, imposto pelo banco | [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D18 | Imutabilidade em duas camadas (permissões e triggers) | [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) |
| D19, D20 | Unit of Work com MikroORM; bootstrap e migrations | [§3](../ARCHITECTURE.md#3-orm-e-estratégia-transacional-f2) e [§15](../ARCHITECTURE.md#15-ambiente) |
| D21 | Paginação do ledger por cursor | [README, API HTTP](../README.md#api-http) |
| D22 | Reconciliação | [README, API HTTP](../README.md#api-http) |
| D23, D24, D25 | Lock por carteira; ordem fixa dos recursos; timeouts e pools | [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) |
| D26 | Roteiro único da transação e caminhos de gravação | [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) |
| D27, D29 | `Idempotency-Key` (I2); resposta original e estado atual (I1) | [§1](../ARCHITECTURE.md#1-contexto-drivers-e-não-escopo) e [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) |
| D28 | Hashes do comando e do envelope | [§8 e 9](../ARCHITECTURE.md#89-transições-de-estado-e-errorcatalog-f1) |
| D30, D31 | Validação de entrada; status HTTP e corpo de erro | [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) |
| D32 | Endpoints | [README, API HTTP](../README.md#api-http) |
| D33 | Autenticação | [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) |
| D34, D35, D36, D37 | Filas SQS; consumidor e dead-letter; redrive; encerramento por `SIGTERM` | [§12](../ARCHITECTURE.md#12-mensageria-e-falhas-f5) |
| D38 | Outbox, republicação e retenção | [§12](../ARCHITECTURE.md#12-mensageria-e-falhas-f5) e [§17](../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) |
| D39 | Eventos de integração | [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) e [§17](../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) |
| D40 | Worker de pendências e regra de prazo | [§13](../ARCHITECTURE.md#13-pending_reference-e-worker-de-pendências-f4) |
| D41, D42 | Logs; métricas | [§17](../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) |
| D43 | Health (`live` e `ready`) | [README, Subir e verificar o serviço](../README.md#subir-e-verificar-o-serviço) |
| D46, D47 | Instâncias reais da aplicação nos testes; injeção de falhas e prova de queda | [§15](../ARCHITECTURE.md#15-ambiente) |
| D50 | Documentação e registro honesto da validação | [README, Validado em](../README.md#validado-em) |
| D54 | Duplicatas tratadas pela aplicação, sem confiar na deduplicação do broker | [§12](../ARCHITECTURE.md#12-mensageria-e-falhas-f5) |

## Domínio e regras de negócio

| Req | P | Requisito (resumo) | Decisões | Testes | Status |
|---|---|---|---|---|---|
| DOM-01 | P0 | Sem crédito nem débito duplicado | lock por wallet, idempotência persistente, inbox, P1 = C | CT-01h, CT-01s, CT-05, CT-10, CT-11h, CT-11s, RV-CT-01..04, IT-21h | PASS |
| DOM-02 | P0 | Evento confirmado não se perde; duplicata tolerada | outbox transacional, eventId estável, `outbox:republish` | CT-06, IT-24, IT-25, IT-27, IT-27b | PASS |
| DOM-03 | P0 | Saldo nunca negativo | `money_amount`, CHECK `balance >= 0`, política | IT-03, CT-02h, CT-02s, CT-09 | PASS |
| DOM-04 | P0 | Correto com duplicação, desordem, concorrência e queda antes/depois do commit | D26, D35, D40, D47 | CT-04h, CT-04s, CT-05, CT-07h, CT-07s, CT-08, IT-07a..d | PASS |
| DOM-05 | P1 | PostgreSQL ou SQS fora temporariamente | timeouts, breaker, readiness, partida resiliente | IT-13, IT-24, IT-29 | PASS |
| MOD-01 | P1 | Factories; rehydrate não revalida transição | D05–D08 | UT-03, UT-04 | PASS |
| MON-01..07 | P0/P1 | Money imutável, string escala 2, sem arredondamento, moedas | D05, D15 | UT-01, UT-02, UT-10, IT-06, IT-11, IT-12, QG-02 | PASS |
| WAL-01..06 | P0/P1 | 1 wallet por player e moeda; saldo = ledger; version; único caminho de mutação | D06, D16, D17, D23 | UT-03, UT-11, IT-03, IT-05, IT-08, IT-09, CT-02h | PASS |
| WTX-01..05 | P0/P1 | Estados, transições, terminais imutáveis, OPENING interno, conflito ≠ replay | D07, D18, D27, D28 | UT-04, UT-07, IT-04, IT-10a, IT-12, IT-21 | PASS |
| LED-01..03 | P0/P1 | Lançamento imutável e aritmético; ≤ 1 por transação; LOSS/REJECTED sem lançamento | D08, D16, D17 | UT-06, IT-03, IT-04, IT-05 | PASS |
| BR-01..03 | P0 | BET, WIN, LOSS | D09 | UT-05a, CT-02h, IT-05, IT-14 | PASS |
| BR-04, 05, 09 | P0 | REFUND e ROLLBACK uma única vez; nunca 2× pelo mesmo tipo (P1 = C) | §1, §11 | UT-05b, RV-UT-01..03, RV-IT-01..07, RV-CT-01..04, CT-11h, CT-11s | PASS |
| P2 | P0 | WIN/LOSS × reversões da mesma BET (P2 = (c)) | §1, §11 | P2-T1..T5, UT-05b | PASS |
| BR-06..08, 10 | P0 | Referência obrigatória, mesmo escopo, kinds válidos, mesmo valor | D07, D09 | UT-04, UT-05a, RV-UT-02a, IT-26 | PASS |
| BR-11, 12 | P0 | REJECTED não move saldo; replay devolve a resposta original (I1 = A) | D17, D29 | IT-05, IT-10a, IT-10b, IT-11 | PASS |
| BR-13, REF-01..04 | P0 | PENDING_REFERENCE + worker (TTL, prazo pelo banco, ordem, várias instâncias) | D40, §13 | UT-08, IT-26, IT-07c, RV-IT-03, RV-IT-06, CT-07h, CT-07s | PASS |
| BR-14, FC-01, 02 | P0/P1 | Código próprio para reversão sem saldo; taxonomia estável | D11 | UT-05a, UT-09, IT-19 | PASS |

## Concorrência, API e idempotência

| Req | P | Requisito | Decisões | Testes | Status |
|---|---|---|---|---|---|
| CC-01..06 | P0 | Unidade de concorrência = wallet; ≥ 3 instâncias; cenário do §8 | D23, D46, D47 | CT-02h, CT-02s, CT-03, CT-04h, CT-04s, CT-12, CT-13 | PASS |
| CON-01 | P0 | Sem number/float para dinheiro | D05, D15 | UT-01, QG-02, QG-04, IT-06 | PASS |
| CON-02, 03 | P0 | Idempotência fora da memória; FIFO não é garantia | D27, D35, D54 | IT-10a, IT-20, CT-01h, CT-01s | PASS |
| CON-04 | P0 | Nada publicado antes do commit | D26, D38 | IT-07a..d, IT-25, QG-03 | PASS |
| CON-05 | P0 | Ledger nunca sobrescrito nem apagado | D18 | IT-04 | PASS |
| CON-06..09 | P0 | Sem lock global; sem read→calculate→update; várias instâncias; invariantes no schema | D16–D24 | CT-03, IT-03, IT-05, IT-08, QG-04 | PASS |
| API-01..04 | P0/P1 | POST /wallets e GETs do §9 | D32 | IT-09, IT-15, IT-07a | PASS |
| API-05 | P1 | Cursor estável e opaco | D21 | UT-12, IT-16 | PASS |
| API-06, 07 | P0 | Contrato do POST; status consistentes | D30, D31 | UT-09, IT-11, IT-12, IT-19 | PASS |
| API-08, 09 | P0/P1 | Reconciliação sem correção; log + métrica + flag | D22 | IT-17 (endpoint e `bun run verify`) | PASS |
| IDP-01..04 | P0 | Key obrigatória; hash canônico; replay com flag; entre instâncias (I2 = global) | D27–D29 | UT-07, IT-10a, IT-10b, IT-12, IT-14, CT-01h | PASS |
| AUTH-01..03 | P1 | Ponto de extensão de auth; health aberto; identidade da fila validada | D33 | IT-18, IT-21 | PASS |
| HC-01, 02 | P1 | live × ready (PostgreSQL + SQS) | D43 | IT-18, IT-24, IT-29 | PASS |

## Mensageria, falhas e observabilidade

| Req | P | Requisito | Decisões | Testes | Status |
|---|---|---|---|---|---|
| SQS-01..03 | P0 | Filas e envelope; mesmo caso de uso; inbox | D30, D34, D35, §12 | IT-14, IT-20, CT-01s | PASS |
| SQS-04, 05 | P0 | Ack só depois do commit; classes de erro (negócio, transitório, permanente, conflito) | D35, D11 | IT-21, IT-22, IT-07d, CT-05 | PASS |
| SQS-06 | P0 | Limite antes da DLQ; DLQ e redrive sem efeito duplicado | D35, D36 | IT-21b..j, IT-22, IT-30, UT-14 | PASS |
| SQS-07 | P1 | SIGTERM conclui ou devolve a mensagem em voo | D37 | IT-28, CT-08 | PASS |
| SQS-08 | P0 | Reentrega sem efeito duplicado, inclusive com cópias repetidas | D35 | IT-20, IT-21h, IT-23, CT-05 | PASS |
| INB-01, OUT-01, OBX-01..03 | P0/P1 | Inbox e outbox atômicas; publicadores concorrentes; queda antes de publicar | D26, D38 | IT-07a..d, IT-25, CT-06 | PASS |
| EVT-01..05 | P0/P1 | Os 4 eventos e o envelope abstrato | D39 | UT-06, IT-11, IT-26, IT-27b | PASS |
| OBS-01..03 | P1 | Logs com ids, sem payload sensível; métricas mínimas | D41, D42, §17 | IT-31 | PASS |
| DOC-01, 02 | P1 | README e ARCHITECTURE.md | D50 | este documento, README, ARCHITECTURE.md | revisado na F7 |

## Testes exigidos pelo §13

| Req | Exigência | Testes | Status |
|---|---|---|---|
| TST-01..05 | Unidade: Money, Wallet, transação, política, ledger, hashes, propriedade | UT-01..UT-14, RV-UT-01..03 | PASS |
| TST-06..11 | Integração: migrations, atomicidade, inbox, publicadores, retry/DLQ, reinício | IT-01a, IT-01b, IT-02, IT-07a..d, IT-20, IT-22, IT-23, IT-25, IT-27, CT-06 | PASS |
| TST-12 | Concorrência 1: duplicatas em paralelo | CT-01h, CT-01s | PASS |
| TST-13 | Concorrência 2: o cenário do §8 | CT-02h, CT-02s | PASS |
| TST-14 | Concorrência 3: wallets diferentes em paralelo | CT-03 | PASS |
| TST-15 | Concorrência 4: ≥ 3 instâncias, carga mista | CT-04h, CT-04s | PASS |
| TST-16 | Concorrência 5: queda depois do commit e antes do ack | CT-05 | PASS |
| TST-17 | Concorrência 6: publicadores concorrentes com queda | CT-06 | PASS |
| TST-18 | Concorrência 7: reversões antes da referência | CT-07h, CT-07s | PASS |
| TST-19 | Concorrência 8: reinício com consistência final | CT-08 | PASS |
| TST-20 | Invariante final em todo teste | verificador global (`test/support/verifier.ts`) no afterAll | PASS |
| TST-21 | PostgreSQL e SQS reais, sem mock | todas as suítes (MiniStack de teste, PostgreSQL de teste) | PASS |

## Ambiente e entrega

| Req | Requisito | Verificação | Status |
|---|---|---|---|
| STK-01..03 | Bun 1.x, TypeScript estrito, NestJS | QG-01, QG-05, IT-29 | PASS |
| STK-04..08 | PostgreSQL, SQS (MiniStack), Docker Compose, migrations reversíveis, MikroORM | IT-01a, IT-01b, IT-02, CONF-00..21 | PASS |
| ENV-01, 02 | Tudo em contêineres; host só com Docker e Compose | toda a suíte; V1, V2b, V3 em cópia limpa | ver README |
| ENV-03 | Versões fixadas; init idempotente; espera de prontidão | IT-01a, V1, V6 | ver README |
| ENV-04 | Queda e encerramento controlados no Docker | CT-05, CT-06, CT-08, IT-07a..d, IT-28, IT-32, V7 | ver README |
| ENV-05 | MiniStack validado; limitações reais | CONF-00..21, V9a, V9b, V9c | ver README e ARCHITECTURE.md §16 |
| E2E-01 | Stack com 3 instâncias atrás do nginx, fluxo de negócio | V2b (`test:smoke --level full`) | ver README |
| E2E-02 | Matriz V1–V9 por sistema operacional | README, "Validado em" | Windows 11 + WSL 2 executado; PowerShell 5.1 e Linux nativo não executados |
| LOAD-01 | Carga (`test:load`) | não se aplica | P2 opcional, não implementado |
| OPT-01 | Partidas dobradas, OpenTelemetry, dashboard | não se aplica | P2 opcional, fora do escopo |
| F8 | Autenticação com IdP externo (Keycloak) | não se aplica | opcional, não iniciado |
