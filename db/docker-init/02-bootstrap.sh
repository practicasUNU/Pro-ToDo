#!/usr/bin/env bash
#
# Bootstrap de un volumen de PostgreSQL recien creado (docker-entrypoint-initdb.d).
#
# CUANDO CORRE. Solo en el PRIMER arranque de `pgdata_protodo`, despues de
# `01-init.sql` (montaje de `init.sql`). Sobre un volumen existente, Docker no
# vuelve a ejecutar nada de `docker-entrypoint-initdb.d`.
#
# QUE HACE. Lo mismo que `scripts/bootstrap-db.sh` despues de `init.sql`, pero
# dentro del contenedor y sin `psql` en el anfitrion:
#   1. Crea `schema_migrations` y registra TODAS las migraciones en baseline.
#      `init.sql` ya es el acumulado final y la historia no se puede encadenar
#      sobre el (002/005/009 no aplican; 035-038 estan rotas): ver
#      docs/commands.md §3.1.2.
#   2. Siembra como ADMIN la cuenta de `BOOTSTRAP_ADMIN_EMAIL` (obligatoria: sale
#      de `backend/.env` y docker-compose.yml ya se niega a arrancar sin ella).
#   3. Aplica las semillas de contenido (`SEED_MIGRATIONS`, hoy solo la 069, que
#      ademas crea su propio ADMIN ancla).
#
# Asi `scripts/migrate-*.{sh,bat}` solo tiene que aplicar lo que falte.
#
# El entrypoint SOURCEA los `.sh` sin bit de ejecucion y ejecuta los que lo
# tienen. Todo va en una subshell para que `set -u` y compania no se filtren al
# entrypoint en el primer caso.

(
  set -euo pipefail

  # Segunda guarda tras el `${BOOTSTRAP_ADMIN_EMAIL:?}` de docker-compose.yml:
  # sin correo no hay un ADMIN conocido con el que entrar al panel.
  : "${BOOTSTRAP_ADMIN_EMAIL:?BOOTSTRAP_ADMIN_EMAIL vacio: definela en backend/.env}"

  MIGRATIONS_DIR="/migrations"
  SEED_MIGRATIONS=(069)

  psql_run() {
    psql -X -v ON_ERROR_STOP=1 --quiet --no-password \
      --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" "$@"
  }

  echo "== [bootstrap] Registrando migraciones en baseline sobre ${POSTGRES_DB}"
  psql_run -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );" > /dev/null

  registered=0
  for file in "${MIGRATIONS_DIR}"/*.sql; do
    [[ -f "${file}" ]] || continue
    psql_run -v version="$(basename "${file}")" > /dev/null <<'SQL'
INSERT INTO schema_migrations (version) VALUES (:'version')
ON CONFLICT (version) DO NOTHING;
SQL
    registered=$((registered + 1))
  done
  echo "-- ${registered} migracion(es) registradas sin ejecutar"

  echo "== [bootstrap] Cuenta ADMIN: ${BOOTSTRAP_ADMIN_EMAIL}"
  # Variable de psql, no interpolacion en el SQL: el correo llega del `.env`.
  psql_run -v email="${BOOTSTRAP_ADMIN_EMAIL}" > /dev/null <<'SQL'
INSERT INTO usuarios (correo, rol, activo)
VALUES (:'email', 'ADMIN', TRUE)
ON CONFLICT (correo) DO UPDATE SET rol = 'ADMIN', activo = TRUE;
SQL

  for seed in "${SEED_MIGRATIONS[@]}"; do
    seed_files=("${MIGRATIONS_DIR}"/"${seed}"-*.sql)

    # Un glob sin coincidencias se queda literal; con varias seria ambiguo.
    if [[ ${#seed_files[@]} -ne 1 || ! -f "${seed_files[0]}" ]]; then
      echo "Semilla ${seed}: no hay exactamente un ${MIGRATIONS_DIR}/${seed}-*.sql" >&2
      exit 1
    fi

    echo "== [bootstrap] Semilla $(basename "${seed_files[0]}")"
    psql_run -f "${seed_files[0]}" > /dev/null
  done

  echo "== [bootstrap] Listo"
)
