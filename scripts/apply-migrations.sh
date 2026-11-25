#!/usr/bin/env bash
#
# Aplica las migraciones de `db/migrations/` que aun no se hayan aplicado.
#
# POR QUE EXISTE. Las migraciones se aplicaban a mano, una a una, y el registro
# de cuales habian corrido estaba en la cabeza de quien las aplico. La base de
# las pruebas E2E (`<nombre_bd_test>`) se mantenia igual, de modo que una
# migracion nueva la dejaba desfasada y la suite fallaba por un motivo que no
# era el codigo. El sintoma real: `PROCESADOR_OCR` nunca llego a la base de
# desarrollo porque la `022` se salto, y el segundo selector del explorador de
# variables aparecia vacio sin que nada lo explicara.
#
# TABLA DE CONTROL. `schema_migrations` guarda el nombre de cada archivo ya
# aplicado. Las migraciones siguen siendo idempotentes —eso no cambia—, pero
# reaplicarlas todas en cada arranque es lento y, sobre todo, ruidoso: las
# comprobaciones finales de cada archivo dejan de distinguir "se aplico ahora"
# de "ya estaba".
#
# CADA ARCHIVO GOBIERNA SU PROPIA TRANSACCION, y por eso aqui NO se envuelve
# nada. Unas migraciones declaran `BEGIN;`/`COMMIT;` y otras no; y las que
# anaden un valor a un enum (`030`, `039`) NO PUEDEN ir en transaccion, porque
# PostgreSQL prohibe usar un valor de enum en la misma transaccion en la que se
# anade (error 55P04). Un `--single-transaction` global romperia esas dos y
# chocaria con el `BEGIN` propio de las demas.
#
# ADOPCION EN UNA BASE QUE YA ESTA MIGRADA. La tabla nace vacia, asi que la
# primera ejecucion sobre la base de desarrollo intentaria reaplicarlo todo.
# Son idempotentes y no romperian nada, pero es lento y las comprobaciones de
# cada archivo dejarian de significar nada. Para eso esta `--baseline`: marca
# como aplicadas las migraciones existentes SIN ejecutarlas. Se usa UNA vez, y
# solo sobre una base que ya este al dia.
#
# Uso:
#   scripts/apply-migrations.sh                 # base de desarrollo (DB_NAME)
#   scripts/apply-migrations.sh --baseline      # adoptar una base ya migrada
#   DB_NAME='<nombre_bd_test>' scripts/apply-migrations.sh
#
# Las credenciales salen de `backend/.env`; lo que ya este en el entorno manda,
# que es como se apunta a la base de pruebas sin tocar el archivo.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/db/migrations"

# `set -a` exporta lo que se lea; el `||:` tolera que no exista el archivo en
# una maquina donde todo venga del entorno.
# EL ENTORNO MANDA SOBRE EL ARCHIVO. `source` con `set -a` pisa lo que ya
# estuviera exportado, asi que las variables que interesan se guardan antes y se
# reponen despues. Sin esto, `DB_NAME='<nombre_bd_test>' scripts/...` apuntaba a
# la base de DESARROLLO, que es la forma mas silenciosa de aplicar una migracion
# donde no tocaba.
_ENV_DB_HOST="${DB_HOST:-}"
_ENV_DB_PORT="${DB_PORT:-}"
_ENV_DB_NAME="${DB_NAME:-}"
_ENV_DB_USER="${DB_USER:-}"
_ENV_DB_PASSWORD="${DB_PASSWORD:-}"

if [[ -f "${REPO_ROOT}/backend/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/backend/.env" || :
  set +a
fi

[[ -n "${_ENV_DB_HOST}" ]] && DB_HOST="${_ENV_DB_HOST}"
[[ -n "${_ENV_DB_PORT}" ]] && DB_PORT="${_ENV_DB_PORT}"
[[ -n "${_ENV_DB_NAME}" ]] && DB_NAME="${_ENV_DB_NAME}"
[[ -n "${_ENV_DB_USER}" ]] && DB_USER="${_ENV_DB_USER}"
[[ -n "${_ENV_DB_PASSWORD}" ]] && DB_PASSWORD="${_ENV_DB_PASSWORD}"
: # el ultimo `[[ ]]` puede devolver 1 y `set -e` abortaria

# Sin valores por defecto: todo sale de `backend/.env` (o del entorno).
DB_HOST="${DB_HOST:?Falta DB_HOST: declaralo en backend/.env o en el entorno}"
DB_PORT="${DB_PORT:?Falta DB_PORT: declaralo en backend/.env o en el entorno}"
DB_NAME="${DB_NAME:?Falta DB_NAME: declaralo en backend/.env o en el entorno}"
DB_USER="${DB_USER:?Falta DB_USER: declaralo en backend/.env o en el entorno}"

export PGPASSWORD="${DB_PASSWORD:-}"

psql_run() {
  psql -v ON_ERROR_STOP=1 --quiet -h "${DB_HOST}" -p "${DB_PORT}" \
    -U "${DB_USER}" -d "${DB_NAME}" "$@"
}

BASELINE=false
if [[ "${1:-}" == "--baseline" ]]; then
  BASELINE=true
fi

echo "== Migraciones sobre ${DB_NAME} en ${DB_HOST}:${DB_PORT}"
${BASELINE} && echo "== Modo BASELINE: se registran sin ejecutar" 

# La tabla de control se crea sola. No es una migracion mas a proposito: tiene
# que existir ANTES de poder saber que migraciones se aplicaron.
psql_run -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );" > /dev/null

applied=0
skipped=0

for file in "${MIGRATIONS_DIR}"/*.sql; do
  version="$(basename "${file}")"

  if [[ "$(psql_run -tAc "SELECT 1 FROM schema_migrations WHERE version = '${version}'")" == "1" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  if ${BASELINE}; then
    echo "-- registrando (sin ejecutar) ${version}"
  else
    echo "-- aplicando ${version}"
    psql_run -f "${file}"
  fi

  # El registro va DESPUES y en su propia sentencia: si la migracion falla, el
  # `set -e` corta aqui y la version no queda marcada, de modo que el siguiente
  # intento la reintenta en vez de darla por buena.
  psql_run -c "INSERT INTO schema_migrations (version) VALUES ('${version}')
               ON CONFLICT (version) DO NOTHING;" > /dev/null

  applied=$((applied + 1))
done

if ${BASELINE}; then
  echo "== Listo: ${applied} registrada(s) como aplicada(s), ${skipped} ya estaban."
else
  echo "== Listo: ${applied} aplicada(s), ${skipped} ya estaban."
fi
