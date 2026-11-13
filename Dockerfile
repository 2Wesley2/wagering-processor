# syntax=docker/dockerfile:1
# Imagem base fixada por tag + digest do índice multi-arch (amd64/arm64).
# Plano B documentado: oven/bun:1.3.14-slim (trocar só este ARG).
ARG BUN_IMAGE=oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

FROM ${BUN_IMAGE} AS base
WORKDIR /app
# A imagem base usa um entrypoint em shell; o processo da app deve ser o filho
# direto do tini (init: true no compose), por isso o entrypoint é zerado.
ENTRYPOINT []

FROM base AS deps-prod
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS deps-dev
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps-prod /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src ./src
# Falha o build se src/ importar algo que só existe nas devDependencies.
RUN bun src/cli/boot-check.ts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]

FROM base AS test
ENV NODE_ENV=test
COPY --from=deps-dev /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json eslint.config.ts .prettierrc.json .prettierignore docker-compose.yml Dockerfile .gitattributes .editorconfig ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
RUN mkdir -p /app/test-results && chown -R bun:bun /app/test-results
USER bun
CMD ["bun", "scripts/test-all.ts"]

# Geração do bun.lock sem Bun no host:
#   docker build --target lockfile-export --output "type=local,dest=." .
FROM base AS lockfile
# Parte do bun.lock existente (quando houver): só dependências novas ou alteradas são resolvidas.
COPY package.json bun.lock* ./
RUN bun install --ignore-scripts

FROM scratch AS lockfile-export
COPY --from=lockfile /app/bun.lock /bun.lock
