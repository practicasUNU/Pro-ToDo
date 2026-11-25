#!/usr/bin/env bash
#
# Aplica las migraciones pendientes de `db/migrations/` DENTRO del contenedor
# `postgres` (`docker compose exec`), sin necesitar `psql` en el anfitrion.
#
# Misma semantica que `scripts/apply-migrations.sh` (que sigue sirviendo a quien
# use el psql del anfitrion): la tabla `schema_migrations` guarda cada archivo
# ya aplicado, solo se ejecuta lo que falta, en orden, y se corta en el primer
# fallo. NO se reaplica toda la historia: `init.sql` es el acumulado final y no
# se puede encadenar con ella (docs/commands.md §3.1.2).
#
# Cada archivo gobierna su propia transaccion: aqui no se envuelve nada, porque
# las que anaden un valor a un enum (`030`, `039`) no pueden ir en una (55P04).
#
# Un volumen nuevo ya nace con `schema_migrations` en baseline
# (db/docker-init/02-bootstrap.sh). Una base anterior a ese cambio no la tiene:
# el script se detiene y pide `--baseline`, que registra todas como aplicadas
# SIN ejecutarlas. Usalo una sola vez y solo si la base ya esta al dia.
#
# BASE E2E. Si `E2E_DB_NAME` tiene valor (y es distinta de DB_NAME), tambien se
# atiende, sin npm ni psql en el anfitrion:
#   - No existe -> se CREA como un volumen nuevo: `init.sql` + `02-bootstrap.sh`
#     (baseline, ADMIN, semilla 069), y despues se migra. NO se le aplican las
#     69 migraciones desde cero: la historia no se puede encadenar (la 005 toca
#     `tipos_nodo`, que ya no existe; la 002 promueve un usuario inexistente...).
#   - Existe con `schema_migrations` -> se migra como DB_NAME.
#   - Existe sin `schema_migrations` -> se omite y se indica como recrearla.
#
# Configuracion: solo `backend/.env` (scripts/lib/env.sh), sin valores por
# defecto. `psql` dentro del contenedor usa el puerto interno (PGPORT = DB_PORT),
# por eso no lleva `-p`.
#
# Uso:
#   scripts/migrate-linux.sh
#   scripts/migrate-linux.sh --baseline

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"
MIGRATIONS_DIR="${REPO_ROOT}/db/migrations"
MAX_WAIT_ATTEMPTS=30

BASELINE=false
if [[ "${1:-}" == "--baseline" ]]; then
  BASELINE=true
fi

cd "${REPO_ROOT}"

# shellcheck source=scripts/lib/env.sh
source "${REPO_ROOT}/scripts/lib/env.sh"

# Aborta con la lista de lo que falte. El entorno manda sobre el archivo.
load_env_or_die "${ENV_FILE}" "${REQUIRED_ENV_VARS[@]}"
# Opcional por contrato: sin ella simplemente no se migra la base E2E.
E2E_DB_NAME="${E2E_DB_NAME:-$(read_env_var "${ENV_FILE}" E2E_DB_NAME)}"

COMPOSE=(docker compose --env-file "${ENV_FILE}")

# `-T`: sin TTY, para poder alimentar la entrada estandar con cada archivo.
psql_in() {
  local db="$1"
  shift
  "${COMPOSE[@]}" exec -T postgres \
    psql -X -v ON_ERROR_STOP=1 --quiet -U "${DB_USER}" -d "${db}" "$@"
}

echo "== Esperando a PostgreSQL (pg_isready)"
attempt=0
until "${COMPOSE[@]}" exec -T postgres pg_isready -U "${DB_USER}" -d "${DB_NAME}" > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if (( attempt >= MAX_WAIT_ATTEMPTS )); then
    echo "PostgreSQL no responde tras $((MAX_WAIT_ATTEMPTS * 2)) s." >&2
    echo "Revisa: docker compose --env-file backend/.env ps  /  ... logs postgres" >&2
    exit 1
  fi
  sleep 2
done

# Crea E2E_DB_NAME desde cero dentro del contenedor, igual que el bootstrap de
# un volumen nuevo. Si algo falla, borra la base RECIEN creada (y solo esa) para
# no dejar una a medias que la siguiente ejecucion saltaria por no tener
# `schema_migrations`.
bootstrap_e2e_database() {
  local db="$1"

  echo "== Creando ${db} (E2E_DB_NAME): init.sql + bootstrap"
  # `:"db"` cita el identificador en psql; el nombre no se interpola en el SQL.
  "${COMPOSE[@]}" exec -T postgres psql -X -v ON_ERROR_STOP=1 --quiet \
    -U "${DB_USER}" -d postgres -v db="${db}" <<< 'CREATE DATABASE :"db";'

  # Los archivos montados vienen del arbol de trabajo: si tienen CRLF (checkout
  # de Windows), se les quita el CR DENTRO del contenedor antes de usarlos.
  # BOOTSTRAP_ADMIN_EMAIL va explicita con `-e`: `exec` hereda el entorno con
  # el que se CREO el contenedor, no el `backend/.env` actual.
  if "${COMPOSE[@]}" exec -T -e "PGUSER=${DB_USER}" -e "PGDATABASE=${db}" postgres \
      sh -c "tr -d '\r' < /docker-entrypoint-initdb.d/01-init.sql | psql -X -v ON_ERROR_STOP=1 --quiet" > /dev/null \
    && "${COMPOSE[@]}" exec -T -e "POSTGRES_DB=${db}" \
      -e "BOOTSTRAP_ADMIN_EMAIL=${BOOTSTRAP_ADMIN_EMAIL}" postgres \
      sh -c "tr -d '\r' < /docker-entrypoint-initdb.d/02-bootstrap.sh > /tmp/protodo-02-bootstrap.sh && bash /tmp/protodo-02-bootstrap.sh"; then
    return 0
  fi

  echo "Fallo el bootstrap de ${db}: se borra la base recien creada." >&2
  "${COMPOSE[@]}" exec -T postgres psql -X --quiet -U "${DB_USER}" -d postgres \
    -v db="${db}" <<< 'DROP DATABASE IF EXISTS :"db";' || true
  return 1
}

database_exists() {
  local db="$1"
  [[ "$("${COMPOSE[@]}" exec -T postgres psql -X -tA -U "${DB_USER}" -d postgres \
        -v db="${db}" <<< "SELECT 1 FROM pg_database WHERE datname = :'db';")" == "1" ]]
}

migrate_database() {
  local db="$1"
  local has_table
  local -A applied_versions=()
  local applied=0
  local skipped=0

  echo "== Migraciones sobre ${db}"

  has_table="$(psql_in "${db}" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")"

  if [[ "${has_table}" != "t" ]] && ! ${BASELINE}; then
    cat >&2 <<MSG
La base "${db}" no tiene la tabla schema_migrations, asi que no se sabe que
migraciones tiene aplicadas. Si la base ya esta al dia, adoptala UNA vez con:
  scripts/migrate-linux.sh --baseline
Si no lo esta, aplica a mano las que falten (docs/commands.md §3.1) y despues
ejecuta el baseline.
MSG
    return 1
  fi

  psql_in "${db}" -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );" > /dev/null

  # Una sola consulta en vez de una por archivo.
  while IFS= read -r version; do
    [[ -n "${version}" ]] && applied_versions["${version}"]=1
  done < <(psql_in "${db}" -tAc "SELECT version FROM schema_migrations")

  for file in "${MIGRATIONS_DIR}"/*.sql; do
    local version
    version="$(basename "${file}")"

    if [[ -n "${applied_versions[${version}]:-}" ]]; then
      skipped=$((skipped + 1))
      continue
    fi

    if ${BASELINE}; then
      echo "-- registrando (sin ejecutar) ${version}"
    else
      echo "-- aplicando ${version}"
      # Sin CR: un checkout con CRLF meteria `\r` en las columnas TEXT de las
      # semillas (texto_prompt) y romperia las comparaciones exactas.
      tr -d '\r' < "${file}" | psql_in "${db}"
    fi

    # El registro va DESPUES: si la migracion falla, `set -e` corta antes y el
    # siguiente intento la reintenta en vez de darla por buena.
    psql_in "${db}" -v version="${version}" > /dev/null <<'SQL'
INSERT INTO schema_migrations (version) VALUES (:'version')
ON CONFLICT (version) DO NOTHING;
SQL
    applied=$((applied + 1))
  done

  if ${BASELINE}; then
    echo "== ${db}: ${applied} registrada(s) como aplicada(s), ${skipped} ya estaban."
  else
    echo "== ${db}: ${applied} aplicada(s), ${skipped} ya estaban."
  fi
}

${BASELINE} && echo "== Modo BASELINE: se registran sin ejecutar"

migrate_database "${DB_NAME}"

# El baseline es una decision sobre UNA base concreta: nunca se extiende a la E2E.
if ! ${BASELINE} && [[ -n "${E2E_DB_NAME}" && "${E2E_DB_NAME}" != "${DB_NAME}" ]]; then
  if ! database_exists "${E2E_DB_NAME}"; then
    bootstrap_e2e_database "${E2E_DB_NAME}"
    migrate_database "${E2E_DB_NAME}"
  elif [[ "$(psql_in "${E2E_DB_NAME}" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" != "t" ]]; then
    cat <<MSG
-- ${E2E_DB_NAME} (E2E_DB_NAME) existe pero no tiene schema_migrations: se omite.
   Es una base de pruebas: borrala y este script la recreara al dia:
     docker compose --env-file backend/.env exec postgres dropdb -U ${DB_USER} ${E2E_DB_NAME}
     scripts/migrate-linux.sh
MSG
  else
    migrate_database "${E2E_DB_NAME}"
  fi
fi
