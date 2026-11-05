#!/usr/bin/env bash
#
# Crea una base limpia y la deja al dia: esquema + todas las migraciones.
#
# POR QUE NO BASTA `init.sql`. Ese archivo es DDL PURO y lo es a proposito: no
# crea ningun usuario, de modo que no puede sembrar nada que dependa de
# `id_usuario_creador` —NOT NULL con FK RESTRICT—. Las semillas (el ADMIN, las
# plantillas HTML, los prompts, el catalogo de nodos) viven en las migraciones,
# que es donde el orden de dependencias esta resuelto. Fundirlas en `init.sql`
# crearia una segunda copia de cada semilla, y dos copias divergen.
#
# ADEMAS, `init.sql` solo lo ejecuta Docker cuando el volumen nace VACIO, asi
# que no hay forma de pedirlo para una base secundaria —la de pruebas— sin
# hacerlo a mano. Eso es justo lo que automatiza esto.
#
# Uso:
#   scripts/bootstrap-db.sh '<nombre_bd_test>'
#   scripts/bootstrap-db.sh                     # usa DB_NAME de backend/.env
#
# NO BORRA NADA sin permiso: si la base ya existe, aborta. Recrearla es una
# decision con perdida de datos y no puede ser un efecto secundario.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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

TARGET_DB="${1:-${DB_NAME:?Falta DB_NAME o un nombre como primer argumento}}"

# Correo del administrador inicial. Se puede cambiar por entorno porque no hay
# ninguno versionado a proposito: la autenticacion es por OTP, asi que la cuenta
# tiene que existir en un buzon al que alguien tenga acceso real.
BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-practicas@unuware.com}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:?Falta DB_USER}"

export PGPASSWORD="${DB_PASSWORD:-}"

# Se conecta a `postgres` y no a la base destino, que todavia no existe.
admin_psql() {
  psql -v ON_ERROR_STOP=1 --quiet -h "${DB_HOST}" -p "${DB_PORT}" \
    -U "${DB_USER}" -d postgres "$@"
}

exists="$(admin_psql -tAc "SELECT 1 FROM pg_database WHERE datname = '${TARGET_DB}'")"

if [[ "${exists}" == "1" ]]; then
  echo "La base \"${TARGET_DB}\" ya existe." >&2
  echo "Para rehacerla desde cero, borrala a mano y vuelve a ejecutar:" >&2
  echo "  psql -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d postgres -c 'DROP DATABASE \"${TARGET_DB}\";'" >&2
  exit 1
fi

echo "== Creando ${TARGET_DB}"
admin_psql -c "CREATE DATABASE \"${TARGET_DB}\";"

echo "== Esquema base (init.sql)"
psql -v ON_ERROR_STOP=1 --quiet -h "${DB_HOST}" -p "${DB_PORT}" \
  -U "${DB_USER}" -d "${TARGET_DB}" -f "${REPO_ROOT}/init.sql"

echo "== Registrando las migraciones como aplicadas"
# BASELINE Y NO EJECUCION, y el motivo es que `init.sql` ES el acumulado de
# todas: una base nacida de el ya tiene el esquema final. Reproducir encima la
# historia completa no solo es redundante, es IMPOSIBLE — varias migraciones
# describen pasos intermedios que ese esquema ya dejo atras:
#
#   * `005` actualiza `tipos_nodo`, una tabla que la `011` sustituyo por `nodos`.
#   * `009` crea `tokens_sesion` sin `IF NOT EXISTS`, y ya viene en `init.sql`.
#   * `002` no CREA el administrador: PROMUEVE una cuenta existente, y en una
#     base recien creada no hay ninguna (se detiene con una excepcion, a
#     proposito).
#   * `035`-`038` escriben en `plantillas_html.actualizado_en` y
#     `plantillas_prompts_ia.actualizado_en`, columnas que NO EXISTEN: las dos
#     tablas usan `fecha_actualizacion`. Estas cuatro fallan contra cualquier
#     base, tambien la de desarrollo, y es un defecto previo del repositorio,
#     ajeno a este script.
DB_NAME="${TARGET_DB}" "${REPO_ROOT}/scripts/apply-migrations.sh" --baseline

echo "== Cuenta de administrador"
# Sin un ADMIN activo la suite E2E se detiene en el arranque. `002` no sirve
# aqui porque promueve en vez de crear, asi que se siembra la cuenta que su
# propio bloque comentado describe. Sin contrasena: la autenticacion es por OTP.
psql -v ON_ERROR_STOP=1 --quiet -h "${DB_HOST}" -p "${DB_PORT}" \
  -U "${DB_USER}" -d "${TARGET_DB}" -c "
    INSERT INTO usuarios (correo, rol, activo)
    VALUES ('${BOOTSTRAP_ADMIN_EMAIL}', 'ADMIN', TRUE)
    ON CONFLICT (correo) DO UPDATE SET rol = 'ADMIN', activo = TRUE;"

cat <<EOF

== ${TARGET_DB} lista.

   Incluye: esquema completo y un ADMIN activo (${BOOTSTRAP_ADMIN_EMAIL}).
   NO incluye: plantillas HTML, prompts de IA ni plantillas de flujo. Esas
   semillas viven en migraciones que dependen de un autor
   (\`id_usuario_creador\` es NOT NULL con FK RESTRICT), asi que para una base
   de desarrollo con contenido hay que aplicarlas a mano DESPUES, en orden:
     db/migrations/{008,018,023,024,028,029,031,032}-*.sql
EOF
