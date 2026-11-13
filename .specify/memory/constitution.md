<!--
Sync Impact Report (rascunho de revisão; remover antes de commitar)
- Versão: 0.3.0 → 0.3.1 (proposta ainda NÃO aprovada; ajuste pontual do Princípio XIII)
- Motivo do PATCH: esclarecimentos que estreitam redação ampla demais, sem princípio ou seção
  nova. Tudo o que cumpria a 0.3.0 continua cumprindo a 0.3.1.
- Princípio modificado: XIII. Clareza de nomes e segurança de tipos (título mantido)
  - falsos cognatos: a palavra não é proibida; é proibido usá-la com sentido inadequado ao
    contexto (`actualBalance` = saldo real × previsto; `currentBalance` = saldo atual)
  - afirmações de tipo: a regra não alcança `as const`, `as` de apelido em imports/exports nem
    a negação lógica `!valor`
  - item novo "Dados recuperados do banco (§6.0)": `rehydrate` não revalida transições; leitura
    valida só formato e conversão
- Prevalência (enunciado → constituição → estilo) e decisões I1, I2, P1, P2: inalteradas
- Revisão anterior (0.2.0 → 0.3.0), mantida: princípio XIII e regra de prevalência na
  Governance. Nenhum princípio foi removido nem teve requisito do enunciado enfraquecido.
- Princípio adicionado: XIII. Clareza de nomes e segurança de tipos (escolhas do projeto:
  nomes completos, termos em inglês familiares ao português com cuidado com falsos cognatos,
  preservação de nomes do enunciado e de contratos, segurança de tipos, Prettier e SonarJS)
- Seções modificadas: Governance (ordem de prevalência: enunciado → constituição → escolhas de
  estilo); "Retrato do andamento" (Prettier/SonarJS não configurados; conformidade não auditada)
- Histórico desta proposta: 0.1.0 (primeira proposta) → 0.2.0 (rótulos, IDs de teste, fases,
  governança de rascunho) → 0.3.0 (princípio XIII) → 0.3.1 (este ajuste)
- Mudanças da revisão anterior (0.1.0 → 0.2.0), mantidas, com títulos preservados:
  I. Precisão monetária: BRL/USD como escolha atual, não exigência; fase dos testes
  II. Wallet e ledger auditável: alcance da reconciliação explicitado
  III. PostgreSQL como autoridade: limitação de usuário privilegiado sem promessa de detecção
  IV. Concorrência: lock por wallet como "previsto no plano", não confirmado; IDs exatos
      (IT-08 na F2; CT-01h/CT-02h/CT-04h na F3; CT-01s/CT-02s/CT-04s na F5)
  V. Idempotência: key no header (HTTP) e em data.idempotencyKey (SQS); I2 global; IT-10a/IT-10b
  VI. Regras e reversões: famílias RV-IT, RV-CT, P2-T identificadas como famílias; IT-26 na F4
  VII. Mensageria: não perder eventos confirmados (§3) sem declarar comprovado; MoneyProps só nos
       campos monetários de data; MiniStack como escolha atual; IT-24 e IT-27b na F6
  VIII–XII: rótulos e fases dos testes; MiniStack/monólito como escolhas atuais;
       autenticação como previsto no plano
- Seções adicionadas: "Retrato do andamento (data desta proposta: 2026-11-12)"
- Seções modificadas: introdução (rótulos); "Execução em Docker e entrega" (rótulo);
  "Fluxo de desenvolvimento e quality gates" (--phase F0–F7, F8 opcional, gate ≠ autorização);
  "Interpretações adotadas e decisões pendentes" (nota sobre decisões futuras); Governance
- Seções removidas: nenhuma (os blocos "Estado atual" dos princípios foram movidos para o
  retrato do andamento)
- Modelos dependentes (.specify/templates/*.md): ✅ sem alteração; leem a constituição em
  tempo de execução
- TODOs adiados: RATIFICATION_DATE (proposta ainda não aprovada pelo responsável)
-->

# Distributed Wagering Processor Constitution

Proposta de constituição do projeto. A fonte normativa é o enunciado preservado em
`docs/CHALLENGE.md` (citado como §n). Esta constituição não o substitui: organiza o que ele
exige, registra as interpretações já adotadas e torna visíveis as decisões ainda abertas.

Cada princípio separa:

- **Enunciado (§n):** requisito expresso no desafio.
- **Interpretação decidida:** leitura do enunciado decidida pelo responsável (hoje, só I2).
- **Escolha atual do projeto:** escolha técnica já adotada e documentada em `ARCHITECTURE.md`;
  não é exigência literal do desafio e pode mudar por revisão desta proposta ou, depois da
  ratificação, por emenda.
- **Previsto no plano:** direção do plano de implementação para fases futuras; ainda não
  implementada nem confirmada como regra constitucional.
- **Opcional:** previsto pelo enunciado como diferencial ou escolha livre.
- **Pendente:** decisão do responsável ainda não tomada; nenhum artefato pode tratá-la como
  resolvida.
- **Verificação:** IDs exatos do catálogo de testes em `test/meta/required.ts`, com a fase em que
  cada um entra; quando o texto cita uma família de testes (por exemplo "família RV-UT"), isso
  está indicado como família.

Os princípios descrevem obrigações duradouras. O andamento das fases está em uma seção própria,
"Retrato do andamento", que reflete a data desta proposta; o estado atual deve ser consultado em
`ARCHITECTURE.md`.

## Core Principles

### I. Precisão monetária

- **Enunciado (§5 item 1, §6.1, §14 falhas eliminatórias):** dinheiro MUST NOT usar `number`,
  `float` ou `double`. `Money` MUST ser imutável; `amount` MUST ser recebido e serializado como
  string decimal com escala fixa 2; entradas `NaN`, `Infinity`, notação científica, string vazia,
  mais de 2 casas e valores negativos em contratos de entrada MUST ser rejeitadas; operações entre
  moedas diferentes MUST lançar erro de domínio; o domínio MUST NOT depender de tipos monetários
  do ORM nem de decorators do NestJS; a persistência MUST ser exata e reidratada como `Money`.
  O modelo MUST continuar multi-moeda, ainda que o desafio possa assumir só `BRL`, e conflitos de
  moeda MUST ser testados.
- **Escolha atual do projeto:** valor em unidades mínimas (`bigint`), nenhum arredondamento
  (entrada com mais de 2 casas é recusada, não arredondada); limite único `999999999999999.99`,
  o mesmo no DOMAIN SQL `money_amount`; moedas aceitas hoje: `BRL` e `USD` (USD existe para os
  testes de conflito; a lista não é exigência do desafio).
- **Verificação:** UT-01, UT-02 (F1: escala, arredondamento, entradas inválidas, conflito de
  moeda); QG-02 (F1: lint proíbe `parseFloat`, `toFixed`, `Math.round` e campos monetários
  `number`); IT-06 (F2: ida e volta exata pelo driver e pelo ORM).

### II. Wallet e ledger auditável

- **Enunciado (§6.2, §6.4, §7 regra 6, §9 criar wallet e reconciliação, §13 invariante final):**
  no máximo uma wallet por `playerId` + `currency`; saldo nunca negativo; toda alteração de saldo
  MUST ter exatamente um lançamento correspondente no ledger e vice-versa; `version` MUST iniciar
  em 1 e subir somente quando o saldo muda; lançamentos MUST ser estruturalmente imutáveis, com
  aritmética `balanceBefore ± money = balanceAfter` validada; no máximo um lançamento por wallet
  por transação; `LOSS` e transações `REJECTED` MUST NOT gerar lançamento; saldo inicial > 0 MUST
  gerar a transação interna `OPENING` e o `CREDIT` na mesma transação SQL; wallet duplicada é
  conflito; a reconciliação MUST registrar divergências em log e métrica e sinalizá-las na
  resposta, nunca corrigi-las silenciosamente. Em todo teste,
  `wallet.balance == saldo reconstruído pelo ledger`.
- **Opcional (§6.4):** ledger de partidas dobradas.
- **Escolha atual do projeto:** o ledger é ordenado por `wallet_version`; wallet aberta com
  `0.00` começa sem lançamento (estado v1); paginação do ledger por cursor opaco em keyset.
- **Alcance da reconciliação:** ela detecta as divergências que suas verificações cobrem (saldo ×
  Σ ledger, saldo e versão × último lançamento, quebra na cadeia de lançamentos, lançamento sem
  transação com efeito e transação com efeito sem lançamento). Ela MUST NOT ser apresentada como
  detector de toda alteração indevida: um usuário privilegiado do banco pode, por exemplo,
  alterar de forma coerente saldo e ledger ao mesmo tempo, e isso não aparece como divergência.
- **Verificação:** UT-03, UT-06, UT-11 (F1; UT-11 é a propriedade saldo = Σ ledger); IT-05,
  IT-09, IT-16, IT-17 (F2).

### III. PostgreSQL como autoridade das invariantes

- **Enunciado (§5 itens 5 e 9, §4, §8):** unicidade, imutabilidade e não-negatividade da §6 MUST
  ser aplicadas no schema do banco, não só no código; lançamentos do ledger MUST NOT ser
  sobrescritos nem excluídos; migrations MUST ser versionadas e reversíveis; ordenação e
  deduplicação do broker são otimização e o banco continua responsável pelas invariantes.
- **Escolha atual do projeto:** constraints e índices com nome; triggers de guarda (ledger
  imutável, versão que só sobe com mudança de saldo, transação terminal imutável); checagens
  diferidas no COMMIT ligando saldo, ledger e transação; o role da aplicação não é dono do schema
  e não tem `DELETE`/`TRUNCATE`; migrations escritas em SQL com checksum (migration aplicada e
  editada falha o job).
- **Limitação conhecida:** o dono do schema ou um superusuário podem desligar triggers e gravar
  estados que o schema normalmente recusa. A reconciliação detecta apenas as divergências que
  suas verificações cobrem (Princípio II), não toda alteração feita com esse privilégio.
- **Verificação:** IT-01a (F0); QG-04, IT-01b, IT-02 (up → down → up), IT-03 (matriz de
  constraints), IT-04 (imutabilidade em duas camadas), IT-05 (F2).

### IV. Concorrência por wallet e múltiplas instâncias

- **Enunciado (§5 itens 6, 7 e 8, §8, §13 concorrência):** a unidade de concorrência MUST ser a
  `walletId`; MUST NOT existir lock global compartilhado por todas as wallets; saldo MUST NOT ser
  `read → calculate → update` sem controle de concorrência; a solução MUST permanecer correta com
  três ou mais instâncias simultâneas, wallets distintas em paralelo e disputa pelo mesmo saldo.
  No cenário obrigatório (100.00 BRL e duas apostas simultâneas de 80.00 BRL): exatamente uma
  `PROCESSED`, uma `REJECTED` por saldo insuficiente, saldo final 20.00 BRL, um único débito, e
  nenhum retry duplica o débito. A estratégia MUST ser justificada em `ARCHITECTURE.md`.
- **Previsto no plano (não confirmado como regra constitucional; implementação prevista para a
  F3):** lock pessimista por wallet (`SELECT … FOR UPDATE` em READ COMMITTED) com `UPDATE`
  condicionado à versão esperada e constraints como última barreira; ordem fixa de aquisição de
  locks; timeouts de lock e de instrução por transação. Qualquer que seja a estratégia final,
  os requisitos do Enunciado acima continuam obrigatórios.
- **Escolha atual do projeto:** na criação de wallets, o índice único decide a disputa entre
  instâncias pelo mesmo `playerId` + `currency`.
- **Verificação:** IT-08 (F2: Unit of Work com conexão única) e IT-09 (F2: criações paralelas
  em 3 instâncias); CT-01h, CT-02h, CT-03, CT-04h, CT-09, CT-10, CT-12, CT-13 (F3, via HTTP);
  CT-07h, CT-11h (F4); CT-01s, CT-02s, CT-04s, CT-07s, CT-11s (F5, via SQS); CT-08 (F6).

### V. Idempotência persistente

- **Enunciado (§5 item 2, §6.3, §7 regra 7, §9 idempotência, §10, §13):** idempotência MUST NOT
  depender de cache em memória; no HTTP, a key vem do header `Idempotency-Key`, que é obrigatório
  e é a fonte da verdade; no SQS, a key vem de `data.idempotencyKey` da mensagem;
  `payloadHash` MUST ser o hash de um JSON canônico do subconjunto de campos de negócio, sem o
  header e sem metadados de transporte, com algoritmo documentado; requisição idêntica MUST
  devolver a mesma resposta com `idempotentReplay: true`; a mesma key com payload diferente MUST
  ser conflito, não replay; repetir uma operação processada MUST devolver o resultado original,
  inclusive o saldo observado naquele momento; o consumidor SQS MUST deduplicar por inbox
  persistente em `(consumerName, messageId)`.
- **Interpretação decidida (I2, leitura do §9 pelo responsável; não é texto literal do
  enunciado):** a key é **global**, venha do header HTTP ou de `data.idempotencyKey`, e é
  comparada byte a byte, sem normalização; o formato `{providerId}:{externalTransactionId}` é
  recomendado, não obrigatório; a mesma key com payload diferente é conflito inclusive entre
  provedores, e a resposta de conflito MUST NOT revelar dados da transação alheia.
- **Escolha atual do projeto:** `(providerId, externalTransactionId)` também é único;
  `payloadHash` = `v1:` + SHA-256 do JSON canônico (chaves ordenadas, `null` equivalente a
  ausente, UUIDs em minúsculas).
- **Pendente (I1):** o que o replay devolve quando a primeira resposta foi `202` (pendente de
  referência). Nenhuma das leituras pode ser tratada como regra até a decisão.
- **Verificação:** UT-07, UT-10 (F1); IT-03 (F2: unicidade global e byte a byte no schema, sem
  passar pela API); IT-10a e CT-01h (F3, via HTTP); IT-10b (F4, depende de I1); IT-14, IT-20 e
  CT-01s (F5, via SQS).

### VI. Regras de transação, reversões e referências fora de ordem

- **Enunciado (§6.3, §7, §7.1, §7.2):** `OPENING` é interno e MUST NOT ser aceito pela API nem
  pela fila; `PROCESSED`, `REJECTED` e `FAILED` são terminais e transicioná-los é erro de
  programação; as transições válidas MUST ser documentadas. Valem as regras 1 a 9 do §7:
  referência obrigatória em `REFUND`/`ROLLBACK`; referência no mesmo provider, player, wallet,
  moeda e rodada; `REFUND` só referencia `BET` e `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`;
  sem dupla reversão pelo mesmo tipo; valor igual ao da referência; `REJECTED` não move saldo;
  replay devolve o resultado original; referência ausente → `PENDING_REFERENCE`; reversão que
  negativaria o saldo é rejeitada com `failureCode` distinto do de aposta sem saldo. Pendências
  MUST ser reprocessadas por worker agendado com backoff exponencial e limite (tentativas ou TTL)
  justificado; esgotado o limite → `REJECTED` com código que identifique a referência inexistente
  e evento publicado. Toda rejeição MUST carregar `failureCode` estável, legível por máquina e
  documentado. Interpretações adicionais MUST ser documentadas.
- **Escolha atual do projeto:** catálogo único de códigos (`src/shared/error-catalog.ts`) com
  status HTTP, persistência, `retryable`, ação na fila e ação esperada do provedor; `gameId` não
  entra no escopo da referência (o §7 regra 2 lista cinco atributos).
- **Previsto no plano:** limite das pendências por TTL, com valor e justificativa a registrar em
  `ARCHITECTURE.md` na F4.
- **Pendente (P1):** se `REFUND` e `ROLLBACK` diretos podem coexistir sobre a mesma `BET` e como
  ler "uma única vez" (§7 tabela × regra 4 × §3).
- **Pendente (P2):** `WIN`/`LOSS` sobre `BET` revertida e reversão de `BET` já premiada.
- **Regra até a decisão de P1/P2:** casos que dependem delas MUST falhar de forma explícita
  (`ReversalRuleUndecidedError`), nunca escolher um desfecho em silêncio.
- **Verificação:** UT-04, UT-05a, UT-09, RV-UT-02a (F1); IT-26 (F4: worker e regra de prazo).
  Dependentes de P1/P2, na F4 e só depois das decisões: UT-05b, RV-UT-01, RV-UT-02b, RV-UT-03,
  a família RV-IT (RV-IT-01 a RV-IT-07), a família RV-CT (RV-CT-01 a RV-CT-04) e a família P2-T
  (P2-T1 a P2-T5, só os casos da opção escolhida).

### VII. Mensageria at-least-once e outbox transacional

- **Enunciado (§3, §5 itens 3 e 4, §6.5, §10, §11):** a entrega é at-least-once (duplicação,
  desordem, morte antes ou depois do commit, publicação repetida); o sistema MUST NOT perder
  eventos confirmados (§3, invariantes globais); SQS FIFO MUST NOT ser a única
  garantia de consistência; eventos MUST NOT ser publicados antes do commit; inbox, alteração
  financeira, ledger e outbox MUST participar da mesma transação SQL. O consumidor MUST reutilizar
  o mesmo use case da entrada HTTP, fazer ack somente após o commit, distinguir erros de negócio
  (ack), transitórios (retry com backoff) e permanentes (DLQ), respeitar limite de tentativas
  antes da DLQ, concluir ou devolver a visibilidade em `SIGTERM` e suportar redelivery sem efeito
  duplicado. O publisher da outbox MUST funcionar com múltiplos publishers concorrentes sem perder
  nem duplicar indefinidamente, inclusive se o processo morrer após o commit e antes de publicar.
  Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`,
  `WalletBalanceChanged` (somente quando o saldo muda) e `WagerTransactionPendingReference`, com
  envelope em classe abstrata e `eventType` e `version` no tipo; em `data`, os campos monetários
  usam `MoneyProps` (string decimal), nunca a instância de `Money`, e o payload é JSON estável e
  versionável.
- **Escolha atual do projeto:** emulador SQS MiniStack (o §4 aceita LocalStack ou MiniStack). As
  limitações conhecidas do emulador, inclusive a persistência não comprovada em queda abrupta,
  estão em `ARCHITECTURE.md` §16; por isso eventos confirmados ficam na outbox do PostgreSQL, que
  é a fonte para republicação.
- **Ainda não comprovado:** a garantia de não perder eventos confirmados depende do publisher e
  da recuperação das fases F5 e F6; nenhum teste executado até a data desta proposta a comprova.
- **Verificação:** UT-06 (F1); IT-07a, IT-09 (F2: eventos gravados na outbox na mesma
  transação); IT-14, IT-20, IT-21, IT-22, IT-23, IT-25, IT-28, CT-05, CT-06 e a família IT-21b..j
  (F5); IT-24, IT-27, IT-27b (F6: indisponibilidade, reinício e republicação).

### VIII. Falhas e respostas distinguíveis

- **Enunciado (§3, §9 status HTTP, §13 concorrência itens 5 e 8):** PostgreSQL e SQS podem ficar
  temporariamente indisponíveis e o processo pode morrer a qualquer momento; a API MUST
  distinguir, de forma consistente entre endpoints, payload inválido, conflito de idempotência,
  rejeição de negócio, aceite com processamento pendente e falha transitória de infraestrutura.
- **Escolha atual do projeto:** erros em `application/problem+json` com `code` do catálogo,
  `retryable` verdadeiro somente em `503` e `correlationId`; a injeção de falhas para testes só
  existe com `NODE_ENV=test` e `FAULT_INJECTION=enabled`, e uma queda só conta como comprovada com
  marcador, sinal de término e estado do banco registrados.
- **Verificação:** IT-32 (F0); QG-06 (F1); IT-07a, IT-19 (F2); IT-13 (F3); CT-05 (F5); IT-24,
  IT-27, CT-08 (F6).

### IX. Testes reais e honestos

- **Enunciado (§13, §14 falhas eliminatórias):** testes de unidade de `Money`, `Wallet`, regras
  de cada kind, conflito de moeda e key com payload divergente; integração com PostgreSQL e
  LocalStack/MiniStack reais em containers; concorrência com paralelismo real (itens 1 a 8 do
  §13); a invariante final vale em todos os testes; testes MUST NOT substituir completamente
  PostgreSQL e SQS por mocks.
- **Escolha atual do projeto:** catálogo de IDs obrigatórios com meta-check (PASS, FAIL, NOT
  IMPLEMENTED, SKIPPED, BLOCKED); `NOT IMPLEMENTED` MUST NOT contar como aprovado; oráculos de
  teste são valores fixos ou modelos que não importam código de produção; teste não executado
  MUST NOT ser relatado como aprovado; resultados registrados com sistema, shell e versões reais.
- **Verificação:** QG-08 (F1: meta-check e independência dos oráculos); `--phase Fn` com exit 0
  por fase (F0 a F7); suíte completa estrita (sem `--phase`) somente no fechamento (F7).

### X. Observabilidade

- **Enunciado (§12, §9 health checks):** logs estruturados em JSON com `correlationId`,
  `messageId`, `transactionId`, `walletId` e `providerId`; logs MUST NOT conter dados sensíveis
  nem payloads financeiros completos; métricas de transações por status, duplicatas, retries,
  mensagens em DLQ, conflitos de lock, outbox lag e latência; liveness e readiness separados,
  sem autenticação, com readiness dependente de PostgreSQL e SQS.
- **Opcional (§12):** OpenTelemetry e dashboard.
- **Verificação:** IT-17 (F2: log e métrica de divergência de reconciliação); IT-18 (F3:
  health); IT-31 (F6: logs e `/metrics`).

### XI. Arquitetura e modelagem

- **Enunciado (§4, §6.0, §6.1, §14 modelagem):** stack Bun 1.x, TypeScript estrito, NestJS,
  PostgreSQL, SQS via LocalStack ou MiniStack, Docker Compose; ORM MikroORM (preferencial) ou
  TypeORM, sem Prisma ou outros; construtores privados com factories estáticas e `rehydrate` que
  não revalida transições; invariantes encapsuladas em classes; a escolha do ORM, o mapeamento do
  `Money` e a estratégia transacional MUST ser justificados em `ARCHITECTURE.md`.
- **Escolha atual do projeto (não exigida pelo desafio):** monólito modular com módulos
  hexagonais; MikroORM 7 com Unit of Work por caso de uso e SQL explícito no caminho financeiro;
  código de `domain/`, `application/` e `src/shared/` não importa framework, ORM, SDK, driver ou
  logger, e essa regra é verificada por teste.
- **Verificação:** QG-01, QG-03, QG-05 (F0: TypeScript estrito, regra de dependência, DI);
  IT-08 (F2).

### XII. Autenticação (opcional)

- **Enunciado (§2):** autenticação não vale pontos e é escolha do candidato. Se implementada,
  MUST integrar um Identity Provider externo, sem tabela própria de usuários com hash de senha.
  Se não implementada, a decisão e o desenho pretendido MUST estar em `ARCHITECTURE.md`, com
  ponto de extensão explícito no código. Health fica aberto; mensagens da fila são canal interno
  confiável, mas a identidade do provedor na mensagem continua sujeita às validações de domínio.
- **Previsto no plano (direção indicada pelo responsável; ainda não implementada):** ponto de
  extensão no-op na F3; IdP externo (Keycloak) como fase opcional F8.

### XIII. Clareza de nomes e segurança de tipos

Este princípio registra preferências de qualidade do responsável. São **escolhas do projeto**,
não exigências literais do desafio, e ficam abaixo do enunciado e dos demais princípios na
ordem de prevalência (ver Governance).

- **Nomes completos e compreensíveis:** identificadores (variáveis, funções, classes, tabelas,
  colunas, rotas, eventos e arquivos) MUST usar palavras completas que revelem a intenção.
  Abreviaturas MUST NOT ser usadas quando a forma completa for clara; siglas consolidadas no
  domínio ou na linguagem (por exemplo `id`, `url`, `sql`, `http`) continuam permitidas.
- **Termos em inglês familiares ao português:** entre termos em inglês corretos no contexto, a
  escolha SHOULD recair no que for familiar ou cognato ao português. Cognatos MUST ser
  conferidos quanto ao sentido: uma palavra não é proibida por ser um possível falso cognato,
  mas MUST NOT ser usada com um significado inadequado ao contexto. Por exemplo, `actual`
  significa "real, efetivo": `actualBalance` é adequado para o saldo real em comparação com o
  previsto, enquanto o "saldo atual" é `currentBalance`. Quando o cognato não tiver o sentido
  pretendido, vale o termo convencional correto em inglês.
- **Nomes que não mudam por estilo:** nomes exigidos pelo enunciado (por exemplo
  `Idempotency-Key`, `idempotentReplay`, `failureCode`, `MoneyProps`, os nomes de eventos,
  status, kinds, filas e rotas) e pelos contratos já existentes (APIs, schema, eventos e
  bibliotecas) MUST ser preservados. Mudar um nome de contrato existente exige tratá-lo como
  mudança de contrato, não como ajuste de estilo.
- **Segurança de tipos:** dados vindos de fora do processo (HTTP, SQS, banco, variáveis de
  ambiente, JSON) MUST ser validados antes de receberem um tipo de domínio. Afirmações de tipo
  (`valor as Tipo`, `as unknown as Tipo` e a afirmação de não nulo `valor!`) MUST NOT ser usadas
  para esconder dados não validados; a preferência é inferência, validação por schema e type
  guards. Uma afirmação que reste, por limitação de biblioteca ou de tipagem, SHOULD ficar
  restrita à borda e vir acompanhada do motivo. Esta regra não alcança `as const`, o `as` de
  apelido em imports e exports (`import { x as y }`) nem a negação lógica `!valor`, que não são
  afirmações de tipo sobre dados externos.
- **Dados recuperados do banco (§6.0 do enunciado):** a reidratação (`rehydrate`) reconstrói o
  estado já persistido e MUST NOT revalidar regras de transição. Na leitura, a validação se
  limita a formato e conversão (por exemplo, valor monetário com escala 2, enum conhecido, data
  válida); ela MUST NOT ser confundida com reprocessar a transição de negócio que gerou aquele
  estado.
- **Formatação e análise estática (escolhas do projeto):** Prettier para formatação e SonarJS
  para análise estática, além do ESLint já adotado. A adoção nas configurações está pendente
  (ver "Retrato do andamento").
- **Verificação:** hoje, parcialmente, por QG-01 (TypeScript estrito) e pelo ESLint com regras
  com verificação de tipos, que proíbem atribuições e chamadas inseguras de valores `any`, e
  por revisão de código. Prettier, SonarJS e eventuais regras sobre afirmações de tipo passarão
  a verificar este princípio quando forem configurados.

## Execução em Docker e entrega

- **Enunciado (§4, §14 documentação e diferenciais):** orquestração local com Docker Compose;
  `README.md` com setup e comandos; `ARCHITECTURE.md` com decisões, trade-offs e limitações.
  Teste de carga é opcional; se feito, MUST ser exposto como `bun run test:load` e relatar
  ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos e outbox lag.
- **Orientação do responsável:** o avaliador MUST conseguir subir a
  aplicação e rodar todos os testes apenas com Docker e Docker Compose
  (`docker compose up --build -d` e `docker compose run --rm --build tests`), com os mesmos
  comandos no PowerShell e no bash. Bun, Node.js, PostgreSQL e MiniStack MUST NOT ser exigidos
  no host. Claude Code e Spec Kit (`.claude/`, `.specify/`) são ferramentas do processo de
  desenvolvimento; MUST NOT ser necessários para construir, executar ou testar o projeto.
  Versões de imagens e pacotes são fixadas; a inicialização é idempotente e não apaga dados;
  a seção "Validado em" do README só lista execuções reais.

## Fluxo de desenvolvimento e quality gates

- O trabalho segue as fases do plano. O seletor `--phase` reconhece F0 a F7; cada uma dessas
  fases termina com `docker compose run --rm --build tests bun scripts/test-all.ts --phase Fn`
  saindo com 0, com o resultado real registrado. A F8 (autenticação com IdP externo) é
  opcional e ainda não tem seleção no catálogo; sua forma de validação será definida se ela vier
  a ser implementada.
- Gates de decisão do responsável: I1 MUST ser decidida antes da F3; P1 e P2 MUST ser decididas
  antes da F4. Tomar a decisão de um gate não autoriza iniciar a fase seguinte: cada fase só
  começa com autorização explícita do responsável.
- Interpretações do enunciado MUST ser registradas em `ARCHITECTURE.md` antes de serem
  implementadas, separando o texto do enunciado da leitura adotada.
- Commits só são feitos a pedido do responsável.
- Specs, planos e tarefas gerados com Spec Kit MUST citar os princípios aplicáveis e MUST NOT
  apresentar como implementado o que pertence a fases futuras.

## Interpretações adotadas e decisões pendentes

| ID | Tema (referência) | Situação |
|---|---|---|
| I2 | Escopo da Idempotency-Key (§9) | Decidida: global, comparada byte a byte; formato com `providerId` recomendado, não obrigatório |
| I1 | Replay de uma requisição cuja primeira resposta foi `202` (§9, §7 regra 7) | Pendente; necessária antes da F3 |
| P1 | Reversões de tipos diferentes sobre a mesma referência e leitura de "uma única vez" (§7 tabela e regra 4, §3) | Pendente; necessária antes da F4 |
| P2 | `WIN`/`LOSS` sobre `BET` revertida; reversão de `BET` já premiada (§7) | Pendente; necessária antes da F4 |

As escolhas atuais e os itens previstos no plano citados nos princípios não constituem
aprovação de decisões futuras: cada fase ainda depende de autorização do responsável.

## Retrato do andamento (data desta proposta: 2026-11-12)

Esta seção não é normativa; registra o andamento quando a proposta foi escrita. O estado atual
deve ser consultado em `ARCHITECTURE.md` (e os resultados de execução, na seção "Validado em"
do `README.md`).

- **Concluídas e verdes em Docker:** F0 (fundação, ambiente e harness de testes), F1 (domínio
  puro: Money, Wallet, ledger, transações, política com as regras comuns a P1/P2, catálogo de
  erros, hashes, eventos e contratos) e F2 (schema financeiro, Unit of Work, `POST /wallets`,
  `GET /wallets/:id`, ledger paginado e reconciliação; eventos gravados na outbox).
- **Ainda não implementadas:** submissão e consulta de transações, replay HTTP e ponto de
  extensão de autenticação (F3); reversões dependentes de P1/P2 e worker de pendências (F4);
  consumidor SQS, inbox, dead-letter, publisher da outbox e tratamento de mensagens em `SIGTERM`
  (F5); indisponibilidade, reinício, republicação e métricas mínimas restantes (F6); fechamento
  (F7); autenticação com IdP externo (F8, opcional).
- **Pendências de decisão:** I1, P1 e P2.
- **Princípio XIII:** Prettier e SonarJS ainda não estão configurados no projeto; a conformidade
  do código já escrito com as regras de nomes e de afirmações de tipo não foi auditada.

## Governance

- O enunciado (`docs/CHALLENGE.md`) é a fonte normativa e prevalece sobre esta constituição. Em
  caso de conflito, vale o enunciado e esta constituição MUST ser emendada.
- Ordem de prevalência: (1) enunciado; (2) esta constituição (Princípios I a XII e seções
  normativas); (3) escolhas de estilo do projeto (Princípio XIII: nomes, termos, segurança de
  tipos, Prettier e SonarJS). Uma preferência de estilo MUST NOT ser usada para descumprir um
  requisito, renomear algo exigido pelo enunciado ou quebrar um contrato existente.
- Esta constituição prevalece sobre specs, planos, tarefas e práticas do projeto; todo plano
  MUST passar pelo "Constitution Check" do modelo de plano, citando os princípios aplicáveis.
- Enquanto não for ratificada, esta constituição é um rascunho: pode ser revisada livremente com
  `/speckit-constitution`, cada revisão registrada no Sync Impact Report, sem o procedimento de
  emenda. A ratificação exige aprovação explícita do responsável, que então preenche a data de
  ratificação.
- Depois de ratificada, qualquer alteração segue o procedimento de emenda: proposta com
  `/speckit-constitution`, registro no Sync Impact Report e vigência somente após aprovação
  explícita do responsável. Decisões pendentes (I1, P1, P2) entram no texto normativo somente
  depois de decididas, por revisão do rascunho ou por emenda.
- A decisão de um gate (I1, P1, P2) não autoriza, por si só, iniciar uma fase.
- Versionamento semântico: MAJOR para remoção ou redefinição incompatível de princípios; MINOR
  para princípio ou seção nova ou orientação ampliada de forma material; PATCH para
  esclarecimentos sem efeito normativo.
- Revisão de conformidade: cada fase e cada revisão de código verificam os princípios afetados
  pelos testes indicados em "Verificação"; desvios MUST ser justificados em `ARCHITECTURE.md`.
- Orientação de uso no dia a dia: `README.md` (setup e comandos) e `ARCHITECTURE.md`
  (decisões, trade-offs e limitações).

**Version**: 0.3.1 | **Ratified**: TODO(RATIFICATION_DATE): proposta ainda não aprovada pelo responsável | **Last Amended**: 2026-11-12
