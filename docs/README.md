# Mapa da documentação

Este mapa indica onde está cada assunto do Distributed Wagering Processor. Cada documento responde
a um tipo de pergunta: como aprender, como fazer uma tarefa, onde consultar um dado ou por que o
sistema é assim.

## Por onde começar

- **Avaliar o projeto:** no [README](../README.md), siga
  [Pré-requisitos](../README.md#pré-requisitos),
  [Subir e verificar o serviço](../README.md#subir-e-verificar-o-serviço) e
  [Rodar a suíte completa](../README.md#rodar-a-suíte-completa).
- **Entender as decisões:** comece pelo
  [Roteiro de leitura](../ARCHITECTURE.md#roteiro-de-leitura) do ARCHITECTURE.
- **Manter o projeto:** o [guia de contribuição](contribuir.md) explica como testar, criar
  migrations e montar os commits.

## Documentos por tipo

| Quero… | Documento | Tipo |
|---|---|---|
| Ver, passo a passo, como o serviço trata uma aposta | [Tutorial: a primeira transação](tutorial-primeira-transacao.md) | Tutorial |
| Subir a stack e conferir que ela responde | [README: Subir e verificar o serviço](../README.md#subir-e-verificar-o-serviço) | Guia |
| Rodar a suíte completa ou só uma etapa | [README: Rodar a suíte completa](../README.md#rodar-a-suíte-completa) e [Outros comandos de teste](../README.md#outros-comandos-de-teste) | Guia |
| Saber que comando existe, onde roda e o que faz | [Referência de comandos](referencia/comandos.md) | Referência |
| Saber como a CI roda a suíte | [README: Integração contínua](../README.md#integração-contínua-github-actions) | Referência |
| Devolver mensagens da DLQ, republicar eventos ou ver a retenção | [README: Operação e recuperação](../README.md#operação-e-recuperação) | Guia |
| Ler os logs, parar a stack ou apagar os dados | [Logs](../README.md#logs), [Parar](../README.md#parar) e [Limpeza completa](../README.md#limpeza-completa-irreversível) | Guia |
| Adicionar um teste, criar uma migration ou montar um commit | [Guia de contribuição](contribuir.md) | Guia |
| Resolver um problema comum (porta ocupada, memória, CRLF) | [README: Problemas comuns](../README.md#problemas-comuns) | Guia |
| Mudar uma porta, um prazo ou um limite | [Referência de configuração](referencia/configuracao.md) | Referência |
| Consultar rotas, corpos, status e códigos de erro da API | [Referência da API HTTP](referencia/api-http.md) (o README traz o [resumo](../README.md#api-http)) | Referência |
| Consultar filas, o envelope de entrada, os eventos e a DLQ | [Referência de mensagens](referencia/mensagens.md) (o README traz o [resumo](../README.md#processamento-pelo-sqs)) | Referência |
| Saber onde e como o projeto foi validado | [README: Validado em](../README.md#validado-em) (resumo) e [Histórico de validações](validacao.md) (todas as execuções) | Referência |
| Ligar um requisito do enunciado às decisões e aos testes | [Matriz de rastreabilidade](traceability.md) | Referência |
| Entender um termo, uma sigla ou um código como `D40` | [Glossário](glossario.md) | Referência |
| Entender por que o sistema foi desenhado assim | [ARCHITECTURE.md](../ARCHITECTURE.md) | Explicação |
| Conhecer os limites do emulador SQS | [README: Limitações do emulador](../README.md#limitações-do-emulador-ministack) e [ARCHITECTURE §16](../ARCHITECTURE.md#16-limitações-do-emulador-sqs-ministack) | Explicação |

## Mapa do ARCHITECTURE

| Seção | Pergunta que ela responde |
|---|---|
| [Roteiro de leitura](../ARCHITECTURE.md#roteiro-de-leitura) | Por onde passa uma transação no código, e quais testes provam as decisões principais? |
| [§1](../ARCHITECTURE.md#1-contexto-drivers-e-não-escopo) | O que o sistema faz, o que está fora do escopo e como foram decididas as interpretações I1, I2, P1 e P2? |
| [§2](../ARCHITECTURE.md#2-estilo-e-módulos) | Como o código está dividido em módulos e quais dependências são proibidas? |
| [§3](../ARCHITECTURE.md#3-orm-e-estratégia-transacional-f2) | Como funcionam o MikroORM, a unidade de trabalho e as migrations? |
| [§4](../ARCHITECTURE.md#4-money) | Como o dinheiro é representado sem arredondamento? |
| [§5 a 7](../ARCHITECTURE.md#57-schema-e-invariantes-no-banco-f2) | Que invariantes o banco impõe, e com quais constraints e triggers? |
| [§8 e 9](../ARCHITECTURE.md#89-transições-de-estado-e-errorcatalog-f1) | Quais são os estados de uma transação, as regras da política e o catálogo de erros? |
| [§6, 10 e 14](../ARCHITECTURE.md#6-10-e-14-submissão-http-concorrência-idempotência-e-autenticação-f3) | Como a submissão HTTP trata concorrência, idempotência, respostas e autenticação? |
| [§11](../ARCHITECTURE.md#11-reversões-no-schema-e-no-domínio-f4-p1--c-p2--c) | Como as regras de reversão aparecem no domínio e no banco? |
| [§12](../ARCHITECTURE.md#12-mensageria-e-falhas-f5) | Como funcionam o consumidor, a dead-letter, o redrive, a outbox e o encerramento? |
| [§13](../ARCHITECTURE.md#13-pending_reference-e-worker-de-pendências-f4) | Como o worker decide as transações pendentes e como o prazo é calculado? |
| [§15](../ARCHITECTURE.md#15-ambiente) | Como a stack, as imagens e o pipeline de testes estão montados? |
| [§16](../ARCHITECTURE.md#16-limitações-do-emulador-sqs-ministack) | O que o MiniStack faz diferente da AWS e o que foi observado na persistência? |
| [§17](../ARCHITECTURE.md#17-observabilidade-retenção-e-recuperação-f6) | Quais logs e métricas existem, e como funcionam a retenção e a recuperação? |
| [§18 e 19](../ARCHITECTURE.md#1819-testes-rastreabilidade-trade-offs-e-limitações-f7) | Como os testes comprovam os requisitos, e quais trade-offs e limitações foram aceitos? |

## Fontes e histórico

- [docs/CHALLENGE.md](CHALLENGE.md) é o enunciado do desafio, preservado sem alteração.
- [specs/001-f3-http-submission/](../specs/001-f3-http-submission/spec.md) é o planejamento da fase
  F3 (submissão HTTP), feito com o Spec Kit. Registra como a F3 foi especificada e não acompanha as
  fases seguintes. Para o comportamento atual da API, use a
  [referência da API HTTP](referencia/api-http.md).
