# shellcheck shell=bash
#
# Lectura comun de `backend/.env` para los scripts de Docker
# (setup-linux.sh, migrate-linux.sh). Se carga con `source`, no se ejecuta.
#
# `backend/.env` es la UNICA fuente de configuracion del stack (contrato:
# `backend/.env.example`). Aqui no hay valores por defecto: si falta una variable
# obligatoria se aborta con la lista completa, en vez de inventar un valor.
#
# Equivalente para Windows: scripts/lib/env.bat (misma lista, misma semantica).

# Las mismas que docker-compose.yml exige con `${VAR:?}` (compose interpola el
# archivo entero, asi que hasta `docker compose exec` falla sin ellas), mas
# FRONTEND_URL, que el gateway de sockets necesita (backend/.env.example).
REQUIRED_ENV_VARS=(
  DB_NAME
  DB_USER
  DB_PASSWORD
  DB_PORT
  POSTGRES_HOST_PORT
  PORT
  FRONTEND_URL
  FRONTEND_PORT
  FRONTEND_BIND_ADDRESS
  REDIS_PORT
  BOOTSTRAP_ADMIN_EMAIL
)

# Lee `CLAVE=valor` de un .env sin ejecutarlo: gana la ultima aparicion y se
# quitan comillas y CR (un .env guardado desde Windows).
read_env_var() {
  local file="$1"
  local key="$2"
  [[ -f "${file}" ]] || return 0
  (grep -E "^${key}=" "${file}" || true) | tail -n 1 | cut -d= -f2- | tr -d "\"'\r"
}

# load_env_or_die <archivo> <VAR>...
# Asigna (y exporta) cada VAR desde el archivo. El entorno manda sobre el
# archivo, igual que en la interpolacion de `docker compose --env-file`.
load_env_or_die() {
  local file="$1"
  shift
  local key value
  local -a missing=()

  if [[ ! -f "${file}" ]]; then
    echo "No existe ${file}. Crealo desde backend/.env.example y rellenalo." >&2
    exit 1
  fi

  for key in "$@"; do
    if [[ -z "${!key:-}" ]]; then
      value="$(read_env_var "${file}" "${key}")"
      printf -v "${key}" '%s' "${value}"
    fi
    export "${key?}"
    [[ -n "${!key}" ]] || missing+=("${key}")
  done

  if (( ${#missing[@]} > 0 )); then
    echo "Faltan variables obligatorias en ${file}:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo "Copialas de backend/.env.example y dales valor." >&2
    exit 1
  fi
}
