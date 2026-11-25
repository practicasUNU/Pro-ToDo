#!/usr/bin/env bash
#
# Crea una base limpia y la deja al dia: esquema + todas las migraciones +
# ADMIN + semillas de contenido (plantillas HTML, prompts y blueprints).
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

# Correo del administrador inicial. Obligatorio y sin valor por defecto
# versionado: la autenticacion es por OTP, asi que la cuenta tiene que existir en
# un buzon al que alguien tenga acceso real, y ese dato vive en `backend/.env`.
BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:?Falta BOOTSTRAP_ADMIN_EMAIL: declaralo en backend/.env o en el entorno}"
DB_HOST="${DB_HOST:?Falta DB_HOST: declaralo en backend/.env o en el entorno}"
DB_PORT="${DB_PORT:?Falta DB_PORT: declaralo en backend/.env o en el entorno}"
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

echo "== Semillas de contenido"
# SEMILLAS DE CONTENIDO: plantillas HTML, prompts de IA y los cinco blueprints
# maestros de `plantillas_flujo`. Van aqui por dos motivos:
#
#   * DESPUES DEL ADMIN: todo lo sembrado exige autor (`id_usuario_creador`
#     NOT NULL con FK RESTRICT). La 069 usa su ADMIN ancla y lo crea si falta.
#   * DESPUES DEL BASELINE, Y EJECUTADAS DIRECTAMENTE: el baseline ya las marco
#     como aplicadas en `schema_migrations`, asi que `apply-migrations.sh` las
#     saltaria. Antes eso dejaba la base con la 069 "aplicada" y
#     `plantillas_flujo` vacia, sin que nada lo avisara.
#
# SOLO LA 069, Y NO LA SECUENCIA HISTORICA 008-032. La 069 es autocontenida
# (ADMIN ancla, catalogo de nodos, tarifas, plantillas HTML, prompts con su
# texto FINAL y los cinco blueprints) e inserta cada fila solo si falta. Si
# antes corren las semillas antiguas, la fila ya existe con el texto de su
# epoca, la 069 no la reescribe, y las 033-068 que la ponian al dia estan
# saltadas por el baseline. Probado: con 023/032 delante, NOTIWEB_DEFAULT se
# queda sin la fecha APA de la 068 (falla `pipeline-seeds-integrity` §8), y la
# 028 deja una plantilla de apertura antigua junto a la "V1" de la 069. Las
# demas tampoco aportan nada sobre `init.sql`: la 008 son ALTER que ya
# coinciden, y la 018 crearia `prompts_ia`, la tabla que la 019 renombro (una
# tabla huerfana). Una semilla NUEVA que no cubra la 069 se anade a esta lista.
#
# Cada archivo gobierna su propia transaccion (como en `apply-migrations.sh`).
# `ON_ERROR_STOP=1` hace que psql salga con codigo 3 al primer error y
# `set -e` corta aqui. `stdout` va a /dev/null porque los SELECT de
# comprobacion de cada migracion vuelcan tablas enteras; los NOTICE y los
# errores salen por `stderr` y siguen viendose.
SEED_MIGRATIONS=(069)

for seed in "${SEED_MIGRATIONS[@]}"; do
  seed_files=("${REPO_ROOT}"/db/migrations/"${seed}"-*.sql)

  # Un glob sin coincidencias se queda literal; con varias seria ambiguo.
  if [[ ${#seed_files[@]} -ne 1 || ! -f "${seed_files[0]}" ]]; then
    echo "Semilla ${seed}: no hay exactamente un db/migrations/${seed}-*.sql" >&2
    exit 1
  fi

  echo "-- aplicando $(basename "${seed_files[0]}")"
  psql -v ON_ERROR_STOP=1 --quiet -h "${DB_HOST}" -p "${DB_PORT}" \
    -U "${DB_USER}" -d "${TARGET_DB}" -f "${seed_files[0]}" > /dev/null
done

cat <<EOF

== ${TARGET_DB} lista.

   Incluye: esquema completo, un ADMIN activo (${BOOTSTRAP_ADMIN_EMAIL}) y las
   semillas de contenido (plantillas HTML, prompts de IA y los cinco
   blueprints maestros), migracion(es): ${SEED_MIGRATIONS[*]}
EOF
