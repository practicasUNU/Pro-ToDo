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
# Si `E2E_DB_NAME` esta definida y esa base existe en el contenedor, se migra
# tambien, para que la suite E2E no quede desfasada.
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

# Lee `CLAVE=valor` de backend/.env sin ejecutarlo (quita comillas y CR).
read_env_var() {
  local key="$1"
  [[ -f "${ENV_FILE}" ]] || return 0
  (grep -E "^${key}=" "${ENV_FILE}" || true) | tail -n 1 | cut -d= -f2- | tr -d "\"'\r"
}

# El entorno manda sobre el archivo, como en apply-migrations.sh.
DB_USER="${DB_USER:-$(read_env_var DB_USER)}"
DB_NAME="${DB_NAME:-$(read_env_var DB_NAME)}"
E2E_DB_NAME="${E2E_DB_NAME:-$(read_env_var E2E_DB_NAME)}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-protodo}"

COMPOSE=(docker compose)
[[ -f "${ENV_FILE}" ]] && COMPOSE+=(--env-file "${ENV_FILE}")

# `-T`: sin TTY, para poder alimentar la entrada estandar con cada archivo.
psql_in() {
  local db="$1"
  shift
  "${COMPOSE[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 --quiet -U "${DB_USER}" -d "${db}" "$@"
}

echo "== Esperando a PostgreSQL (pg_isready)"
attempt=0
until "${COMPOSE[@]}" exec -T postgres pg_isready -U "${DB_USER}" -d "${DB_NAME}" > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if (( attempt >= MAX_WAIT_ATTEMPTS )); then
    echo "PostgreSQL no responde tras $((MAX_WAIT_ATTEMPTS * 2)) s." >&2
    echo "Revisa: docker compose ps  /  docker compose logs postgres" >&2
    exit 1
  fi
  sleep 2
done

database_exists() {
  local db="$1"
  [[ "$("${COMPOSE[@]}" exec -T postgres psql -tA -U "${DB_USER}" -d postgres \
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
      psql_in "${db}" < "${file}"
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
    echo "-- ${E2E_DB_NAME} (E2E_DB_NAME) no existe en el contenedor: se omite (crear con npm run test:bootstrap --prefix backend)"
  elif [[ "$(psql_in "${E2E_DB_NAME}" -tAc "SELECT to_regclass('public.schema_migrations') IS NOT NULL")" != "t" ]]; then
    echo "-- ${E2E_DB_NAME} (E2E_DB_NAME) no tiene schema_migrations: se omite (recreala con npm run test:bootstrap --prefix backend)"
  else
    migrate_database "${E2E_DB_NAME}"
  fi
fi
