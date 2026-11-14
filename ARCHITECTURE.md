# Arquitetura do Distributed Wagering Processor

**Estado: F0 a F7 concluídas** (2026-11-13, Windows 11 + Docker Desktop/WSL 2). A suíte completa
com meta-check estrito passou numa cópia limpa e temporária dos arquivos de entrega, num projeto
Compose isolado: na execução d4kexx29, 133 IDs ficaram em PASS, sendo 132 obrigatórios e um
informativo (SPK-01). Num clone Git real do histórico, a execução ixbxe23v repetiu o resultado.
O registro de cada execução está no [histórico de validações](docs/validacao.md).
Gates I1, I2, P1 e P2 decididos e implementados (ver abaixo).

## Roteiro de leitura

Pontos de entrada e etapas do processamento de uma transação.

1. [`SubmitWagerTransaction`](src/modules/wagering/application/submit-wager-transaction.ts): caso de
   uso único, chamado pela API HTTP e pelo consumidor SQS. Aplica a idempotência, faz o lock da
   wallet e grava a decisão na mesma transação SQL
   ([§6, 10 e 14](#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3)).
2. [`SettlementPolicy`](src/modules/wagering/domain/settlement-policy.ts): regras de negócio puras,
   sem I/O. Decide aplicar, rejeitar com um código do ErrorCatalog ou aguardar a referência
   ([§8–9](#89-transições-de-estado-e-errorcatalog-f1) e
   [§11](#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c)).
3. [`SettlementRecorder`](src/modules/wagering/application/settlement-recorder.ts): grava o desfecho
   (transação, saldo, lançamento, linha de reversão e eventos na outbox), tanto na chegada quanto
   quando o worker resolve uma pendência
   ([§11](#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c) e
   [§13](#13-pending_reference-e-worker-de-pendências-f4)).
4. [`WagerMessageConsumer`](src/modules/messaging/infrastructure/wager-message-consumer.ts): consome
   a fila de entrada. Grava a inbox na mesma transação SQL da decisão, confirma a mensagem (ack) só
   depois do commit e cuida do dead-letter ([§12](#12-mensageria-e-falhas-f5)).

Três decisões, cada uma com o teste que a comprova:

- **Lock por wallet.** [CT-02h](test/concurrency/balance-race.test.ts): duas apostas de 80.00 BRL,
  enviadas a instâncias diferentes, disputam um saldo de 100.00 BRL. Uma é aplicada (200), a outra
  é rejeitada com `INSUFFICIENT_FUNDS` (422), e o saldo termina em 20.00 BRL, com um único débito.
- **Resposta original congelada (I1).** [IT-10b](test/integration/pending-worker.test.ts): um
  REFUND que chega antes da BET recebe 202 com o saldo de 100.00 BRL. Depois que o worker resolve a
  pendência, o reenvio do POST devolve o mesmo 202, só com `idempotentReplay: true`, e o GET mostra
  o desfecho: PROCESSED, com o saldo da decisão (80.00 BRL).
- **Inbox na transação da decisão.** [CT-05](test/resilience/consumer-crashes.test.ts): o
  consumidor cai entre o commit e o ack de uma BET de 10.00 BRL. A mensagem é reentregue, a
  instância seguinte a reconhece pela inbox como duplicata, e a aposta tem um único débito.

---

## 1. Contexto, drivers e não-escopo

O sistema recebe transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) por
HTTP e por SQS, mantém o saldo de wallets e um ledger imutável, e publica
eventos de integração. O enunciado está em [docs/CHALLENGE.md](docs/CHALLENGE.md).

**Princípio central.** O PostgreSQL é a autoridade final das invariantes
financeiras: constraints, locks e transações. Ordem FIFO, deduplicação do broker
e ordem de chegada são otimizações e nunca garantias de correção.

| Driver (peso no §14) | Cenário verificável |
|---|---|
| Correção financeira (20) | Saldo = Σ ledger ao fim de todo teste; dinheiro nunca é `number` |
| Concorrência (20) | Cenário do §8 com ≥ 3 instâncias: 1 PROCESSED, 1 REJECTED, saldo 20.00 |
| Idempotência (15) | 50 envios iguais em paralelo → 1 débito e 49 replays idênticos |
| Mensageria e falhas (15) | Queda após o commit e antes do ack → efeito único |
| Modelagem (10) | Domínio puro; regra de dependência verificada por teste (QG-03) |
| Testes (10) | PostgreSQL e MiniStack reais, contenção e queda comprovadas |
| Observabilidade e documentação (10) | Logs JSON com ids, métricas, live/ready, README e este documento |

**Não-escopo:** partidas dobradas completas, OpenTelemetry e dashboards
(opcionais no enunciado); autenticação real (ver "Limitações conhecidas", §18–19).

### Interpretações decididas

**I2 (escopo da Idempotency-Key): global** (decidido pelo usuário em
2026-11-11). É uma interpretação do §9 do enunciado, que diz que o header
`Idempotency-Key` "é a fonte da verdade" e que a mesma key com payload diferente
é conflito. Leitura adotada:

- A key **informada** no header (ou em `data.idempotencyKey` na fila) é a fonte da
  verdade, comparada byte a byte, sem normalização e sem ser derivada de outros campos.
- O formato `"{providerId}:{externalTransactionId}"` é o **padrão recomendado**
  pelo §9, **não obrigatório**: qualquer key opaca no formato aceito
  (`^[!-~]{1,255}$`) é válida, com ou sem providerId.
- A unicidade é **global**: `UNIQUE (idempotency_key)`, sem o providerId no índice.
  A mesma key com payload diferente gera `409 IDEMPOTENCY_KEY_REUSED`, **inclusive
  vinda de outro provedor**. Nesse caso o 409 não revela `existingTransactionId`
  nem detalhes da transação alheia.
- Consequência aceita: dois provedores não podem reutilizar a mesma key; quem
  segue o formato recomendado evita colisões naturalmente. Sem autenticação real,
  quem declara o providerId de outro com o mesmo payload e a mesma key recebe o
  replay da transação desse outro (limitação comum às duas opções; a F8 a fecha).
- Alternativa rejeitada: escopo por provedor, `UNIQUE (provider_id, idempotency_key)`.

**I1 (replay de uma requisição cuja 1ª resposta foi 202): resposta original
congelada** (decidido pelo usuário em 2026-11-12, opção A). É uma interpretação do
§9 do enunciado ("requisição idêntica → mesma resposta, `idempotentReplay: true`"),
lido em conjunto com o §7 regra 7 (resultado original com o saldo observado naquele
momento). O enunciado não diz expressamente o que o replay devolve quando a 1ª
resposta foi `202` e a transação foi resolvida depois. Leitura adotada:

- A mesma key com o **mesmo payload** devolve sempre o **código HTTP e o corpo da
  primeira resposta**, alterando apenas `idempotentReplay` para `true`. Vale também
  quando a 1ª resposta foi `202` (`PENDING_REFERENCE`, com o saldo observado no
  aceite) e a transação já foi resolvida (`PROCESSED`) ou rejeitada (`REJECTED`,
  inclusive por prazo): o replay continua `202` com o mesmo corpo.
- A resposta original vem das colunas imutáveis `initial_status`,
  `accepted_balance` e `accepted_wallet_version` (e do `failure_code` original nas
  rejeições decididas na chegada). O replay é somente leitura: não decide nada.
- O **estado atual** fica nos GETs (`/wagering/transactions/:id` e a rota por
  provedor): status atual e, quando terminal, o **saldo histórico da decisão**
  (`result_balance`, `result_wallet_version`, `decided_at`, `failureCode`), além de
  `initialStatus` e do saldo aceito para auditoria. Nenhum dos dois mostra o saldo
  atual da wallet, que é o de `GET /wallets/:id`.
- A mesma key com **payload diferente** continua sendo `409 IDEMPOTENCY_KEY_REUSED`
  (I2), sem revelar dados da transação existente.
- Consequência aceita: o provedor não descobre o desfecho de uma pendência
  reenviando a requisição; ele consulta o GET ou consome os eventos
  (`WagerTransactionProcessed` / `WagerTransactionRejected`).
- Alternativa rejeitada: devolver o estado posterior até ficar terminal (o mesmo
  pedido receberia `202` e depois `200`/`422`, e o resultado dependeria de o replay
  chegar antes ou depois do worker).
- Verificado pelo IT-10b (F4): depois de o worker resolver a pendência, o POST repetido
  continua devolvendo o 202 original e o GET mostra o desfecho.

**P1 (reversões da mesma referência): opção C** (decidido pelo usuário em 2026-11-12;
implementado na F4, ver §11). Interpretação do §7 (tabela: REFUND e ROLLBACK
revertem "uma única vez"; regra 4: "não pode ser revertida duas vezes pelo mesmo tipo de
operação") lido junto com o §3 ("não pode duplicar créditos"). O texto não diz se reversões
de tipos diferentes podem coexistir nem se "uma única vez" vale por tipo ou por referência.
Leitura adotada:

- **No máximo uma reversão aplicada por (referência, tipo)**, contando as que foram desfeitas
  depois: um segundo REFUND da mesma BET é REJECTED `REVERSAL_KIND_ALREADY_USED`, mesmo que o
  primeiro tenha sido desfeito (regra 4).
- **No máximo uma reversão em vigor por referência**: reversão em vigor é uma reversão
  PROCESSED que não foi desfeita por um ROLLBACK PROCESSED (só um REFUND pode ser desfeito
  assim). Com um REFUND em vigor, um ROLLBACK da mesma BET é REJECTED
  `REFERENCE_ALREADY_REVERSED`; depois de o REFUND ser desfeito, o ROLLBACK da BET é aceito.
- Consequência: o crédito líquido sobre uma aposta é sempre 0 ou o valor dela; o stake nunca
  volta duas vezes, em qualquer ordem de chegada.
- Alternativas rejeitadas: (A) uma por tipo, sem limite de reversões em vigor: permite
  devolver o stake duas vezes (REFUND + ROLLBACK da mesma BET); (B) uma por referência para
  sempre: impede cancelar uma aposta cujo reembolso foi desfeito.
- No banco (migration 0002, F4): tabela `wager_reversals` com unicidade por (alvo, tipo) e
  índice parcial de uma reversão em vigor por alvo; as reversões que a F3 já tiver gravado
  entram na tabela na própria migration, que falha alto se algum dado existente violar a
  regra (§11).

**P2 (WIN/LOSS e reversões da mesma BET): opção (c)** (decidido pelo usuário em
2026-11-12; implementado na F4, ver §11). O enunciado não trata da relação entre
WIN/LOSS e reversões da mesma BET; tudo abaixo é interpretação, motivada pelo §3 (entrega
fora de ordem e "não pode duplicar créditos"):

- **BET revertida** significa BET com uma reversão **em vigor** (definição de P1). O
  histórico de um reembolso já desfeito, por si só, não impede WIN nem LOSS.
- WIN ou LOSS que referencia uma BET revertida → REJECTED `REFERENCED_BET_REVERSED`.
- REFUND ou ROLLBACK de uma BET que tem um WIN em vigor apontando para ela (WIN PROCESSED
  não estornado por ROLLBACK) → REJECTED `BET_ALREADY_SETTLED`. O provedor estorna o WIN
  (ROLLBACK do WIN) antes de reverter a aposta.
- Nas duas ordens de chegada vale só um dos créditos (stake devolvido **ou** prêmio), nunca os
  dois.
- **WIN sem referência à BET é preservado como o enunciado permite** (§7: o WIN "pode
  referenciar" a BET): ele não fica ligado à aposta e as regras acima não o alcançam.
  Limitação documentada.
- **Um reembolso rejeitado continua rejeitado.** Se o REFUND recebeu 422
  `BET_ALREADY_SETTLED`, estornar o WIN depois não muda aquela resposta: o reenvio com a
  mesma Idempotency-Key devolve o mesmo 422 (I1), e a mesma key com outro payload é 409.
  Para pedir o reembolso de novo, o provedor envia uma operação nova, com novo
  `externalTransactionId` **e** nova Idempotency-Key (reaproveitar só o externalId com outra
  key é 409 `EXTERNAL_TRANSACTION_ID_CONFLICT`).
- Alternativas rejeitadas: (a) nenhuma regra extra: permite stake devolvido e prêmio na
  mesma aposta; (b) só WIN/LOSS após reversão: o resultado dependeria da ordem de chegada
  (reversão→WIN fica com um crédito; WIN→reversão, com os dois).

## 2. Estilo e módulos

**Monólito modular com módulos hexagonais**; as três instâncias usam a mesma imagem da aplicação.
Transação, saldo, ledger, inbox e outbox precisam comitar juntos; separar em
serviços exigiria saga ou 2PC sem ganho para os drivers acima.

- Módulos: `shared` (kernel: Money, erros, portas), `wallet`, `wagering`,
  `messaging`, `health` e `platform` (config, persistência, observabilidade, ciclo de vida).
- Regra de dependência: `wagering → wallet → shared`. Código em `domain/`,
  `application/` e `src/shared/` não importa `@nestjs/*`, `@mikro-orm/*`,
  `@aws-sdk/*`, `pg`, `pino` nem `prom-client`. Verificado pelo teste QG-03
  (com autoteste do verificador em fixtures).
- Papéis por processo (`APP_ROLES`: api, consumer, outbox-publisher,
  pending-reference-worker). O padrão liga todos. Não há eleição de líder: as
  instâncias competem por claims no PostgreSQL.
- Composição explícita: `AppModule.forRoot(deps)` recebe dependências já
  construídas (config, logger, sondas, injetor de falhas, métricas), o que mantém
  o grafo de DI pequeno e testável (QG-05).

**Alternativas rejeitadas:** microserviços (transação distribuída para um único
agregado financeiro); camadas sem portas (acopla regra de negócio ao ORM).

## 3. ORM e estratégia transacional (F2)

**MikroORM 7** (preferencial no enunciado), com três papéis bem separados:

- **Unit of Work transacional:** `MikroOrmUnitOfWork.run(fn)` abre um fork limpo
  do EntityManager por tentativa, inicia `em.transactional` em READ COMMITTED,
  aplica `SET LOCAL lock_timeout/statement_timeout` e só comita se `fn` resolver.
  Em 40001/40P01/55P03 a unidade inteira é refeita (até 3 vezes, fork novo); 23505
  sobe para o caso de uso classificar. O dono da transação é sempre o caso de uso.
- **Caminho financeiro com SQL explícito:** dentro da unidade, repositórios usam
  `TxSql`, o único acesso a SQL cru, que lança `OutsideTransactionError` se usado
  fora da transação (handle vazado ou falso). A wallet é lida com
  `SELECT … FOR UPDATE`, nunca pelo Identity Map; IT-08 mostra por quê: um
  fork que já carregou a wallet devolve o valor antigo depois de outra escrita.
- **Leituras com records `defineEntity`:** `WalletRecord` e `LedgerEntryRecord`
  (separados do domínio) atendem os GETs, sempre num fork novo. Dinheiro é
  `decimal` em modo string; nenhum parser de `numeric` é trocado (IT-06).
- **Migrations escritas à mão em SQL**, registradas em lista explícita, executadas
  pelo migrator programático do MikroORM sob advisory lock, com checksum
  (migration aplicada e depois editada faz o job falhar).

Placeholders do `em.execute` são `?` (verificado no MikroORM 7.2.8).

## 4. Money

`Money` guarda o valor como **bigint em unidades mínimas** (escala fixa 2) e a
moeda. Não usa `number`, float, `toFixed` nem bibliotecas decimais: o `Decimal`
sugerido no esqueleto do enunciado foi trocado porque implementações comuns têm
precisão global (20 dígitos) e `-0`; com bigint a aritmética é exata por construção.

- **Contrato de entrada:** `^(0|[1-9][0-9]{0,14})\.[0-9]{2}$`, só ASCII, sem
  espaços nem sinal; moeda `^[A-Z]{3}$` na whitelist (BRL, USD). Rejeições têm
  motivo (`SCALE`, `FORMAT`, `NEGATIVE`, `TYPE`, `OUT_OF_RANGE`) e viram
  `INVALID_AMOUNT`/`UNSUPPORTED_CURRENCY`. **Nada é arredondado:** `25.005` é recusado.
- **Limite único** `999999999999999.99`, o mesmo do DOMAIN SQL `money_amount` (§5–7).
- Imutável e congelado; moedas diferentes lançam `CurrencyMismatchError`;
  `valueOf` lança para impedir aritmética implícita; `toJSON` → `{amount, currency}`.
- Lint (QG-02) proíbe `parseFloat`, `toFixed`, `Math.round`, campos monetários
  `number` e `version = version + 1` em SQL; o teste prova que cada regra dispara.

## 5–7. Schema e invariantes no banco (F2)

O PostgreSQL é a autoridade final (§5 item 9). Migration `0001`:

| Invariante | Onde |
|---|---|
| Dinheiro exato, escala 2, abs < 1e15 | `DOMAIN money_amount` (`scale(VALUE) = 2`); `numeric(p,2)` foi rejeitado porque arredonda calado |
| 1 wallet por (player, moeda); saldo ≥ 0; versão ≥ 1 | `wallets_player_currency_uq`, `wallets_balance_nonneg_ck`, `wallets_version_ck` |
| Versão sobe 1 se e somente se o saldo muda; identidade imutável | trigger `wallets_guard` |
| **Idempotency-Key global, byte a byte (I2)** | `wtx_idempotency_key_uq` sobre coluna `COLLATE "C"`, formato `^[!-~]{1,255}$` |
| (provider, externalTransactionId) único | `wtx_provider_external_uq` |
| Referência por kind; sem auto-referência; OPENING só com provider interno; PENDING nunca gravado | `wtx_reference_by_kind_ck`, `wtx_self_reference_ck`, `wtx_opening_provider_ck`, `wtx_status_ck` |
| Resposta original congelada (`initial_status`, `accepted_*`) e resultado terminal (`result_*`, `decided_at`, `available_at`) | `wtx_initial_consistency_ck`, `wtx_result_presence_ck` + trigger `wtx_guard` |
| Lançamento aritmeticamente correto, ≥ 0, 1 por (wallet, versão) e por transação | `ledger_arithmetic_ck`, `ledger_balances_nonneg_ck`, `ledger_wallet_version_uq`, `ledger_tx_wallet_uq` |
| Cadeia do ledger: before(v) = after(v−1); wallet 0.00 começa sem lançamento | trigger `ledger_chain_guard` (imediato) |
| Ledger imutável | REVOKE para o role da app + triggers `ledger_immutable`/`ledger_no_truncate` para o dono |
| Saldo = cabeça do ledger; efeito por status (LOSS/REJECTED/PENDING sem lançamento); direção por kind; snapshots dentro da cadeia; referência coerente | constraint triggers **diferidas** (`wallets_head_deferred`, `wtx_consistency_deferred`, `ledger_consistency_deferred`), checadas no COMMIT |
| Outbox: payload imutável; `published_at` só de NULL para valor | trigger `outbox_guard` |

O role `wagering_app` não é dono de nada: recebe `SELECT/INSERT` e `UPDATE` só
nas colunas que o fluxo precisa (por exemplo `wallets(balance, version,
updated_at)`), sem `DELETE`/`TRUNCATE`. Limitação documentada: dono ou superusuário
podem desligar triggers; a reconciliação detecta o efeito (IT-17 fabrica esse
caso com `session_replication_role = replica`).

Não estão nesta migration: tabela de reversões e agenda de pendências (migration 0002,
F4, §11 e §13), inbox e dead-letter (F5).

**POST /wallets** grava wallet, OPENING, lançamento CREDIT v1 e os eventos
`WagerTransactionProcessed` + `WalletBalanceChanged` na outbox numa única
transação SQL. A corrida por (player, moeda) é decidida pelo índice único e vira
409 com o id vencedor. A publicação da outbox é da F5.

## 8–9. Transições de estado e ErrorCatalog (F1)

`WagerTransaction` nasce `PENDING` (só em memória). Transições: `PENDING →
{PROCESSED, PENDING_REFERENCE, REJECTED, FAILED}`; `PENDING_REFERENCE →
{PROCESSED, REJECTED, FAILED}` (repetir `markPendingReference` é no-op). A partir
de um estado terminal, qualquer transição lança `InvalidTransactionStateError`:
é bug, não regra de negócio.

`SettlementPolicy` aplica as linhas da precedência comuns a todas as opções de
reversão: referência ausente/pendente → aguardar; escopo (provider, player,
wallet, moeda e rodada; `gameId` não entra); kind compatível; referência
PROCESSED; valor igual; saldo (`INSUFFICIENT_FUNDS` para BET,
`REVERSAL_INSUFFICIENT_FUNDS` para ROLLBACK que debita); limite de saldo.
As linhas que dependem de P1/P2 (10a–10c) ficam numa `ReversalRule`; desde a F4 a regra
padrão é `DECIDED_REVERSAL_RULE` (P1 = C, P2 = (c), §11). A regra anterior, que lançava
`ReversalRuleUndecidedError`, continua no código só para o teste que prova que a política
não escolhia um desfecho em silêncio antes da decisão.

O `ErrorCatalog` (`src/shared/error-catalog.ts`) é o registro único de códigos,
exaustivo por tipo: status HTTP (400/401/403/404/409/422/500/503), se persiste,
`retryable` (só no 503), ação no consumidor SQS e ação esperada do provedor.

`payloadHash` = `v1:` + sha256 do JSON canônico (chaves ordenadas, sem espaços,
`null` ≡ ausente, UUIDs em minúsculas) de providerId, externalTransactionId,
playerId, walletId, roundId, gameId, kind, money e referenceExternalTransactionId.
Ficam fora a Idempotency-Key e metadados de transporte. Golden vector do exemplo
do §9: `v1:629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344`
(UT-07, calculado também de forma independente no teste).

## 6, 10 e 14. Submissão HTTP, concorrência, idempotência e autenticação (F3)

**Caso de uso único** `SubmitWagerTransaction` (`src/modules/wagering/application`),
usado pela API HTTP e pelo consumidor SQS (§12). Ordem de avaliação no HTTP:

1. Validar a requisição e o provedor.
2. Procurar uma resposta gravada e verificar conflitos.
3. Para uma operação nova, bloquear a wallet, conferir seu vínculo e sua moeda e repetir a
   checagem de idempotência sob o lock.
4. Carregar a referência quando necessária e aplicar a política.
5. Gravar a decisão e seus efeitos na mesma transação SQL.
6. Responder depois do commit da nova decisão.

**Concorrência (§8).** Lock pessimista por wallet: dentro de uma `UnitOfWork` em READ COMMITTED,
a wallet é lida com `SELECT … FOR UPDATE` em SQL explícito e reconstruída com `Wallet.rehydrate`.
Duas apostas da mesma wallet se serializam na fila desse lock; wallets diferentes nunca disputam o
mesmo lock (não há lock global). Sob o lock, a referência é lida por (providerId,
referenceExternalTransactionId), com a `ReversalView` do alvo, antes da `SettlementPolicy`. O
`UPDATE` condicionado à versão, o `CHECK balance >= 0` e as checagens diferidas da migration 0001,
que recusam no COMMIT qualquer caminho incoerente, são barreiras extras.
Uma transação SQL toca uma única wallet e adquire os recursos sempre na mesma ordem
(wallet → transação → ledger → outbox), sem I/O externo dentro dela: não há ciclo de espera.
40001/40P01/55P03 refazem a unidade inteira até 3 vezes; esgotado, `503 CONCURRENCY_CONFLICT`.
Optimistic locking puro foi rejeitado porque, na hot wallet, transforma disputa em retries e
503 para o provedor; `SERIALIZABLE`, pelo mesmo motivo; advisory lock por wallet, por não
proteger a linha contra um escritor que o esqueça.

**Idempotência (I2, I1).** Antes do lock, um caminho rápido no read model procura a key: key
existente → replay ou 409; (provider, externalId) existente com outra key → 409. Duplicatas na
mesma wallet esperam o lock e viram replay na nova checagem de key e externalId sob o lock.
Duplicatas que miram wallets diferentes (payload diferente) só se encontram
no índice único: o 23505 de `wtx_idempotency_key_uq` ou `wtx_provider_external_uq` é
relido e vira replay ou 409. Não há estado "em andamento". O replay monta a resposta só com
dados imutáveis gravados (`initial_status`, `accepted_*`, `failure_code` original,
`correlation_id`): 200/202 com `{transactionId, status, balance, idempotentReplay}` e 422 em
problem+json com `transaction {…}` e `detail` fixo por código, para o corpo ser idêntico.

**Respostas.** Cada desfecho grava seus efeitos na mesma transação SQL:

- 200 PROCESSED com efeito no saldo (BET, WIN, REFUND, ROLLBACK): `INSERT` da transação,
  `UPDATE wallets … WHERE version = esperada` (rowcount 1), lançamento e outbox
  `WagerTransactionProcessed` + `WalletBalanceChanged`; uma reversão grava também sua linha em
  `wager_reversals` (§11).
- 200 PROCESSED de LOSS: `INSERT` da transação com a decisão (saldo e versão observados) e
  `WagerTransactionProcessed` na outbox, sem alterar saldo, versão ou ledger.
- 202 PENDING_REFERENCE: `INSERT` da transação com o aceite (saldo e versão observados) e o prazo
  (`pending_deadline_at` = aceite + `PENDING_REFERENCE_TTL_MS`, no relógio do PostgreSQL), a linha
  da agenda de reavaliação em `pending_reference_checks` e `WagerTransactionPendingReference` na
  outbox; sem lançamento nem versão nova.
- 422 REJECTED, inclusive pelas regras de reversão de P1/P2 (`REVERSAL_KIND_ALREADY_USED`,
  `REFERENCE_ALREADY_REVERSED`, `REFERENCED_BET_REVERSED`, `BET_ALREADY_SETTLED`; §11): código
  gravado, sem lançamento, e `WagerTransactionRejected`. O IT-11 confere o REFUND de uma BET já
  premiada: 422 `BET_ALREADY_SETTLED`, rejeição persistida sem lançamento.

Os demais códigos não gravam nada: 415 e 413 no transporte (`readJsonBody` confere o
`Content-Type`, depois o limite de 16 KiB antes do parse, depois o JSON); 400 contrato
(`Idempotency-Key`, schema zod `.strict()`, regras por kind de `WagerTransaction.create`) ou
wallet de outro player ou moeda (`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`); 401 autenticação
recusada; 403 provedor fora de `PROVIDER_IDS`; 404 wallet ou transação inexistente; 409 conflito;
503 transitório com `Retry-After`; 500 erro interno. 200/202/422 levam
`Location: /wagering/transactions/{id}`. Os GETs mostram o estado atual e o saldo da
decisão (nulo enquanto pendente), nunca o saldo atual da wallet.

**Timeouts (D25).** Servidor: `lock_timeout`, `statement_timeout` e
`idle_in_transaction_session_timeout` locais à transação (uma instância congelada no meio da
transação é derrubada pelo banco e libera a wallet). Cliente: `query_timeout` (maior que o
`statement_timeout`, validado no boot) e `connectionTimeoutMillis` no pool do `pg`; banco que
não responde → `503 DATABASE_UNAVAILABLE`.

**Autenticação (§2, U1).** Hoje não há autenticação real, por decisão registrada: `AuthGuard`
global com `AuthenticationPort` (adaptador `noop`; `deny-all` existe só com `NODE_ENV=test`
para provar que o guard está ligado) e `@Public()` em health e métricas.
`ProviderIdentity` confere o registro de provedores. Limitação: quem declara o providerId de
outro com o mesmo payload e a mesma key recebe o replay dele. O IdP externo está descrito em
"Limitações conhecidas" (§18–19).

**Limitações conhecidas da F3.** Na F3, PENDING_REFERENCE ficava pendente (o worker veio
na F4, §13); a publicação da outbox é da F5; numa hot wallet as requisições esperam na fila do lock e do
pool (CT-13 mostra que o health continua respondendo pela conexão dedicada).

## 11. Reversões no schema e no domínio (F4; P1 = C, P2 = (c))

**Domínio.** `DECIDED_REVERSAL_RULE` aplica, sobre a `ReversalView` do alvo carregada sob o
lock da wallet, nesta ordem: (10a) o mesmo tipo já reverteu o alvo, mesmo desfeito →
`REVERSAL_KIND_ALREADY_USED`; (10b) há outra reversão em vigor → `REFERENCE_ALREADY_REVERSED`;
(10c) REFUND/ROLLBACK de BET com WIN em vigor → `BET_ALREADY_SETTLED`; WIN/LOSS sobre BET com
reversão em vigor → `REFERENCED_BET_REVERSED`. Depois vêm as linhas comuns (saldo, limite).
O `SettlementRecorder` grava o desfecho decidido (na chegada pela API ou na resolução pelo
worker) pelo mesmo código: transação, wallet, lançamento, linha de reversão e eventos.

**Schema (migration 0002).** Tabela `wager_reversals`, uma linha por reversão PROCESSED:

| Invariante | Mecanismo |
|---|---|
| ≤ 1 reversão por (alvo, tipo), contando as desfeitas | `rev_target_kind_uq` |
| ≤ 1 reversão em vigor por alvo | índice parcial `rev_one_effective_uq ON (target_id) WHERE undone_by IS NULL` |
| Pares válidos (REFUND→BET; ROLLBACK→BET/WIN/REFUND); direção inversa à do alvo | `rev_pair_ck`, `rev_direction_ck`, `rev_target_direction_ck` |
| Só um REFUND pode ser desfeito; quem desfaz tem esta linha como alvo | `rev_undo_kind_ck`, `rev_undone_by_uq`, FK diferida `rev_undone_by_fk` |
| A linha descreve uma reversão que aconteceu (vínculo, tipo, wallet, moeda, valor, lançamentos) | FKs diferidas para `wager_transactions` e `wallet_ledger_entries` (apoiadas em `wtx_key5_uq`, `wtx_ref_link_uq`, `ledger_tx_dir_amt_uq`) |
| Toda REFUND/ROLLBACK PROCESSED tem a sua linha; o ROLLBACK de REFUND marca `undone_by` | trigger de constraint diferida `wtx_reversal_coverage_deferred` (`rev_coverage_ck`, `rev_undo_link_ck`) |
| Linhas imutáveis; `undone_by` só de NULL para valor; sem DELETE/TRUNCATE | triggers `rev_guard` (`rev_immutable`) e `rev_no_truncate` |
| P2 no banco: reversão de BET com WIN em vigor; WIN/LOSS processado sobre BET revertida | triggers `rev_settled_bet_guard` (`rev_settled_bet_ck`) e `wtx_settlement_guard` (`wtx_reversed_bet_settlement_ck`) |

O role da aplicação só tem `SELECT/INSERT` e `UPDATE(undone_by)` na tabela. O RV-CT-04 grava
duas reversões concorrentes da mesma BET por SQL, sem passar pela política: uma comita e a
outra é barrada pelo banco.

**Dados da F3.** A 0002 preenche `wager_reversals` a partir das reversões PROCESSED já
gravadas (primeiro as de alvo WIN/REFUND, depois as de BET, com `undone_by` vindo do ROLLBACK
do REFUND). Se algum dado existente violar P1 ou P2, os índices e as constraints fazem a
migration falhar e nada é aplicado. Durante a migration as checagens diferidas da 0001 rodam
ao fim de cada comando (`SET CONSTRAINTS ALL IMMEDIATE`): sem isso, num banco com dados, o
preenchimento deixava eventos de trigger pendentes e o `ALTER TABLE` seguinte falhava (55006). Teste: IT-02 de atualização, com um REFUND já desfeito,
um ROLLBACK de WIN e uma PENDING_REFERENCE gravados no schema da 0001.

## 12. Mensageria e falhas (F5)

**Mesmo caso de uso nos dois canais.** O consumidor (papel `consumer`, 4 pollers por instância,
uma mensagem por vez, long poll) valida o envelope `WagerTransactionRequested` com o mesmo
schema do HTTP e chama `SubmitWagerTransaction`. A inbox (`inbox_messages`, migration 0003) é
gravada **na mesma transação SQL** da decisão: transação, saldo, lançamento, outbox e inbox
comitam juntos. O `DeleteMessage` (ack) só acontece depois do commit.

| Situação | Ação |
|---|---|
| Decisão de negócio (PROCESSED, REJECTED, PENDING_REFERENCE) | commit (tx + saldo + lançamento + outbox + inbox) e ack |
| messageId novo com Idempotency-Key já usada e mesmo payload | inbox `REPLAY` numa transação própria e ack; nenhum evento novo |
| Mesmo messageId, mesmo envelope (reentrega) | ack sem efeito (`consumer.duplicate`) |
| Mesmo messageId, outro envelope | dead-letter `MESSAGE_ID_PAYLOAD_MISMATCH` |
| Contrato, OPENING, provedor desconhecido, wallet inexistente, conflito de key ou externalId | dead-letter com o código do ErrorCatalog |
| Erro transitório ou desconhecido | sem ack; `ChangeMessageVisibility` com backoff; esgotado o `maxReceiveCount`, a RedrivePolicy do broker move a mensagem |
| 23xxx no commit (bug de integridade) | dead-letter `INTERNAL_ERROR` |

Entregas concorrentes do mesmo messageId se serializam no `ON CONFLICT DO NOTHING` da inbox: a
segunda desfaz a tentativa inteira e é tratada como duplicata.

**Dead-letter (D35).** A decisão de descartar é commitada antes de qualquer envio ou ack, em
`dead_letter_messages`, com identidade (consumidor, `dl_key`, `body_hash`): `dl_key` é o messageId
do envelope (ou `sqs:<MessageId>` se o corpo não for legível) e `body_hash` é o sha256 dos bytes
recebidos, então mensagens com o mesmo messageId e corpos diferentes nunca se confundem. Passos:
commit PENDING_DLQ → envio à DLQ (corpo intacto, atributos `dlqReason`, `consumerName`,
`receiveCount`, `dlAttempt`, `sourceMessageId`) → IN_DLQ → delete na origem. Uma reentrega retoma
do passo em que parou sem reprocessar o negócio. As transições são guardadas por trigger
(`dead_letter_guard`); o registro nunca é apagado. Um PENDING_DLQ acima de
`DEAD_LETTER_STUCK_AFTER_MS` (15 min em produção) gera o alerta `dead_letter_pending_stuck`.

**Redrive (`bun run sqs:redrive`, D36).** Para cada cópia da DLQ: decide pelo registro e pelo
`dlAttempt` da cópia (ausente = cópia movida pelo broker, sempre redrivada), commita
REDRIVE_PENDING, reenvia à origem, marca REDRIVEN e apaga a cópia. Uma cópia de tentativa antiga
ou já redrivada é obsoleta e só é apagada. Rodar de novo depois de uma queda é seguro. Cada chave é
redrivada no máximo uma vez por execução: uma mensagem que falha de novo volta à DLQ com tentativa
nova e fica para a execução seguinte (sem isso, uma mensagem inválida circularia sem fim).

A identidade do descarte sobrevive ao redrive mesmo para corpo ilegível (JSON malformado, sem
messageId): a chave `sqs:<MessageId da origem original>` vai no atributo `deadLetterKey` da cópia
na DLQ e do reenvio à origem, porque o SQS dá um MessageId novo a cada envio. O corpo segue
intacto. Assim a mensagem que falha de novo volta como tentativa 2 do MESMO registro (e é adiada
pela execução em curso), enquanto dois envios independentes do mesmo corpo, sem o atributo,
continuam sendo descartes distintos. Correção feita depois da primeira validação da F5: sem o
atributo, a cópia reenviada ganhava chave e registro novos a cada volta e a execução do redrive
não terminava (IT-21g, caso do JSON malformado).

**MessageDeduplicationId.** Valores externos nunca entram crus: `dedupId(tipo, partes)` = tipo +
40 hex do sha256 das partes (cada parte prefixada pelo tamanho) + sufixos de tentativa
(`dlq:<hex>:a2`, `rd:<hex>:a1:r3`), sempre ≤ 64 caracteres no conjunto aceito pela AWS. A mesma
tentativa reusa o mesmo id (o FIFO absorve o reenvio na janela de 5 min); uma tentativa nova gera
id novo. A publicação normal usa o eventId (UUID). O MiniStack não valida esse limite (CONF-21)
nem devolve o atributo `MessageDeduplicationId` no Receive: a garantia é da função (UT-14), o id
enviado é registrado nos logs `dlq.sent` e `redrive.sending`, e o IT-21i confere, no SQS real, o
envio com messageId de 200 caracteres e o reuso do mesmo id no retry da mesma tentativa.

**Outbox (D38).** O publicador (papel `outbox-publisher`) reivindica lotes de até 10 em
autocommit (`FOR UPDATE SKIP LOCKED`, lease, `claim_token`), envia com `SendMessageBatch` fora de
transação (MessageGroupId = walletId, DedupId = eventId) e marca `published_at` só dos itens
aceitos, sem fencing; reagendar com backoff exige o claim (fencing). Um lease vencido é retomado
por outra instância; o reenvio é absorvido pelo FIFO na janela de 5 min e, fora dela, pelo eventId
no consumidor.

**Encerramento (D37).** SIGTERM: readiness 503 → para de emitir polls (o corrente termina em ≤
Wait) → espera as mensagens em voo até `SHUTDOWN_DRAIN_MS` → devolve a visibilidade (0) das que
sobrarem (e para o heartbeat delas) → publicador e worker → HTTP → banco → exit 0. Cada
fechamento de recurso tem prazo (`SHUTDOWN_CLOSE_TIMEOUT_MS`): uma transação devolvida na
drenagem (nada comitado, mensagem de volta à fila) ainda segura uma conexão, que cai com o
processo.

**Partida resiliente.** A app espera o PostgreSQL sem crash loop, recusa subir com migration
pendente (`boot.pending_migrations`) e sobe com o SQS ausente (ready 503 até ele voltar). Com
`SQS_PROVISION_ON_BOOT=1` (stack do compose) as filas são reprovisionadas no boot e quando o
emulador responde QueueDoesNotExist, sem purge nem delete. Sem o papel `api`, só health e métricas
respondem no HTTP.

**Pontos de falha injetáveis** (só com `NODE_ENV=test` e `FAULT_INJECTION=enabled`):
`consumer.afterReceive`, `uow.beforeCommit` (com o messageId da entrega),
`consumer.afterCommitBeforeAck`, `consumer.afterDeadLetterCommitBeforeSend`,
`consumer.dlqSendFails`, `consumer.afterDlqSendBeforeDelete`, `redrive.afterPendingBeforeSend`,
`redrive.afterSendBeforeMark`, `redrive.afterMarkBeforeDelete`, `outbox.afterClaimBeforePublish`,
`outbox.afterPublishBeforeMark`.

**Limitações da F5.**
- Sem promessa de cópia única na DLQ: fora da janela de deduplicação de 5 min, um descarte
  retomado pode deixar 2 cópias; cópias repetidas nunca geram efeito financeiro (inbox e
  Idempotency-Key).
- Uma mensagem que esgota o `maxReceiveCount` por erro transitório só chega à DLQ pela
  RedrivePolicy do broker, sem registro no PostgreSQL até o redrive.
- Purga por retenção, `outbox:republish` e métricas de lag: implementados na F6 (§17).

## 13. PENDING_REFERENCE e worker de pendências (F4)

**Agenda.** Toda pendência tem `pending_deadline_at = statement_timestamp() + TTL` gravado no
aceite (TTL de 30 min em produção, 3 s nos testes) e uma linha em `pending_reference_checks`
(`attempts`, `next_check_at`, claim com lease). A linha é apagada na mesma transação que
decide a pendência. Uma trigger diferida (`prc_coverage_ck`) exige agenda para toda pendência.

**Worker** (papel `pending-reference-worker`, ligado por padrão em todas as instâncias):

1. Claim em autocommit, `FOR UPDATE SKIP LOCKED`, com lease; não toca wallets.
2. Por wallet: lock da wallet, releitura das pendências sob o lock e `now()` do PostgreSQL.
3. Ordem de Kahn por `accept_seq`: uma referência é decidida antes dos dependentes dela.
4. Regra de prazo, só com instantes gravados no banco (D40):
   - prazo efetivo `eff(P)` = `pending_deadline_at(P)`, estendido pelo prazo da própria
     referência quando ela foi aceita dentro do prazo de P e também estava pendente (cadeia);
   - referência terminal com `available_at(R) ≤ eff(P)` → aplica a política, **mesmo que o
     worker rode depois do prazo**; `available_at(P) = max(accepted_at(P), available_at(R))`;
   - referência aceita até `eff(P)` e ainda pendente → P espera a avaliação de R, **mesmo com o
     prazo vencido**: `available_at(R)` nunca passa `eff(R) ≤ eff(P)`, então o desfecho de P é o
     da política sobre o de R. Se R é da mesma wallet e está fora do lote
     (`WORKER_BATCH_SIZE`), R entra no lote; a primeira pendência do lote nunca bloqueia a
     referência de que depende;
   - só uma dependência **válida** é esperada ou estende o prazo: se R tem escopo ou kind
     incompatível com P (linhas 6 e 7 da política, atributos imutáveis), nenhum desfecho de R
     torna a relação válida; P não espera R e, vencido o próprio prazo, é REJECTED com o código
     da relação (`INVALID_REFERENCE_KIND` ou `REFERENCE_SCOPE_MISMATCH`). Como toda aresta válida
     termina numa BET, isso também impede ciclos (dois ROLLBACKs que referenciam um ao outro);
   - prazo vencido sem isso → REJECTED `REFERENCE_NOT_FOUND` (referência ausente ou aceita
     depois do prazo) ou `REFERENCE_NOT_PROCESSED` (referência terminal disponível depois do
     prazo, só além da profundidade da cadeia); `available_at(P) = eff(P)`;
   - nos demais casos, reagenda com backoff limitado pelo prazo efetivo.
5. Uma referência que se torna terminal reagenda (nudge) os dependentes da mesma wallet.
6. Uma falha (por exemplo lock_timeout) libera o claim com `last_error` **sem** incrementar
   `attempts`; `attempts` nunca rejeita nada.

Os instantes da regra de prazo são lidos e comparados em microssegundos exatos, como o
PostgreSQL os grava (`extract(epoch …)`), e `available_at` é gravado a partir desse valor.
`Date` do JavaScript tem resolução de milissegundo; a primeira versão do worker usava `Date` e
o IT-26 (b) e o CT-07h mostraram `available_at` diferente do prazo por frações de milissegundo.

Correção posterior (IT-26 (g) / RV-IT-06): na cadeia ROLLBACK → REFUND → BET com o ROLLBACK
aceito primeiro, a BET disponível no prazo do REFUND e o worker começando depois do prazo
efetivo da cadeia, o worker rejeitava o ROLLBACK (`REFERENCE_NOT_PROCESSED`) antes de avaliar o
REFUND, que vinha depois na ordem de aceite. Agora a dependência pendente é avaliada antes de se
concluir que o prazo venceu; o teste cobre a cadeia com o lote padrão e com
`WORKER_BATCH_SIZE=1`, e a contraprova com a referência aceita de fato depois do prazo.

Correção seguinte (IT-26 (h)): dois ROLLBACKs que referenciam um ao outro ficavam pendentes para
sempre, porque cada um esperava o outro e o prazo se estendia pela cadeia. Agora uma dependência
inválida não é esperada nem estende o prazo; os dois terminam REJECTED
`INVALID_REFERENCE_KIND` na avaliação depois do prazo, sem lançamento nem mudança de saldo.

Testes: IT-26 (a)–(g) (referência dentro do prazo com worker atrasado, referência só depois
do prazo, cadeia, referência rejeitada, lock_timeout, 3 workers e 20 pendências, cadeia vencida
com lote 50 e lote 1, e dependência inválida em ciclo), IT-10b,
IT-07c (queda antes do commit do worker), RV-IT-03/06/07 e CT-07h, que inclui a corrida no
prazo com 3 instâncias e o desfecho previsto a partir dos instantes gravados no banco.

**Limitações da F4.** Pendências gravadas pela F3 recebem prazo `accepted_at + 30 min` na
migration (TTL de produção), qualquer que seja o TTL configurado. Não há caminho FAILED: um
erro inesperado no worker só libera o claim e a pendência é tentada de novo. Uma reversão
direta que chega entre o commit da referência e a execução do worker pode vencer uma
pendência mais antiga da mesma referência; o desfecho continua dentro de P1/P2.

## 15. Ambiente

**Tudo em contêineres Linux via Docker Compose.** O host precisa só de Docker e
Compose; Bun existe apenas dentro das imagens. Os comandos do README são iguais
no PowerShell e no bash.

| Peça | Escolha | Motivo |
|---|---|---|
| Runtime | `oven/bun:1.4.4-slim` fixado por digest | Bun 1.x exigido; digest evita deriva |
| PostgreSQL | `postgres:18.6-alpine3.24` por digest | Volume em `/var/lib/postgresql` (layout do PG 18) |
| SQS | MiniStack `1.5.40` por digest | Emulador sem conta, token ou credencial AWS. A LocalStack passou a exigir conta/licença em 23/03/2026 |
| LB | nginx `1.30.6-alpine` por digest | `resolve` no upstream; único serviço com porta publicada (`127.0.0.1:8080`) |

**Compose (`name: wagering`):**

- Stack: `postgres`, `ministack`, jobs one-shot `migrate` e `init-queues`,
  `app-1..3` e `nginx`. As apps só sobem depois de `service_completed_successfully` dos jobs.
- `migrate` é idempotente: cria roles (`wagering_owner` dono do banco,
  `wagering_app` sem posse de objetos), transfere a posse do banco, revoga
  `CONNECT` de `PUBLIC` e aplica migrations sob `pg_advisory_lock`. Migrations
  aplicadas têm checksum: editar uma migration já aplicada faz o job falhar.
  Nunca há `down` automático.
- `init-queues` cria ou converge atributos das filas; nunca faz purge nem delete.
- Perfil `test`: `postgres-test` (tmpfs) e `ministack-test` (sem persistência)
  e o contêiner `tests`, que depende **só** deles. Os testes não tocam os dados da aplicação.
- Perfil `persist-check`: um MiniStack isolado para os runbooks de persistência (V9a/V9b).

**Dockerfile multi-stage.** `deps-prod`/`deps-dev` com `bun install
--frozen-lockfile --ignore-scripts`; `runtime` com `NODE_ENV=production`,
usuário `bun` e um `boot-check` no build que importa todo o grafo de `src/`
(pega dependência de desenvolvimento usada em produção, junto com QG-07);
`test`; e `lockfile`/`lockfile-export`, que geram o `bun.lock` sem Bun no host.

**Testes em processos reais (harness).** O contêiner `tests` sobe instâncias da
app com `Bun.spawn`, cada uma com porta e ambiente próprios, drena stdout/stderr
para um LogBook JSON e registra cada sinal que ele mesmo envia. Em modo teste a
instância sai quando o stdin fecha, então a morte do runner não deixa órfãos.
Não há acesso ao `docker.sock`.

**Injeção de falhas com guarda dupla.** O injetor real só existe com
`NODE_ENV=test` **e** `FAULT_INJECTION=enabled`; fora de teste, a presença de
qualquer `FAULT_*` aborta o boot. Antes de agir, o injetor grava o marcador
`fault.injected` com escrita síncrona no stdout. Uma queda só conta como
provocada quando há marcador, `signalCode=SIGKILL`, `exitCode=null` e nenhum
kill registrado pelo harness (IT-32).

**Encerramento.** `ShutdownCoordinator` único: readiness 503 → (atraso de
drenagem) → `app.close()` → fechamento das conexões → exit 0, com watchdog que
força exit 1 no limite. Tabela de tempos validada no boot:
`Wait*1000 < drain < hard`.

**Pipeline de testes (`scripts/test-all.ts`).** Preflight (roles, banco-template
migrado, SQS pronto) → `static` (tsc, eslint, varredura de CR, testes de
arquitetura) → `conformance` → `unit` → `integration` → `concurrency` →
`resilience` → meta-check. Roda todas as etapas mesmo após uma falha. O
meta-check classifica cada ID do catálogo (`test/meta/required.ts`) como PASS,
FAIL, NOT IMPLEMENTED, SKIPPED ou BLOCKED; **NOT IMPLEMENTED nunca conta como
aprovado**. Isolamento por banco `wt_<runId>_*` e filas `t-<runId>-*`, com guarda
por regex antes de qualquer remoção.

## 16. Limitações do emulador SQS (MiniStack)

A conformidade é verificada por `test/conformance/sqs` (CONF-00..21). O perfil
em `test/conformance/sqs/profile.ts` classifica cada caso; uma falha de
pré-requisito [P] marca como BLOCKED os testes que dependem dele.

| Caso | Classe | Comportamento esperado | Confirmado? |
|---|---|---|---|
| CONF-12 | [D] | DeleteMessage com receipt handle antigo retorna erro | Sim (`ReceiptHandleIsInvalid`) |
| CONF-13 | [P] | A mensagem vai para a DLQ após maxReceiveCount | Sim; o momento exato da movimentação (preguiçosa ou não) não foi isolado |
| CONF-18 | [P] | Long poll de cliente morto termina em ≤ Wait; Wait de teste (1 s) < VT e drain | Sim: após Wait + 0,5 s nenhuma captura órfã |
| CONF-19 | [N] | VisibilityTimeout fora da faixa é rejeitado (`InvalidAttributeValue`), como na AWS | Sim, run iisdoi0x (a expectativa inicial estava errada e foi recalibrada) |
| CONF-20 | [D] | PurgeQueue é imediato e repetível | Sim |
| CONF-21 | [D] | MessageDeduplicationId acima de 128 caracteres não é rejeitado | Sim: o limite precisa ser garantido pela app (UT-14) |
| CONF-00 | [P] | Health responde 200 | Sim; o health **não expõe a versão**, que fica garantida só pelo digest fixado no compose |
| nenhum | nenhuma | Sem `StartMessageMoveTask`; sem métricas CloudWatch | Leitura do código, não executado |

**Persistência (observada em 2026-11-13 nos runbooks V9a e V9b, contra o serviço isolado
`ministack-persist` do profile `persist-check`, nunca contra o emulador da aplicação).** Com
`PERSIST_STATE=1` o estado do SQS é gravado só no encerramento normal do emulador.

| Runbook | O que aconteceu | Observado |
|---|---|---|
| V9a: reinício normal (`docker compose restart`) | log `Persistence: saved sqs state` no encerramento e `loaded sqs state` na subida | filas e atributos (VT 600, RedrivePolicy), as 3 mensagens, a mensagem em voo continuou em voo, receive count preservado e cache de deduplicação preservado (a sonda com o mesmo id foi descartada: contagem 3 → 3) |
| V9b: queda abrupta (`kill -s SIGKILL`) | nenhuma linha `saved`; na subida, `loaded` do snapshot anterior | as filas e mensagens criadas depois do último encerramento normal sumiram por completo; o estado anterior voltou como estava no snapshot (snapshot antigo restaurado) |

- **A persistência do MiniStack não está comprovada para queda abrupta**: na queda observada, tudo
  desde o último encerramento normal foi perdido e um snapshot antigo voltou (mensagens já apagadas
  podem reaparecer; a inbox e o eventId absorvem a reentrega). Sem fsync, uma queda de energia pode
  perder ou corromper o snapshot.
- **A recuperação de eventos publicados é manual (`outbox:republish`) e limitada ao que permanecer
  na outbox** (eventos ainda não publicados sempre; publicados enquanto ainda estiverem na tabela,
  isto é, até `RETENTION_OUTBOX_DAYS` dias depois da publicação, padrão 7).
- **O reenvio de entradas perdidas depende do produtor e não é automático.**

Decisão: a stack usa `PERSIST_STATE=1` com volume, tratado como best-effort (um snapshot antigo só
gera reentregas, que a inbox absorve); os testes automatizados usam um emulador efêmero
(`ministack-test`).

## 17. Observabilidade, retenção e recuperação (F6)

**Logs (§12, D41).** JSON no stdout (pino), uma linha por evento, sempre com `instance`, `roles`,
`time` e o contexto de correlação do AsyncLocalStorage: `correlationId`, `causationId`, `messageId`
(entregas SQS), `transactionId`, `walletId` e `providerId` quando existem. Nunca payload financeiro,
valores, nem playerId (redact + allowlist). O IT-31 confere com valores sentinela que nenhuma linha
traz o playerId nem as quantias usadas.

**Métricas (§12, D42)** em `/metrics` (bloqueado no nginx), com labels de cardinalidade fechada:

| Métrica | Tipo | Labels |
|---|---|---|
| `wagering_transactions_total` | counter | kind, status, channel (http, sqs) |
| `wagering_rejections_total` | counter | failure_code, channel |
| `wagering_processing_duration_seconds` | histogram | channel, outcome |
| `idempotency_duplicates_total` | counter | source, outcome (replay, conflict) |
| `db_lock_conflicts_total` / `uow_retries_total` | counter | reason (serialization, deadlock, lock_timeout) |
| `sqs_messages_total` / `sqs_redeliveries_total` | counter | queue, result |
| `dlq_messages_total` | counter | reason |
| `outbox_publish_lag_seconds` | histogram | nenhum (mede do commit ao aceite da fila) |
| `pending_reference_resolutions_total` | counter | outcome, reason |
| `wallet_reconciliation_divergence_total` | counter | issue |
| `http_request_duration_seconds` | histogram | method, route (ids viram `:id`), status |
| `outbox_pending_messages`, `outbox_oldest_pending_age_seconds`, `pending_reference_backlog` | gauge | nenhum |
| `sqs_queue_messages` | gauge | queue, state (visible, not_visible, delayed) |

Os gauges são do sistema inteiro, calculados no scrape (todas as instâncias leem o mesmo banco e as
mesmas filas: agregue com `max`); cada gauge do grupo aguarda a mesma coleta, e uma fonte fora do ar
deixa só o seu gauge sem valor naquele scrape.

**Retenção (D18, D38).** Inbox processada há mais de `RETENTION_INBOX_DAYS` dias (padrão 30) e outbox
**publicada** há mais de `RETENTION_OUTBOX_DAYS` dias (padrão 7, configurável) saem pela função `wagering_purge_retention` (migration 0004, SECURITY DEFINER), que o papel
`outbox-publisher` chama a cada `RETENTION_INTERVAL_MS` (1 h) e que também roda por
`bun run retention:purge`. A função recusa prazos menores (`RETENTION_INBOX_DAYS` ≥ 30,
`RETENTION_OUTBOX_DAYS` ≥ 7), nunca apaga evento à espera de publicação, não toca tabelas
financeiras e roda uma de cada vez (advisory lock). O role da app continua sem DELETE nessas
tabelas; a guarda da inbox só aceita DELETE dentro da função. Apagar a inbox depois de 30 dias não
reabre duplicatas: a retenção da fila é de 14 dias, e uma operação repetida ainda cai na
Idempotency-Key, que nunca é apagada.

**Republicação (`outbox:republish`, D38).** Manual: um operador roda
`bun run outbox:republish --since <ISO> [--until <ISO>] [--aggregate <walletId>] [--event <eventId>]`.
Reenvia eventos **já publicados** que ainda estão na outbox. Até quando dá para recuperar:

| Evento | Recuperável |
|---|---|
| Ainda não publicado | sempre (o publicador continua tentando; nunca é apagado) |
| Publicado e ainda na tabela (por padrão, até 7 dias depois da publicação) | sim, pelo `outbox:republish` |
| Publicado há mais de `RETENTION_OUTBOX_DAYS` dias e já purgado | não: a linha não existe mais (o IT-27b confere que o republish não a encontra) |

O prazo de 7 dias é o **padrão configurável** (`RETENTION_OUTBOX_DAYS`, mínimo 7, imposto também pelo
banco). A republicação manual alcança exatamente os eventos publicados que ainda estiverem na tabela
`outbox_messages`; aumentar o prazo aumenta a janela de recuperação (e o tamanho da tabela).

O eventId (no corpo) nunca muda: os consumidores deduplicam por ele. O MessageDeduplicationId é
`rp:<eventId>:<runId>`, com runId novo por execução: o FIFO não descarta o reenvio, nem dentro da
janela de 5 min da publicação original, e as tentativas da mesma execução repetem o mesmo id. Reusar
o eventId como DedupId é proibido: dentro da janela o SendMessage responde sucesso e a mensagem não
é entregue (o IT-27b demonstra isso pela projeção).

**Projeção de referência (`events-projection`, D39).** Consome a fila de eventos, deduplica por
eventId (inbox do consumidor `wallet-events-projection`) e projeta saldo e versão por wallet só para
versão maior. Fica fora dos papéis padrão e do compose: numa fila SQS cada mensagem vai para um
consumidor só, e a projeção não pode competir com os consumidores reais da fila de eventos. Os
testes a ligam explicitamente para provar a recuperação pelo lado de quem consome.

**Indisponibilidade (IT-24).** PostgreSQL fora: o HTTP responde 503 `DATABASE_UNAVAILABLE`
retentável, ready 503, e o consumidor abre um breaker (`CONSUMER_BREAKER_OPEN_MS`) que suspende a
recepção sem ack; ao voltar, cada operação é decidida uma vez. SQS fora: o caminho financeiro segue
(o HTTP não depende da fila), ready 503 e a outbox acumula; ao voltar, a outbox drena.

**Reinício (IT-27, CT-08).** Outbox pendente, pendências e mensagens em voo sobrevivem a SIGKILL e
são concluídas pela instância seguinte. Com as três instâncias derrubadas juntas (SIGKILL e, na
variante, SIGTERM) sob carga HTTP + SQS, o sistema converge: cada operação decidida uma vez, outbox
publicada, nenhuma pendência esquecida, reconciliação consistente e verificador global sem violação.

**Perda do broker (IT-27b e runbooks V9).** Testada contra o MiniStack de teste (isolado da
aplicação), com PurgeQueue liberado só para filas de teste. Eventos publicados e perdidos voltam pelo
`outbox:republish` e a projeção aplica cada um uma vez. Entradas perdidas antes do consumo não criam
transação; o reenvio continua dependendo do produtor.

---

## 18–19. Testes, rastreabilidade, trade-offs e limitações (F7)

**Testes e rastreabilidade.** A matriz requisito → decisão → teste está em
[docs/traceability.md](docs/traceability.md). O catálogo (`test/meta/required.ts`) tem 133 IDs: 132
obrigatórios e um informativo (SPK-01, o spike de MikroORM 7 + ALS + pg no Bun, `required: false`).
A suíte completa (`docker compose run --rm --build tests`, sem `--phase`) só sai com 0 quando os 132
obrigatórios estão em PASS e nenhuma etapa falha. Na execução d4kexx29, feita em cópia limpa, os 133
ficaram em PASS, e a execução ixbxe23v repetiu o resultado num clone Git real do histórico. Os
testes usam PostgreSQL e MiniStack reais, processos reais da app (até 3 instâncias), contenção
comprovada em `pg_stat_activity`, quedas comprovadas por cinco evidências (D47) e um verificador
SQL independente da app depois de cada arquivo.

**Trade-offs aceitos.**
- Hot wallet: todas as operações de uma wallet passam pelo lock dela; a vazão por wallet é limitada
  pela duração da transação (CT-13 mede a fila do pool e o 503 retentável).
- Triggers e checagens diferidas custam escrita, em troca de o banco recusar estados inválidos mesmo
  sem a aplicação.
- FIFO por wallet: uma mensagem lenta segura o grupo dela (head-of-line); grupos diferentes seguem.
- Readiness exige o SQS: com o SQS fora, `/health/ready` devolve 503, mas as rotas HTTP da API
  continuam respondendo, porque só dependem do PostgreSQL. O Compose
  ([`docker-compose.yml`](docker-compose.yml)) só inicia o nginx depois que `app-1..3` ficam
  saudáveis (healthcheck com live e ready em 200).
  Durante a execução, o nginx não consulta o `/health/ready`: usa a detecção passiva de falhas nas
  requisições ([`infra/nginx/nginx.conf`](infra/nginx/nginx.conf): `max_fails=1 fail_timeout=5s` e
  `proxy_next_upstream error timeout http_503`). Após uma falha contabilizada, o nginx pode deixar
  de encaminhar requisições à instância por 5 s.
- Broker volátil: o emulador não garante persistência em queda abrupta (§16); a recuperação de
  eventos é manual e limitada à outbox, e entradas perdidas dependem do produtor.
- A projeção de referência fica desligada na stack para não competir com consumidores reais.

**Limitações conhecidas.**
- Autenticação é um ponto de extensão no-op (U1; funcionamento atual em §6, 10 e 14). O IdP externo
  é a F8, opcional e não iniciada; o desenho-alvo é Keycloak com client_credentials por provedor,
  JWT RS256 validado via JWKS e claim `provider_id` igual ao `providerId` do payload
  (`PROVIDER_IDENTITY_MISMATCH`).
- Sem teste de carga (`test:load`, P2 opcional).
- Validado em Windows 11 + Docker Desktop/WSL 2 (PowerShell 7). PowerShell 5.1 e Linux nativo não
  foram executados.
