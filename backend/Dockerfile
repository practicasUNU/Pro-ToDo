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
# Seguro antes del `COPY . .`: el package.json del backend no declara
# `postinstall` ni `prepare`, y los install scripts de sus dependencias nativas
# no leen `src/`. Si algun dia se anade un hook que dependa del codigo, hay que
# usar `--ignore-scripts` aqui y lanzarlo despues del `COPY . .`.
RUN npm ci

# 2) Compilacion
FROM deps AS build
COPY . .
RUN npm run build

# 3) Pruebas (servicio efimero `backend-test`, perfil `test` de docker-compose.yml).
# Parte de `deps`, asi que conserva las devDependencies (jest, ts-jest,
# supertest, @nestjs/testing, typescript, @nestjs/cli) que el runtime descarta.
# No es la ultima etapa: `docker build` sin `--target` sigue produciendo el
# runtime, y esta etapa no le anade ni un byte.
# Las suites leen archivos de fuera de `backend/` (`db/migrations`,
# `scripts/with-test-env.sh`) y el `.env`; no entran en este contexto de build y
# los monta docker-compose.yml en runtime.
FROM deps AS test
COPY . .
CMD ["npm", "test"]

# 4) Runtime: solo dependencias de produccion + Chromium
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

COPY package.json package-lock.json ./
# Mismo razonamiento que en `deps`: ningun hook depende de `src/` ni de `dist/`.
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
# Sin EXPOSE: el puerto lo fija PORT de `backend/.env` (main.ts) y lo publica
# docker-compose.yml; un numero aqui seria un valor fijo que puede mentir.
CMD ["node", "dist/main"]
