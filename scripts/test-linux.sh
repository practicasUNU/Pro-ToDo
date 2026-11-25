#!/usr/bin/env bash
#
# Ejecuta las suites de Jest del backend DENTRO de Docker (servicio efimero
# `backend-test`, perfil `test`), sin node, npm ni psql en el anfitrion.
#
# Flujo:
#   1. Valida `backend/.env` (scripts/lib/env.sh, sin valores por defecto) y,
#      si la suite lo necesita, `E2E_DB_NAME`.
#   2. Levanta `postgres` y `redis` y espera a que esten sanos.
#   3. `scripts/migrate-linux.sh`: esquema al dia en DB_NAME y crea/migra
#      E2E_DB_NAME.
#   4. Reconstruye `backend-test` (el codigo va copiado en la imagen) y lanza la
#      suite con `docker compose run --rm`. Sale con el codigo de Jest.
#
# Uso:
#   scripts/test-linux.sh [unit|e2e|all]      # por defecto: all
#
#   unit -> npm test           (src/**/*.spec.ts, todo con dobles de prueba)
#   e2e  -> npm run test:e2e   (test/**/*.e2e-spec.ts, AppModule real contra
#                               E2E_DB_NAME)
#   all  -> las dos, en ese orden
#
# Con Node.js instalado en el anfitrion, `npm test` / `npm run test:e2e` desde
# `backend/` siguen siendo la via rapida (docs/commands.md §4.3).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/backend/.env"

SUITE="${1:-all}"

# Se resuelve ANTES de tocar Docker: un argumento mal escrito no levanta nada.
case "${SUITE}" in
  unit) JEST_COMMAND="npm test"; NEEDS_E2E_DB=false ;;
  e2e)  JEST_COMMAND="npm run test:e2e"; NEEDS_E2E_DB=true ;;
  all)  JEST_COMMAND="npm test && npm run test:e2e"; NEEDS_E2E_DB=true ;;
  *)
    cat >&2 <<MSG
Suite desconocida: "${SUITE}". Validas: unit | e2e | all (por defecto all).
No existe una suite "integration": las pruebas con base de datos real son las e2e.
MSG
    exit 2
    ;;
esac

cd "${REPO_ROOT}"

# shellcheck source=scripts/lib/env.sh
source "${REPO_ROOT}/scripts/lib/env.sh"

load_env_or_die "${ENV_FILE}" "${REQUIRED_ENV_VARS[@]}"
E2E_DB_NAME="${E2E_DB_NAME:-$(read_env_var "${ENV_FILE}" E2E_DB_NAME)}"

if ${NEEDS_E2E_DB}; then
  if [[ -z "${E2E_DB_NAME}" ]]; then
    echo "La suite \"${SUITE}\" necesita E2E_DB_NAME en backend/.env (distinta de DB_NAME)." >&2
    exit 1
  fi
  if [[ "${E2E_DB_NAME}" == "${DB_NAME}" ]]; then
    echo "E2E_DB_NAME coincide con DB_NAME: las e2e borran filas, no pueden usar la base de desarrollo." >&2
    exit 1
  fi
fi

COMPOSE=(docker compose --env-file "${ENV_FILE}" --profile test)

echo "== [1/4] PostgreSQL y Redis"
"${COMPOSE[@]}" up -d --wait postgres redis

echo "== [2/4] Migraciones (DB_NAME y E2E_DB_NAME)"
"${REPO_ROOT}/scripts/migrate-linux.sh"

echo "== [3/4] Imagen backend-test (codigo actual)"
"${COMPOSE[@]}" build backend-test

echo "== [4/4] Jest: ${SUITE}"
# `exec`: el codigo de salida del script es el de Jest.
exec "${COMPOSE[@]}" run --rm backend-test sh -c "${JEST_COMMAND}"
