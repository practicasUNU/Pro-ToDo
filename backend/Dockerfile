# syntax=docker/dockerfile:1
#
# Imagen del backend NestJS de Proto-Do (perfil `app` de docker-compose.yml).
# Parte de la plantilla de docs/PRODUCTION_DEPS_GUIDE.md §4. Runtime glibc
# (bookworm-slim, no alpine): Playwright necesita Chromium y sus librerias del
# sistema para el nodo EXTRACTOR_WEB.
#
# La version de Node es la de `.nvmrc` y `engines` (dependency-security.md §3).
ARG NODE_VERSION=24.16.0

# 1) Dependencias completas, solo desde el lock
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# 2) Compilacion
FROM deps AS build
COPY . .
RUN npm run build

# 3) Runtime: solo dependencias de produccion + Chromium
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Como root: `--with-deps` instala con apt las librerias de Chromium. Usa la
# version de `playwright` que acaba de fijar el lock.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

# `logs/` y `static/uploads/` se montan como volumenes; crearlos aqui con dueno
# `node` hace que Docker copie esa propiedad al volumen vacio la primera vez.
RUN mkdir -p logs static/uploads && chown -R node:node logs static

USER node
EXPOSE 3000
CMD ["node", "dist/main"]
