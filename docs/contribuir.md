# Guia de contribuição

Como mudar o código deste repositório: rodar os testes, adicionar um teste, criar uma migration,
checar antes do commit e montar os commits.

## Antes de começar

- **Tudo roda em contêiner.** O host precisa só do Docker com o Compose. Os testes rodam no
  contêiner `tests` (`docker compose run --rm --build tests …`).
- **Dev Container (opcional).** `.devcontainer/` sobe um ambiente com Bun, um PostgreSQL e um
  MiniStack de teste próprios, num projeto Compose separado (`wagering-dev`). Nele, as etapas rodam
  sem reconstruir a imagem: `bun scripts/test-all.ts static unit`. O contêiner `tests` copia os
  arquivos no build; o Dev Container lê a pasta de trabalho.
- **Nomes e tipos.** As regras de nomes, de validação de dados externos e de afirmações de tipo estão
  em [`.claude/rules/naming-and-types.md`](../.claude/rules/naming-and-types.md). A fonte normativa é
  o Princípio XIII da [constituição](../.specify/memory/constitution.md).
- **Decisões de negócio.** As interpretações I1, I2, P1 e P2 só mudam com decisão do responsável pelo
  projeto (ver o ARCHITECTURE, [§1](../ARCHITECTURE.md#1-contexto-drivers-e-não-escopo)).

## Adicionar um teste

1. Coloque o arquivo na pasta do nível: `test/unit/` (domínio, sem I/O), `test/integration/`
   (PostgreSQL e MiniStack reais), `test/concurrency/` (disputas entre instâncias) ou
   `test/resilience/` (quedas e indisponibilidade).
2. Ponha o ID entre colchetes no nome do caso: `test('[IT-21j] …', …)`. É assim que o meta-check
   liga o caso ao catálogo.
3. Se o ID é novo, registre-o em [`test/meta/required.ts`](../test/meta/required.ts), no mesmo commit:
   `catalogEntry('IT-99', 'F5', 'integration', 'descrição')`. A fase e a etapa definem quando o ID
   passa a ser exigido.
4. Rode a etapa e confira no relatório que o ID rodou e passou. Rodar só algumas etapas não torna o
   meta-check estrito, então um ID esquecido não reprova sozinho.

```bash
docker compose run --rm --build tests bun scripts/test-all.ts static integration
```

## Criar uma migration

1. Crie o arquivo seguinte em `src/platform/persistence/migrations/` (ex.: `0005-…ts`), com
   `sqlMigration({ name, up, down })`: o SQL é escrito à mão, com `up` e `down`.
2. Registre-a no fim da lista `MIGRATIONS` de
   [`migrations/index.ts`](../src/platform/persistence/migrations/index.ts).
3. Ajuste, no mesmo commit, os testes que listam o schema e as migrations:
   - o catálogo do schema, `[QG-04]` em `test/integration/schema-catalog.test.ts`;
   - a subida e a reversão, em `test/integration/migration-upgrade.test.ts` e
     `test/integration/migrations.test.ts`;
   - os outros testes que citam os nomes das migrations (`git grep Migration0004`).
4. **Nunca edite uma migration já aplicada.** O checksum faz o job `migrate` falhar. Uma correção de
   schema é uma migration nova.

## Checagens antes de cada commit

- Sempre: `git diff --cached --check`.
- Código, testes ou configuração de execução: `static` mais as etapas da área mudada.

| Área mudada | Etapas |
|---|---|
| `src/shared` e `*/domain` | `static` + `unit` |
| Migrations, persistência, HTTP, read models | `static` + `unit` + `integration` |
| Consumidor, outbox, redrive, worker, encerramento, locks | `static` + `integration` + `concurrency` + `resilience` |

- Só documentação: revise o diff, os links e os comandos citados (o Prettier não formata Markdown).
- Antes de rodar, confira que os arquivos que o teste lê são os do commit; se houver mudanças fora
  dele que possam afetar o resultado, valide numa cópia isolada.
- A cada entrega que mude código, testes, dependências ou configuração de execução: a suíte completa
  num clone limpo do SHA entregue, com um projeto Compose isolado (`-p`), registrada no
  [histórico de validações](validacao.md).

## Mensagens de commit

- Assunto `tipo(escopo): descrição`, com até 72 caracteres, em português, verbo no presente, inicial
  minúscula e sem ponto final. Exemplo: `fix(wagering): corrige o prazo efetivo em cadeia`.
- Tipos: `feat`, `fix` (corrige comportamento), `refactor` (reorganiza sem mudar comportamento),
  `test`, `docs`, `build`, `chore` e `ci`.
- Reaproveite os escopos já usados no histórico quando representarem bem a mudança.
- Uma linha em branco separa o corpo, com linhas de até 72 caracteres. O corpo é obrigatório num
  `fix`, numa migration nova, numa mudança de contrato (rota, campo JSON, código de erro) e numa
  mudança de I1, I2, P1 ou P2; ele explica o motivo e o efeito.

## Tabela-guia por tipo de mudança

| # | Mudança | Entra no mesmo commit | Mensagem | Checagem do commit |
|---|---|---|---|---|
| 1 | Regra de domínio ou `src/shared` | código, testes unitários, ID novo em `required.ts`, documentação e spec afetadas | `feat(escopo)` ou `fix(escopo)`; corpo no `fix` | `static` + `unit` |
| 2 | Migration nova | arquivo, linha em `migrations/index.ts`, ajustes de `[QG-04]`, upgrade e reversão | `feat(db)` ou `fix(db)`, conforme a finalidade; corpo obrigatório | `static` + `unit` + `integration` |
| 3 | Persistência, HTTP, read model | código, registro (`composition.ts`, `app.module.ts`), testes | `feat(escopo)` ou `fix(escopo)` | `static` + `unit` + `integration` |
| 4 | Mensageria, worker, outbox, encerramento, locks | código, registro, testes | `feat(escopo)` ou `fix(escopo)` | `static` + `integration` + `concurrency` + `resilience` |
| 5 | Contrato (rota, campo JSON, código de erro) ou I1, I2, P1, P2 | código, testes, spec, README e ARCHITECTURE; as decisões só mudam com aprovação do responsável | corpo obrigatório | etapas da área |
| 6 | Refatoração preparatória | só a reorganização, sem mudar comportamento | `refactor(escopo)` | `static` + etapas da área |
| 7 | Documentação sem código | o texto | `docs(escopo)` | revisão do diff, dos links e dos comandos |
| 8 | Registro de validação | SHA, comando e ID da execução no histórico, no README e na matriz | `docs(escopo)` | revisão de documentação |
| 9 | Constituição | revisão aprovada, sem o Sync Impact Report; a regra de nomes junto, se o Princípio XIII mudar | `docs(governance)`, com versão, motivo e impactos no corpo | revisão de documentação |
| 10 | `.claude/rules/` | sincronia: junto com o código que muda o que a regra cita; política: junto com a constituição; esclarecimento: sozinho | tipo da mudança principal ou `docs(governance)` | a da mudança principal; mudança no ESLint: `static` + testes afetados |
| 11 | Atualização do Spec Kit | arquivos gerados, manifestos e skills `speckit-*` | `chore(speckit)`, com as versões no corpo | hashes dos manifestos, modo 100755 dos scripts, `static` conforme o impacto |
| 12 | Edição direta em arquivo gerado | só o arquivo | commit próprio, com o motivo | revisão do diff |
| 13 | Dependência nova para uma funcionalidade | `package.json` + `bun.lock` junto com a funcionalidade; versões exatas; pacotes de execução em `dependencies`, tipos e ferramentas de desenvolvimento em `devDependencies` | tipo da funcionalidade | a da funcionalidade + `bun.lock` gerado pelo `lockfile-export` e instalação com `--frozen-lockfile` |
| 14 | Atualização de dependência | `package.json` + `bun.lock` + ajustes de código; pacotes da mesma família juntos | `build(deps)`, com versões e motivo no corpo | `static` + etapas e testes que usam a dependência |
| 15 | Imagem base (Bun, PostgreSQL, MiniStack, nginx) | todas as referências à imagem e ao digest, mais a §15 do ARCHITECTURE | `build(docker)` ou `build(nginx)`, com tag e digest antigos e novos no corpo | etapas da peça; MiniStack exige `conformance`; nginx: subir a stack e rodar o smoke `full` |
| 16 | Configuração de execução | junto com o código que a exige; sozinha só quando for só infraestrutura | tipo da mudança principal; só infraestrutura: `build(docker)` ou `build(nginx)` | Compose: `docker compose config --quiet` + casos afetados, inclusive `[IT-32]` |
| 17 | Só o Dev Container | só `.devcontainer/` | `chore(devcontainer)` | reconstruir o ambiente e rodar `static` nele |
| 18 | Só testes (caso novo para comportamento existente, ajuste de asserção) | o teste; ID novo em `required.ts`; a linha da matriz fica "Pendente de validação" se a evidência mudar | `test(escopo)` | `static` + a etapa afetada; confirmar pelo nome ou pelo ID que o caso rodou e passou |
| 19 | Harness de testes (`test/support/`, `test/meta/`, `scripts/test-all.ts`) | o harness e os testes dele, num commit próprio | `test(support)` ou `test(meta)` | `static` + etapas que usam o trecho; `[QG-08]` para o meta-check; `--selfcheck` para a propagação de falhas; mudança no modo estrito: numa cópia isolada, um ID obrigatório ausente aparece como `NOT IMPLEMENTED` e o comando sai com 1 |
| 20 | Git e editor (`.gitignore`, `.gitattributes`, `.editorconfig`) | só esses arquivos | `chore(git)` ou `chore(editor)` | `git check-ignore -v` ou `git check-attr` em caminhos reais; `static` se mudar fim de linha ou indentação; renormalizar só os arquivos afetados |
| 21 | Ferramentas de qualidade (`tsconfig.json`, `.prettierrc.json`, `.prettierignore`, `eslint.config.ts`) | a configuração; dentro de uma mudança maior, vai junto com ela | ajuste isolado: `build(quality)`; mudança maior: tipo da principal | `static` + testes afetados (ex.: `[QG-09]`, `[QG-10]`); se mudar uma exclusão, conferir o que a ferramenta passa a cobrir |
| 22 | Workflow de CI (`.github/workflows/`) | só o workflow | `ci: …`, com gatilhos e permissões no corpo | actionlint em contêiner + `docker compose config --quiet`; a validação real é a execução da CI |

- **Ordem dentro de uma entrega** (referência, não regra): refatoração preparatória, migration,
  comportamento, registro da validação. A migration, o registro dela e os testes afetados andam
  sempre juntos; separe a migration do comportamento só se cada commit deixar a aplicação coerente e
  verificável.
- **Mais de uma linha se aplica:** some as checagens. Uma mudança no worker que também ajusta um teste
  unitário roda `static` + `unit` + `integration` + `concurrency` + `resilience`.

## Documentação e registros

- README, ARCHITECTURE e [matriz](traceability.md) mudam no mesmo commit do código quando ele muda o
  que descrevem.
- Uma linha nova ou afetada da matriz fica "Pendente de validação" até haver evidência.
- Resultados de execução entram num commit `docs` próprio, com o SHA testado, o comando e o ID da
  execução, no [histórico de validações](validacao.md). Registros antigos não são reescritos.
- A [referência de configuração](referencia/configuracao.md), a [da API](referencia/api-http.md), a
  [de mensagens](referencia/mensagens.md) e a [de comandos](referencia/comandos.md) acompanham as
  mudanças nas variáveis, nas rotas, nos eventos e nos comandos.
