#!/usr/bin/env bash
#
# Ejecuta un comando apuntando a la base de las pruebas E2E.
#
# POR QUE EXISTE. `test:migrate` y `test:bootstrap` exigian
# `DB_NAME='<nombre_bd_test>'` delante de cada invocacion. El nombre vive ahora
# en `E2E_DB_NAME` de `backend/.env`, y este envoltorio lo convierte en el
# `DB_NAME` que esperan `apply-migrations.sh` y `bootstrap-db.sh` (los dos
# respetan lo que ya este en el entorno).
#
# PRECEDENCIA, identica a la de `backend/test/helpers/test-database.resolver.ts`:
#   1. `DB_NAME` del entorno distinto del de `backend/.env` -> override explicito.
#   2. `DB_NAME` del entorno IGUAL al de desarrollo -> herencia de
#      `set -a && source backend/.env`; se descarta con aviso.
#   3. Si no, `E2E_DB_NAME` (entorno y, si no, `backend/.env`).
# Aborta, sin ejecutar el comando, si el resultado esta vacio o coincide con la
# base de desarrollo.
#
# NO HACE `source` del `.env`: lee solo las dos claves que necesita, para no
# exportar al comando nada que no se haya pedido.
#
# Uso:
#   scripts/with-test-env.sh <comando> [argumentos...]
#   scripts/with-test-env.sh bash scripts/apply-migrations.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"
USAGE="Declara E2E_DB_NAME='<nombre_bd_test>' en backend/.env (distinto de DB_NAME) o lanza con un override explicito: DB_NAME='<nombre_bd_test>' npm run test:migrate (o test:bootstrap)"

if [[ $# -eq 0 ]]; then
  echo "Uso: scripts/with-test-env.sh <comando> [argumentos...]" >&2
  exit 64
fi

# Recorta espacios, CR (el `.env` puede ser CRLF) y comillas envolventes.
trim_value() {
  local value="${1//$'\r'/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ ${#value} -ge 2 && ( "${value}" == \"*\" || "${value}" == \'*\' ) ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "${value}"
}

# Primera linea `<clave>=...` del `.env`. El ancla `^` evita que `DB_NAME`
# case con `E2E_DB_NAME`. Se descarta un comentario final ` # ...`.
read_env_value() {
  local key="$1" line
  [[ -f "${ENV_FILE}" ]] || return 0
  line="$(grep -m1 -E "^[[:space:]]*${key}[[:space:]]*=" "${ENV_FILE}" || true)"
  [[ -n "${line}" ]] || return 0
  line="${line#*=}"
  line="${line%%[[:space:]]#*}"
  trim_value "${line}"
}

development_db="$(read_env_value DB_NAME)"
explicit_db="$(trim_value "${DB_NAME:-}")"

if [[ -n "${explicit_db}" && "${explicit_db}" != "${development_db}" ]]; then
  target_db="${explicit_db}"
else
  e2e_db="$(trim_value "${E2E_DB_NAME:-}")"
  if [[ -z "${e2e_db}" ]]; then
    e2e_db="$(read_env_value E2E_DB_NAME)"
  fi

  if [[ -z "${e2e_db}" ]]; then
    echo "[e2e] Falta E2E_DB_NAME. ${USAGE}" >&2
    exit 1
  fi

  if [[ "${e2e_db}" == "${development_db}" ]]; then
    echo "[e2e] E2E_DB_NAME apunta a la base de desarrollo (DB_NAME de backend/.env). ${USAGE}" >&2
    exit 1
  fi

  if [[ -n "${explicit_db}" ]]; then
    echo "[e2e] DB_NAME del entorno es la base de desarrollo (heredado de \`source backend/.env\`); se usa E2E_DB_NAME." >&2
  fi

  target_db="${e2e_db}"
fi

export DB_NAME="${target_db}"
exec "$@"
