# syntax=docker/dockerfile:1
# Architecture Forge - Dockerfile multi-estágio

# ==========================================================
# Estágio base: instala dependências (cacheável)
# ==========================================================
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# ==========================================================
# Estágio dev: hot-reload com Vite
# ==========================================================
FROM base AS dev
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["bun", "run", "dev"]

# ==========================================================
# Estágio build: produz os assets estáticos + server
# ==========================================================
FROM base AS build
WORKDIR /app
COPY . .
RUN bun run build

# ==========================================================
# Estágio prod: só o necessário pra rodar
# ==========================================================
FROM oven/bun:1-slim AS prod
WORKDIR /app
RUN addgroup --system --gid 1001 app && \
    adduser --system --uid 1001 app
COPY --from=build --chown=app:app /app/.output ./.output
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./
USER app
EXPOSE 3000
ENV NODE_ENV=production
CMD ["bun", "run", ".output/server/index.mjs"]
