# syntax=docker/dockerfile:1
#
# Imagen del frontend Quasar SPA de Proto-Do (perfil `app` de docker-compose.yml).
# Compila con Node y sirve solo estaticos con Nginx, que ademas enruta `/api` y
# `/api/socket.io` al contenedor `backend` (nginx.conf).
ARG NODE_VERSION=24.16.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `postinstall` (quasar prepare) necesita la configuracion de Quasar.
COPY quasar.config.ts tsconfig.json ./
RUN npm ci
COPY . .

# Variables publicas del bundle (prefijo VITE_, security-and-scope.md §0.1).
# `frontend/.env` no entra en el contexto: llegan como build args.
ARG VITE_API_BASE_URL=/api
ARG VITE_ACCEPTED_EMAIL_DOMAINS=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_ACCEPTED_EMAIL_DOMAINS=${VITE_ACCEPTED_EMAIL_DOMAINS}
RUN npm run build

# Solo estaticos: ningun runtime de Node en la imagen final
FROM nginx:stable-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/spa /usr/share/nginx/html
EXPOSE 80
