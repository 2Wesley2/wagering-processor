# syntax=docker/dockerfile:1
# Ambiente de desenvolvimento OPCIONAL (VS Code Dev Containers). Construir e testar o
# projeto continua exigindo só Docker + Compose (docker compose run --rm --build tests ...).
# Mesma imagem base do Dockerfile da raiz: ao trocar o digest lá, troque aqui também.
ARG BUN_IMAGE=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

FROM ${BUN_IMAGE}
ENTRYPOINT []
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git less procps \
  && rm -rf /var/lib/apt/lists/*

# O bind mount do Windows aparece com dono root: o Git do contêiner precisa confiar na pasta.
# Os pontos de montagem dos volumes nomeados nascem com dono `bun`; o Docker copia esse dono
# para o volume na primeira montagem.
RUN git config --system --add safe.directory /workspaces/backend-challenge \
  && mkdir -p /workspaces/backend-challenge/node_modules /home/bun/.claude \
  && chown -R bun:bun /workspaces /home/bun/.claude

USER bun
ENV PATH=/home/bun/.local/bin:${PATH} \
    CLAUDE_CONFIG_DIR=/home/bun/.claude

# Instalador nativo oficial (confere o SHA-256 do binário). Versão inicial igual à do host.
# O instalador grava configuração (inclusive autoUpdates=false, por causa da versão fixada) num
# diretório temporário descartado: o volume de configuração nasce vazio e, em tempo de execução,
# a atualização automática fica ligada (a versão baixada some a cada rebuild da imagem).
ARG CLAUDE_CODE_VERSION=2.1.312
RUN export CLAUDE_CONFIG_DIR=/tmp/claude-install \
  && curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}" \
  && claude --version \
  && rm -rf /tmp/claude-install \
  && find /home/bun/.claude -mindepth 1 -delete
