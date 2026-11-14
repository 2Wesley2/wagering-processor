# Glossário do Distributed Wagering Processor

## Apostas, carteira e saldo

| Termo | Significado no projeto |
| --- | --- |
| `wallet` | Carteira de um jogador em uma moeda. O mesmo jogador pode ter uma carteira em BRL e outra em USD. |
| `providerId` e `externalTransactionId` | Identificam o provedor de jogos e a operação no sistema dele. O par identifica uma operação do provedor. |
| `playerId` e `roundId` | Identificam o jogador e a rodada do jogo. A rodada pode reunir uma aposta, um resultado e reversões. |
| Saldo materializado | Saldo atual armazenado na carteira. A aplicação o atualiza junto com os lançamentos que o compõem. |
| `ledger` | Histórico de lançamentos da carteira. Cada crédito ou débito aplicado gera uma entrada. O saldo deve bater com a soma dos lançamentos. |
| Versão da carteira | Contador que aumenta quando o saldo muda. Também indica a ordem dos lançamentos da carteira. |
| Reconciliação | Compara o saldo armazenado com a soma do ledger e informa divergências. Deixa os dados como estão. |
| Referência | Ligação de uma operação com outra, informada em `referenceExternalTransactionId`. Um reembolso, por exemplo, aponta para a aposta que será revertida. |

## Tipos de operação

| Tipo | O que representa | Efeito no saldo |
| --- | --- | --- |
| `OPENING` | Lançamento interno do saldo inicial positivo de uma carteira. | Crédito |
| `BET` | O jogador aposta um valor. | Débito |
| `WIN` | O jogador recebe um prêmio. A operação pode apontar para a aposta. | Crédito |
| `LOSS` | O provedor informa que a aposta perdeu. O débito já aconteceu na `BET`. | Nenhum |
| `REFUND` | O valor de uma `BET` aplicada volta para a carteira. | Crédito |
| `ROLLBACK` | Desfaz o efeito de uma `BET`, um `WIN` ou um `REFUND` aplicado. | Inverte o efeito original |

## Estados da transação

| Estado | O que significa |
| --- | --- |
| `PENDING` | A transação acabou de ser criada e ainda está em avaliação na memória do processo. |
| `PENDING_REFERENCE` | O pedido foi registrado e aguarda a operação referenciada. Pode ser aceito com HTTP `202`. |
| `PROCESSED` | A operação foi decidida e registrada. Uma `LOSS` pode terminar nesse estado sem mexer no saldo. |
| `REJECTED` | Uma regra de negócio impediu a operação. O motivo fica registrado em `failureCode`, sem lançamento financeiro. |
| `FAILED` | Estado terminal previsto no domínio para falha permanente. Os fluxos atuais do consumidor e do worker tratam falhas por outros caminhos, como nova tentativa ou DLQ. |

## Concorrência, reenvio e filas

| Termo | Significado no projeto |
| --- | --- |
| Lock por carteira | O PostgreSQL bloqueia a linha da carteira enquanto uma operação decide e grava seus efeitos. Outra operação da mesma carteira espera por essa linha. |
| Idempotência | Repetir a mesma operação com a mesma `Idempotency-Key` e o mesmo corpo preserva um único efeito financeiro. Reutilizar a chave com outro corpo gera conflito. |
| Replay | Resposta registrada na primeira submissão, repetida com `idempotentReplay: true`. Um `202` continua `202` no replay, mesmo depois de o GET passar a mostrar o desfecho. |
| `worker` de pendências | Processo que volta às transações em `PENDING_REFERENCE`, procura a referência e decide a operação conforme o prazo e as regras do projeto. |
| SQS, FIFO e MiniStack | O SQS transporta as mensagens por fila. A configuração usa FIFO por grupo, identificado pela carteira. O MiniStack emula o SQS no ambiente local. |
| `inbox` | Registro das entregas recebidas. É gravado na mesma transação SQL da decisão e permite reconhecer uma mensagem reentregue. |
| `outbox` | Registro dos eventos a publicar. A aplicação grava o evento junto com a decisão no PostgreSQL, e um publicador o envia à fila depois. |
| `commit` SQL e `ack` | O `commit` confirma que a decisão foi gravada no banco. O `ack` confirma o tratamento da mensagem à fila, removendo-a da origem, depois da gravação. |
| DLQ e `redrive` | A *dead-letter queue* guarda mensagens descartadas ou que esgotaram as tentativas de entrega. O redrive devolve mensagens da DLQ à fila de origem. |

## Rótulos da documentação e dos testes

Os códigos `F0` a `F8` identificam etapas do desenvolvimento. Os estados de uma transação
estão na tabela acima.

| Fase | O que reúne |
| --- | --- |
| `F0` | Ambiente Docker, inicialização dos serviços e estrutura de testes. |
| `F1` | Valores monetários, carteira, lançamentos, tipos de transação e regras de negócio. |
| `F2` | Persistência financeira no PostgreSQL, API de carteiras e reconciliação. |
| `F3` | Submissão e consulta de transações por HTTP, idempotência e concorrência por carteira. |
| `F4` | Reversões e processamento de referências pendentes. |
| `F5` | Consumo por SQS, inbox, DLQ e publicação da outbox. |
| `F6` | Observabilidade, retenção e recuperação após falhas. |
| `F7` | Verificação e validação da entrega. |
| `F8` | Autenticação com provedor externo de identidade. Etapa opcional. |

A pasta `specs/001-f3-http-submission/` guarda a especificação da fase HTTP. A arquitetura
descreve o sistema entregue, e a matriz liga os requisitos do desafio aos testes.

| Rótulo | Significado no projeto |
| --- | --- |
| `I1` | Replay mantém a resposta original, inclusive quando ela foi `202`. |
| `I2` | A `Idempotency-Key` é única no sistema, inclusive entre provedores. |
| `P1` e `P2` na arquitetura | Decisões sobre reversões. P1 limita o número de reversões da referência. P2 trata a interação de `WIN` e `LOSS` com apostas revertidas e os estornos de apostas premiadas. |
| `P0`, `P1`, `P2` na matriz | Prioridade do requisito. `P0` é núcleo ou eliminatório, `P1` é exigido e `P2` é opcional. |
| `UT`, `IT`, `CT`, `QG` e `CONF` | Prefixos do catálogo de testes. Identificam famílias como unidade, integração, concorrência, checagens de qualidade e conformidade com o MiniStack. Alguns casos de queda também usam `IT` ou `CT`. |
| Smoke | Verificação rápida do serviço em execução. O modo `full` percorre abertura de carteira, aposta, prêmio, replay, consultas e reconciliação. |
| Meta-check | Conferência final do executor para saber se todos os IDs obrigatórios esperados foram registrados como `PASS`. |
| `RV`, `SPK` e `E2E` | Outros prefixos do catálogo: `RV` reúne os testes das regras de reversão (P1 e P2), `SPK-01` é o spike de MikroORM 7 + AsyncLocalStorage + pg no Bun, e `E2E` verifica a stack completa. |
| Sufixos `h` e `s` | Variantes HTTP (`h`) e SQS (`s`) do mesmo cenário, como `CT-01h` e `CT-01s`. |
| Letra no fim do ID | Subcaso ou variante de um cenário, como `IT-21b` a `IT-21j` ou `IT-07c`. |
| ID obrigatório e informativo | Dos 133 IDs do catálogo, 132 são obrigatórios e precisam estar em `PASS` na suíte completa. O informativo (`SPK-01`) aparece no relatório, mas fica fora dessa exigência. |

## Como ler a matriz e os registros de validação

| Termo | Significado no projeto |
| --- | --- |
| `§` | Seção do enunciado ([CHALLENGE.md](CHALLENGE.md)) na coluna "Requisito" da matriz. Na coluna "Decisões" e dentro do [ARCHITECTURE.md](../ARCHITECTURE.md), seção do ARCHITECTURE. |
| `D05` a `D54` | Decisões do plano de implementação. A legenda com o tema e a seção de cada código está no início da [matriz](traceability.md). |
| Prefixos de requisito (`DOM`, `MON`, `BR`…) | Famílias de requisitos da coluna "Req". A legenda está no início da [matriz](traceability.md). |
| `V1` a `V9c` | Verificações da stack e da entrega. A legenda está em [Validado em](../README.md#validado-em), no README. |
| Execução (run) | Uma rodada do executor de testes. O ID, como `d4kexx29` ou `ixbxe23v`, identifica a rodada no relatório e no README. |
| Cópia limpa e clone Git real | Duas validações da suíte completa: os arquivos de entrega sem `.git` nem `node_modules` (`d4kexx29`) e um `git clone --no-local` do histórico (`ixbxe23v`, commit `6cb10ec`). |
| Dev Container | Ambiente opcional de desenvolvimento em `.devcontainer/`. O avaliador não precisa dele. |

## Execução dos testes

Detalhes em [§15](../ARCHITECTURE.md#15-ambiente) e
[§18 e 19](../ARCHITECTURE.md#1819-testes-rastreabilidade-trade-offs-e-limitações-f7) do ARCHITECTURE.

| Termo | Significado no projeto |
| --- | --- |
| Etapas da suíte | `static`, `conformance`, `unit`, `integration`, `concurrency` e `resilience`, nessa ordem, seguidas do meta-check. |
| Perfil `test` | PostgreSQL, MiniStack e contêiner `tests` usados só pelos testes, separados dos dados da aplicação. |
| `--phase Fn` | Roda os testes existentes e exige `PASS` só dos IDs obrigatórios até a fase `n`. |
| Estados do meta-check | `PASS` (rodou e passou), `FAIL` (algum caso falhou), `SKIPPED` (pulado), `BLOCKED` (pré-requisito do MiniStack falhou) e `NOT IMPLEMENTED` (nenhum teste do ID rodou). Na suíte completa, só `PASS` aprova um ID obrigatório. |
| Selfcheck | Falha proposital (`--selfcheck`) que prova que uma falha de teste chega ao exit code. |
| Verificador global | Consulta SQL independente da aplicação, rodada depois de cada arquivo de teste, que confere as invariantes do banco. |
| Oráculo | Resultado esperado de um teste, escrito à mão ou calculado por um modelo que não importa código de `src/`. |
| Injeção de falhas | Pontos em que um teste manda a aplicação cair ou falhar. Só existe com `NODE_ENV=test` e `FAULT_INJECTION=enabled`. |
| Cinco evidências | Critério que separa uma queda provocada pelo teste de um OOM ou de uma saída comum do processo. |
| Contenção comprovada | As operações concorrentes só são liberadas depois que `pg_stat_activity` mostra várias instâncias esperando o mesmo lock. |
| Harness | Código de teste que sobe instâncias reais da aplicação como processos e controla sinais e quedas. |

## Reversões e pendências

Detalhes em [§11](../ARCHITECTURE.md#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c) e
[§13](../ARCHITECTURE.md#13-pending_reference-e-worker-de-pendências-f4) do ARCHITECTURE.

| Termo | Significado no projeto |
| --- | --- |
| Reversão em vigor | `REFUND` ou `ROLLBACK` processado que não foi desfeito. Cada aposta tem no máximo uma (P1). |
| Reversão desfeita | `REFUND` desfeito por um `ROLLBACK` processado. Continua contando para o limite de uma reversão por tipo. |
| Aposta revertida | `BET` com uma reversão em vigor. `WIN` ou `LOSS` que a referencia é rejeitado (P2). |
| Códigos de rejeição | Valores de `failureCode`, como `INSUFFICIENT_FUNDS` e `BET_ALREADY_SETTLED`. O registro completo está em `src/shared/error-catalog.ts`. |
| TTL da pendência | Prazo para a referência aparecer: 30 minutos em produção e 3 segundos nos testes. |
| Prazo efetivo | Prazo da pendência, estendido pelo da referência quando ela também estava pendente. |
| `available_at` | Instante em que a decisão ficou disponível. A regra de prazo usa esse instante, não o horário do worker. |
| `accept_seq` e ordem de Kahn | Ordem de aceite. O worker decide a referência antes dos dependentes dela. |
| Agenda e nudge | `pending_reference_checks` guarda a próxima checagem de cada pendência. O nudge antecipa essa checagem quando a referência se torna terminal. |

## Resposta, eventos e rastreio

Detalhes em [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3)
e [§17](../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) do ARCHITECTURE.

| Termo | Significado no projeto |
| --- | --- |
| Estado atual e snapshot | O GET mostra o estado atual (`status`, `result_*`) e o saldo observado na decisão, não o saldo atual da carteira. |
| `payloadHash` | Hash do corpo de negócio. A mesma `Idempotency-Key` com outro hash gera conflito. |
| Eventos de integração | `WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionPendingReference` e `WagerTransactionRejected`. `WagerTransactionRequested` é o envelope das operações que chegam pela fila. |
| `eventId` e `messageId` | Ids estáveis de um evento publicado e de uma mensagem recebida, usados para reconhecer duplicatas. |
| `correlationId` e `causationId` | O `correlationId` liga os logs de uma operação; no HTTP, vem do header `X-Correlation-Id`. O `causationId` aponta o que provocou a operação. |
| `problem+json` e `Retry-After` | `problem+json` é o formato dos corpos de erro HTTP (RFC 9457). `Retry-After` é o header dos `503` retentáveis. |

## SQS, banco e operação

Detalhes em [§3](../ARCHITECTURE.md#3-orm-e-estratégia-transacional-f2),
[§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2),
[§12](../ARCHITECTURE.md#12-mensageria-e-falhas-f5) e [§15](../ARCHITECTURE.md#15-ambiente) do
ARCHITECTURE.

| Termo | Significado no projeto |
| --- | --- |
| `MessageGroupId` e `MessageDeduplicationId` | O `MessageGroupId` é o grupo de ordenação da fila FIFO; nos eventos, é a carteira. O `MessageDeduplicationId` é o id que a fila usa para descartar envios repetidos em 5 minutos. |
| Visibilidade, heartbeat e long poll | A visibilidade é o tempo em que uma mensagem recebida fica oculta para outros consumidores (padrão 30 s). O heartbeat renova esse tempo enquanto o tratamento continua. O long poll espera mensagens numa única chamada. |
| `maxReceiveCount` | Recebimentos sem `ack` até a fila mover a mensagem para a DLQ (padrão 8). |
| Estados do descarte | `PENDING_DLQ`, `IN_DLQ`, `REDRIVE_PENDING` e `REDRIVEN`: descarte gravado, cópia na DLQ, devolução em andamento e concluída. |
| `outbox:republish` e retenção | `outbox:republish` reenvia, por comando manual, eventos publicados que ainda estão na outbox. A retenção apaga a outbox publicada após 7 dias e a inbox processada após 30. |
| Projeção de referência | Consumidor de exemplo da fila de eventos, ligado só nos testes. |
| `SKIP LOCKED`, claim e lease | O publicador da outbox e o worker reservam itens (claim) com `SKIP LOCKED`, sem esperar os que outra instância já reservou. A reserva vale por um tempo (lease); se a instância cair, outra assume. |
| Advisory lock | Lock nomeado do PostgreSQL, usado só nas migrations e na retenção. |
| Triggers e checagens diferidas | Regras do banco que recusam estados inválidos; as diferidas rodam no `COMMIT`. |
| `wagering_owner` e `wagering_app` | `wagering_owner` é o dono do banco. `wagering_app`, o role da aplicação, não é dono de nada e não apaga dados financeiros. |
| Checksum de migration | Migration aplicada e depois editada faz o `migrate` falhar; correções viram migration nova. |
| `money_amount` | Tipo do banco para dinheiro: duas casas exatas, sem arredondamento. |
| Unit of Work, Identity Map e `rehydrate` | A Unit of Work agrupa as gravações de uma decisão numa transação. O Identity Map é o cache de entidades do MikroORM, que a leitura da carteira não usa. `rehydrate` reconstrói a carteira a partir da linha lida. |
| AsyncLocalStorage (ALS) | Contexto por requisição que leva os ids aos logs. |
| Hot wallet e head-of-line | Hot wallet é uma carteira muito disputada, cuja vazão fica limitada pelo próprio lock. Head-of-line é a mensagem lenta que segura as seguintes da mesma carteira na fila FIFO. |
| `live` e `ready` | `live` indica que o processo está vivo. `ready` indica que a instância pode receber tráfego: não está drenando, e o PostgreSQL e o SQS respondem. |
| Drenagem, `SIGTERM` e `SIGKILL` | `SIGTERM` pede encerramento controlado, em que a instância drena o que está em andamento; `SIGKILL` derruba na hora. |
| Papéis do processo | `api`, `consumer`, `outbox-publisher` e `pending-reference-worker`, ligados por `APP_ROLES`. |
| `migrate`, `init-queues`, `healthcheck` e `verify` | `migrate` e `init-queues` preparam o banco e as filas e podem rodar de novo sem apagar dados. `healthcheck` mostra `live` e `ready`; `verify` confere as invariantes do sistema, só com leitura. |
