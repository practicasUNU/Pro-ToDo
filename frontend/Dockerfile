# syntax=docker/dockerfile:1
#
# Imagen del frontend Quasar SPA de Proto-Do (perfil `app` de docker-compose.yml).
# Compila con Node y sirve solo estaticos con Nginx, que ademas enruta `/api` y
# `/api/socket.io` al contenedor `backend` (nginx.conf.template).
ARG NODE_VERSION=24.16.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `--ignore-scripts`: el `postinstall` (`quasar prepare`) necesita `src/` e
# `index.html`, que aun no estan en la imagen. Se ejecuta a mano tras el
# `COPY . .`. Los demas install scripts del lock (@parcel/watcher, fsevents) no
# intervienen en el build de produccion.
RUN npm ci --ignore-scripts
COPY . .
RUN npx quasar prepare

# Variables publicas del bundle (prefijo VITE_, security-and-scope.md §0.1).
# `frontend/.env` no entra en el contexto: llegan como build args.
ARG VITE_API_BASE_URL=/api
ARG VITE_ACCEPTED_EMAIL_DOMAINS=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_ACCEPTED_EMAIL_DOMAINS=${VITE_ACCEPTED_EMAIL_DOMAINS}
RUN npm run build

# Solo estaticos: ningun runtime de Node en la imagen final
FROM nginx:stable-alpine AS runtime
# Plantilla: el entrypoint de Nginx la renderiza con envsubst (PORT del backend)
# y la guarda en /etc/nginx/conf.d/default.conf, sustituyendo la de serie.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Corre antes que la plantilla y aborta si PORT no llega desde backend/.env.
COPY --chmod=755 docker/10-require-env.sh /docker-entrypoint.d/10-require-env.sh
COPY --from=build /app/dist/spa /usr/share/nginx/html
# Puerto interno fijo de Nginx; el del anfitrion es FRONTEND_PORT (compose).
EXPOSE 80
