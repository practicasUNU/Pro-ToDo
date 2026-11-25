#!/bin/sh
#
# Guarda del entrypoint de Nginx (/docker-entrypoint.d/): se ejecuta antes que
# `20-envsubst-on-templates.sh`. El entrypoint corre con `set -e`, asi que salir
# con error aqui detiene el contenedor en vez de arrancar con un `proxy_pass`
# roto (envsubst dejaria `${PORT}` literal).
#
# PORT llega de `backend/.env` a traves de docker-compose.yml.

set -eu

if [ -z "${PORT:-}" ]; then
  echo "[protodo] PORT no esta definida: definela en backend/.env (ver backend/.env.example)" >&2
  exit 1
fi

case "${PORT}" in
  *[!0-9]*)
    echo "[protodo] PORT='${PORT}' no es un numero de puerto valido" >&2
    exit 1
    ;;
esac
