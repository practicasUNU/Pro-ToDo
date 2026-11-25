#!/usr/bin/env bash
#
# Puesta en marcha del stack completo de Proto-Do en Linux (Docker).
#
# Flujo (identico al de scripts\setup-windows.bat):
#   1. Comprueba Docker Engine y el plugin `docker compose`.
#   2. Comprueba que el demonio responde.
#   3. Si falta `backend/.env`, lo crea desde la plantilla y SE DETIENE: el
#      primer arranque del volumen fija DB_USER/DB_PASSWORD para siempre, asi
#      que hay que revisar las credenciales ANTES de levantar nada.
#   4. `docker compose --profile app up -d --build` (postgres, redis, backend,
#      frontend).
#   5. Aplica las migraciones pendientes (scripts/migrate-linux.sh).
#
# Uso:
#   scripts/setup-linux.sh
#
# Si tu usuario no esta en el grupo `docker`, ejecutalo con sudo o anadelo:
#   sudo usermod -aG docker "$USER"   # y cierra sesion
#
# Guia: docs/INSTALACION_Y_ENTORNO.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"
ENV_TEMPLATE="${REPO_ROOT}/backend/.env.example"

cd "${REPO_ROOT}"

# shellcheck source=scripts/lib/env.sh
source "${REPO_ROOT}/scripts/lib/env.sh"

echo "== [1/5] Docker Engine"
if ! command -v docker > /dev/null 2>&1; then
  cat >&2 <<'MSG'
No se encontro `docker` en el PATH. Instala Docker Engine y el plugin compose:
  Ubuntu / Zorin OS / Debian : https://docs.docker.com/engine/install/  (paquetes docker-ce y docker-compose-plugin)
  Arch                       : sudo pacman -S docker docker-compose && sudo systemctl enable --now docker
Despues vuelve a ejecutar este script.
MSG
  exit 1
fi

if ! docker compose version > /dev/null 2>&1; then
  echo "Falta el plugin \`docker compose\` (v2). Instala docker-compose-plugin (o docker-compose en Arch)." >&2
  exit 1
fi
docker compose version

echo "== [2/5] Demonio de Docker"
if ! docker info > /dev/null 2>&1; then
  cat >&2 <<'MSG'
El demonio de Docker no responde. Posibles causas:
  - No esta arrancado:      sudo systemctl start docker
  - Permiso denegado sobre /var/run/docker.sock: ejecuta con sudo o anade tu
    usuario al grupo docker (sudo usermod -aG docker "$USER") y vuelve a iniciar sesion.
MSG
  exit 1
fi

echo "== [3/5] Variables de entorno"
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${ENV_TEMPLATE}" "${ENV_FILE}"
  # El symlink de la raiz es el que usa `docker compose` sin --env-file y el
  # servidor MCP (security-and-scope.md §0).
  [[ -e "${REPO_ROOT}/.env" ]] || ln -s backend/.env "${REPO_ROOT}/.env"
  cat <<MSG
Se ha creado backend/.env a partir de backend/.env.example.
Revisa AHORA las credenciales (DB_USER, DB_PASSWORD, DB_NAME, BOOTSTRAP_ADMIN_EMAIL,
JWT_SECRET, CREDENTIALS_ENCRYPTION_KEY, IMAP/SMTP, ANTHROPIC_API_KEY, DRUPAL_*, ACENS_API_KEY)
y vuelve a ejecutar este script. El primer arranque del volumen fija las
credenciales de PostgreSQL y no se pueden cambiar despues sin recrearlo.
MSG
  exit 0
fi
[[ -e "${REPO_ROOT}/.env" ]] || ln -s backend/.env "${REPO_ROOT}/.env"

# Sin valores por defecto: aborta listando lo que falte (backend/.env.example).
load_env_or_die "${ENV_FILE}" "${REQUIRED_ENV_VARS[@]}"

echo "== [4/5] Contenedores (perfil app)"
docker compose --env-file "${ENV_FILE}" --profile app up -d --build

echo "== [5/5] Migraciones"
"${REPO_ROOT}/scripts/migrate-linux.sh"

# HTTP plano: con el "modo solo HTTPS" del navegador hay que escribir `http://`.
echo "== Listo. Panel: http://localhost:${FRONTEND_PORT}"
