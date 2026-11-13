# Feature Specification: F3 — Submissão HTTP de transações, idempotência e concorrência

**Feature Branch**: nenhuma (o trabalho segue em `main`, sem branch própria, por orientação do responsável)

**Created**: 2026-11-12

**Status**: Draft

**Input**: User description: "F3 do Distributed Wagering Processor: submissão HTTP de transações de aposta (POST /wagering/transactions), as duas consultas de transação, idempotência persistente com Idempotency-Key global (I2) e replay da resposta original congelada (I1 = opção A), concorrência por wallet e atomicidade entre transação, saldo, ledger e outbox; ponto de extensão de autenticação no-op; PENDING_REFERENCE persistido sem worker; smoke V2b. Fora de escopo: worker de pendências, IT-10b, regras dependentes de P1/P2 (F4), SQS (F5)."

Fonte normativa: `docs/CHALLENGE.md` (§n). Interpretações decididas: I2 e I1 em `ARCHITECTURE.md` §1.
Princípios aplicáveis da constituição (rascunho 0.3.1): I (precisão monetária), II (wallet e
ledger), III (banco como autoridade), IV (concorrência por wallet), V (idempotência), VI (regras de
transação), VII (outbox), VIII (respostas distinguíveis), IX (testes reais), XII (autenticação) e
XIII (nomes e tipos). A I1 aparece como pendente na constituição por defasagem documental.
O plano de implementação completo (decisões D23–D33, catálogo de testes) é a referência técnica;
esta spec registra só o recorte da F3.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Provedor submete uma operação e recebe o desfecho (Priority: P1)

Um provedor de jogos envia BET, WIN, LOSS, REFUND ou ROLLBACK para uma wallet e recebe, na mesma
resposta, o desfecho (aplicada, rejeitada por regra de negócio ou aceita aguardando a referência)
e o saldo observado naquele momento.

**Why this priority**: é o núcleo do desafio (§1, §7, §9); sem isso nada mais da fase existe.

**Independent Test**: com uma wallet de 1000.00 BRL, submeter BET 25.00 e verificar desfecho
"aplicada", saldo 975.00, um lançamento de débito e os eventos gravados na outbox.

**Acceptance Scenarios**:

1. **Given** wallet com 1000.00 BRL, **When** o provedor submete BET 25.00, **Then** a resposta é
   "aplicada" com saldo 975.00 e `idempotentReplay: false`, e existe exatamente um débito no ledger.
2. **Given** wallet com 10.00, **When** submete BET 20.00, **Then** a resposta é "rejeitada" com
   `failureCode` INSUFFICIENT_FUNDS, o saldo continua 10.00, nenhum lançamento é criado e a rejeição
   fica gravada e auditável.
3. **Given** uma BET aplicada, **When** submete WIN referenciando essa BET, **Then** o crédito é
   aplicado e a WIN fica ligada à BET.
4. **Given** uma REFUND cuja BET referenciada ainda não chegou, **When** submete a REFUND, **Then** a
   resposta é "aceita, aguardando referência" com o saldo do aceite, sem mover saldo.
5. **Given** um LOSS, **When** submetido, **Then** é "aplicada" sem lançamento e sem mudar a versão.

---

### User Story 2 - Reenvios e chaves conflitantes são seguros (Priority: P1)

O provedor reenvia a mesma requisição (timeout, retry, duplicação) e recebe exatamente a primeira
resposta, sem novo efeito; uma chave reutilizada com conteúdo diferente é recusada como conflito.

**Why this priority**: idempotência persistente vale 15 pontos e duplicar débito é eliminatório (§14).

**Independent Test**: repetir uma BET com a mesma chave e o mesmo corpo e comparar código, corpo e
quantidade de lançamentos.

**Acceptance Scenarios**:

1. **Given** uma BET aplicada (resposta "aplicada", 975.00), **When** a mesma chave e o mesmo corpo são
   reenviados depois de uma WIN que levou o saldo a 985.00, **Then** a resposta tem o mesmo código e o
   mesmo corpo da primeira (saldo 975.00), só com `idempotentReplay: true`, e nenhum novo efeito.
2. **Given** a primeira resposta foi "aceita, aguardando referência", **When** a mesma requisição é
   reenviada, **Then** a resposta repete esse aceite (mesmo código e corpo), qualquer que seja o estado
   posterior da transação (I1, opção A).
3. **Given** a chave K usada por provider-a, **When** provider-b envia K com outro conteúdo, **Then** a
   resposta é conflito IDEMPOTENCY_KEY_REUSED, sem dados da transação existente e sem nada gravado.
4. **Given** (provedor, id externo) já usados, **When** chega uma chave nova com o mesmo par, **Then** a
   resposta é conflito EXTERNAL_TRANSACTION_ID_CONFLICT.
5. **Given** a mesma operação enviada 50 vezes em paralelo a 3 instâncias, **Then** há um único débito e
   todas as respostas trazem o mesmo desfecho.

---

### User Story 3 - Disputa pelo saldo entre instâncias (Priority: P1)

Várias instâncias recebem ao mesmo tempo operações da mesma wallet; o saldo nunca fica negativo,
nenhuma atualização se perde, e wallets diferentes não se bloqueiam.

**Why this priority**: concorrência vale 20 pontos; o cenário do §8 é obrigatório.

**Independent Test**: cenário do §8 com 3 instâncias e sobreposição comprovada.

**Acceptance Scenarios**:

1. **Given** saldo 100.00 BRL, **When** duas BET de 80.00 chegam simultaneamente por instâncias
   diferentes, **Then** exatamente uma é aplicada, a outra é rejeitada por saldo insuficiente, o saldo
   final é 20.00 e existe um único débito.
2. **Given** a wallet A travada por uma operação em andamento, **When** chega uma operação na wallet B,
   **Then** B é processada sem esperar A.

---

### User Story 4 - Consulta do estado atual de uma transação (Priority: P2)

O provedor ou o operador consulta uma transação pelo id interno ou pelo par (provedor, id externo) e
vê o estado atual, o saldo histórico da decisão e, para auditoria, o desfecho e o saldo do aceite.

**Why this priority**: é o canal para acompanhar pendências (I1) e diagnosticar; não move dinheiro.

**Independent Test**: consultar uma transação aplicada e uma pendente pelos dois caminhos.

**Acceptance Scenarios**:

1. **Given** uma BET aplicada, **When** consultada pelos dois caminhos, **Then** ambos mostram o mesmo
   estado atual, o saldo e a versão da decisão, o estado inicial e o saldo do aceite.
2. **Given** uma transação pendente, **When** consultada, **Then** o estado é "aguardando referência",
   sem saldo de decisão.
3. **Given** um id inexistente, **When** consultado, **Then** a resposta é "não encontrada" com código
   próprio.

---

### User Story 5 - Falhas transitórias e de contrato distinguíveis (Priority: P2)

O provedor distingue pelo código de resposta: corpo inválido, chave ausente, provedor não reconhecido,
wallet inexistente, conflito, rejeição de negócio, aceite pendente e falha transitória (reenviar com a
mesma chave).

**Why this priority**: §9 exige essa distinção para o provedor decidir se reenvia.

**Independent Test**: matriz de casos inválidos sem efeito colateral e um lock segurado além do limite.

**Acceptance Scenarios**:

1. **Given** corpo inválido, chave ausente, provedor desconhecido, wallet inexistente, mídia errada ou
   corpo grande, **When** submetido, **Then** cada caso tem um código distinto e nada é gravado.
2. **Given** a wallet travada além do tempo limite ou o banco indisponível, **When** submetido, **Then**
   a resposta é falha transitória com indicação de reenvio, e um reenvio com a mesma chave depois que a
   falha passa não duplica efeito.

### Edge Cases

- Falha depois do último registro e antes da confirmação: nada fica gravado (transação, saldo,
  lançamento e eventos).
- Processo morto no meio da gravação: nada fica gravado e a wallet não fica presa.
- Duas chaves diferentes para o mesmo (provedor, id externo) em paralelo: um efeito, um conflito.
- Reversão sobre referência que já tem reversões ou WIN: depende de P1/P2; falha de forma explícita
  (erro interno identificado), sem decidir em silêncio.
- Wallet de outro jogador ou moeda divergente: recusado sem gravar; corrigível com a mesma chave.
- OPENING submetida pela API: recusada.
- Instância congelada segurando uma operação: as demais continuam atendendo a mesma wallet assim que a
  conexão congelada expira.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST aceitar submissões de BET, WIN, LOSS, REFUND e ROLLBACK com o contrato do
  §9 e recusar OPENING (§6.3).
- **FR-002**: A chave de idempotência MUST ser obrigatória, opaca, comparada byte a byte e única no
  sistema inteiro (I2); o formato `{providerId}:{externalTransactionId}` é recomendado, não exigido.
- **FR-003**: Mesma chave e mesmo conteúdo MUST devolver o código e o corpo da primeira resposta, só com
  `idempotentReplay: true`, mesmo que o estado da transação tenha mudado (I1, opção A); o reenvio é
  somente leitura.
- **FR-004**: Mesma chave com conteúdo diferente MUST ser conflito IDEMPOTENCY_KEY_REUSED sem revelar a
  transação existente; chave nova com (provedor, id externo) já usado MUST ser
  EXTERNAL_TRANSACTION_ID_CONFLICT.
- **FR-005**: A decisão MUST seguir a precedência comum às opções de P1/P2 (referência ausente →
  pendente; escopo, kind, status e valor da referência; saldo; limite); casos que dependem de P1/P2
  MUST falhar explicitamente.
- **FR-006**: Transação, alteração de saldo, lançamento e eventos de integração MUST ser gravados de
  forma atômica; LOSS, rejeições e pendências MUST NOT gerar lançamento.
- **FR-007**: Operações da mesma wallet MUST ser serializadas entre instâncias sem lock global; wallets
  diferentes MUST progredir em paralelo.
- **FR-008**: As respostas MUST distinguir: aplicada, rejeitada por regra, aceita pendente, contrato
  inválido, identidade do provedor, não encontrada, conflito e falha transitória (com reenvio).
- **FR-009**: As duas consultas de transação MUST mostrar o estado atual, o saldo histórico da decisão e,
  para auditoria, o estado inicial e o saldo do aceite.
- **FR-010**: MUST existir um ponto de extensão de autenticação (hoje sem efeito) e a verificação de que o
  provedor é reconhecido; health continua público.
- **FR-011**: O smoke da stack (V2b) MUST percorrer pelo balanceador o fluxo criar wallet → BET → WIN →
  reenvio → consultas → reconciliação, com dados próprios a cada execução, sem apagar nada.

### Key Entities

- **Transação de aposta**: operação submetida; guarda o desfecho original (estado, saldo e versão do
  aceite, código de falha) e o estado atual (desfecho final, saldo e versão da decisão).
- **Wallet**: saldo e versão; serializa as operações.
- **Lançamento do ledger**: um por transação com efeito; imutável.
- **Evento de integração**: gravado junto com a transação; publicado só na F5.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No cenário do §8 repetido 100 vezes com 3 instâncias, 100% das execuções terminam com uma
  aplicada, uma rejeitada, saldo 20.00 e um débito.
- **SC-002**: 50 envios idênticos em paralelo produzem 1 débito e 50 respostas com o mesmo desfecho.
- **SC-003**: Ao fim de todo teste, o saldo de cada wallet é igual ao saldo reconstruído pelo ledger.
- **SC-004**: Todos os IDs obrigatórios até a F3 do catálogo terminam em PASS, e o smoke V2b sai com 0.
- **SC-005**: Nenhuma falha injetada antes da confirmação deixa registro parcial.

## Assumptions

- O registro de provedores reconhecidos vem da configuração (padrão: `provider-a`, `provider-b`).
- O desfecho de uma pendência só acontece na F4 (worker); na F3 ela permanece pendente.
- A publicação dos eventos da outbox é da F5; aqui eles só são gravados.
- Autenticação real (IdP externo) é a F8 opcional.
- Nenhuma mudança de schema é necessária: a migration 0001 já tem as colunas da resposta original.
