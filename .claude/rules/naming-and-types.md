# Nomes e tipagem

Orientação para quem edita este repositório (pessoas ou agentes). A regra normativa é o
Princípio XIII da constituição (`.specify/memory/constitution.md`); o enunciado
(`docs/CHALLENGE.md`) e os demais princípios prevalecem sobre preferências de estilo.
Esta regra não é necessária para construir nem testar o projeto: isso continua exigindo só
Docker e Docker Compose.

## Nomes

- Use palavras completas que revelem a intenção; siglas consolidadas (`id`, `url`, `sql`,
  `http`, `sqs`, `dlq`, `orm`) e índices de laço curtos (`i`) continuam aceitos.
- Entre termos em inglês corretos no contexto, prefira o familiar ao português; confira o
  sentido de cognatos (`actualBalance` = saldo real em comparação com o previsto;
  `currentBalance` = saldo atual).
- Não renomeie por estilo o que é contrato: rotas, campos JSON e de eventos, códigos de erro,
  enums, nomes de tabelas, colunas e constraints, variáveis de ambiente, nomes de log e os
  campos `{v, w, s}` do cursor do ledger. Aliases de colunas em SQL também são contrato do
  resultado da consulta.

Vocabulário adotado no código existente:

| Conceito | Nome |
|---|---|
| Handle opaco da transação SQL (porta) | `DatabaseTransaction` / `databaseTransaction` |
| Executor de SQL preso à transação | `TransactionSql` / `toTransactionSql()` / `transactionSql` |
| EntityManager do MikroORM | `entityManager`; dentro de `transactional`: `transactionalEntityManager` |
| Transação de aposta (domínio) | `transaction` ou `wagerTransaction` |
| Contexto de evento de integração | `eventContext` |
| Unidade de trabalho | `unitOfWork` |
| Gerador de ids | `idGenerator`; ids de um movimento de wallet: `movementIds` |
| Requisição e resposta HTTP | `request` / `response` |
| Cliente do PostgreSQL em testes | `client`; fixture de teste: `fixture` |

## Tipagem

- Dados de fora do processo (HTTP, SQS, banco, ambiente, JSON) são validados antes de ganhar
  um tipo de domínio: schema zod, type guard (`value is T`) ou narrowing com `typeof`/`in`.
- Não use afirmação de tipo (`valor as Tipo`, `as unknown as Tipo`, `valor!`) para esconder
  dado não validado. `as const`, `as` em imports/exports e a negação lógica `!valor` não são
  afirmações de tipo e continuam livres.
- Uma afirmação inevitável (limitação de tipagem de biblioteca) fica na borda, com comentário
  explicando o motivo.
- Dublês de teste implementam portas (`HealthProbe`, `WalletOperations`) em vez de forçar
  tipos de classes concretas.

## Verificação

`docker compose run --rm --build tests bun scripts/test-all.ts static` roda `tsc`, ESLint
com `--max-warnings 0` (com as regras do eslint-plugin-sonarjs; não é o SonarQube completo) e
`prettier --check`.
