# Proto-Do

Plataforma de automatización y orquestación basada en una máquina de estados finita (FSM), orientada a la ingesta de correos (IMAP), extracción y procesamiento de contenido web, inferencia con modelos de lenguaje (Claude / ChatGPT) y sincronización de resultados con Drupal y Acens.

## Estructura del monorepo

```text
Pro-ToDo/
├── backend/    # API NestJS + PostgreSQL, motor FSM y estrategias de nodos
├── frontend/   # SPA Vue 3 + Quasar
├── db/         # Migraciones SQL (db/migrations/NNN-*.sql) y bootstrap del volumen (db/docker-init/)
├── docs/       # Documentación operativa (comandos, instalación, dependencias, pruebas)
├── scripts/    # setup/migrate (-linux.sh / -windows.bat), apply-migrations.sh, bootstrap-db.sh…
├── init.sql    # Esquema completo (lo ejecuta Docker en un volumen vacío)
└── .claude/    # Reglas, skills y comandos del asistente
```

No hay `package.json` en la raíz: `backend/` y `frontend/` son proyectos Node.js independientes. La referencia operativa completa de comandos está en [docs/commands.md](docs/commands.md); la arquitectura y las reglas del proyecto, en [claude.md](claude.md).

## Documentación

| Documento | Contenido |
|---|---|
| [docs/INSTALACION_Y_ENTORNO.md](docs/INSTALACION_Y_ENTORNO.md) | Instalación en **Linux y Windows**, puertos, proxy inverso (Apache/Nginx) y stack completo en Docker |
| [docs/commands.md](docs/commands.md) | Referencia operativa de comandos (Docker, migraciones, backend, frontend, Git) |
| [docs/PRODUCTION_DEPS_GUIDE.md](docs/PRODUCTION_DEPS_GUIDE.md) | Dependencias, lockfiles, Dockerfiles y auditoría |
| [docs/GUIA_PRUEBAS_MALA_LECHE.md](docs/GUIA_PRUEBAS_MALA_LECHE.md) | Pruebas hostiles (CLI, HTTP y UI) |

**Arranque rápido del stack completo en contenedores** (sin Node.js en el anfitrión):
`scripts/setup-linux.sh` en Linux o `scripts\setup-windows.bat` en Windows. La sección siguiente
describe el modo desarrollo, con backend y frontend en el anfitrión.

## Requisitos

- Node.js **24.16.0** (fijado en [.nvmrc](.nvmrc); `nvm use` lo encuentra desde cualquier subcarpeta) y npm ≥ 11, coherentes con `engines` de cada `package.json`.
- Docker con Compose v2. En este entorno el socket de Docker exige `sudo`; si tu usuario pertenece al grupo `docker`, omítelo.
- Cliente `psql` en el anfitrión (lo usan `scripts/*.sh`).
- Navegador Chromium de Playwright, una vez por máquina: `cd backend && npx playwright install chromium`. `npm ci` instala la librería `playwright` pero **no** descarga navegadores; sin ellos fallan el nodo `EXTRACTOR_WEB`, la exportación a PDF y su caso en `telemetry.e2e-spec.ts` (`Executable doesn't exist at …/ms-playwright/…`).

## Puesta en marcha

Todos los comandos se ejecutan desde la **raíz del repositorio** salvo que se indique otra cosa.

```bash
# 1. Variables de entorno (backend). Completa credenciales: BD, IMAP/SMTP, JWT, OTP, IA, Drupal, Acens.
#    Declara también E2E_DB_NAME='<nombre_bd_test>', distinto de DB_NAME (ver "Pruebas E2E").
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# 2. Symlink para que Docker Compose interpole ${DB_USER}, ${DB_PASSWORD}, ${DB_PORT}, ${DB_NAME}
ln -s backend/.env .env

# 3. Exportar el entorno a la terminal (MCP de PostgreSQL y psql). Una vez por terminal.
set -a && source backend/.env && set +a

# 4. PostgreSQL 16 en Docker (anfitrión ${POSTGRES_HOST_PORT} -> contenedor ${DB_PORT}; ver docs/INSTALACION_Y_ENTORNO.md §1.2)
sudo docker compose up -d

# 5. Dependencias: siempre `npm ci`, nunca `npm install` en un clonado limpio
(cd backend && npm ci)
(cd frontend && npm ci)

# 6. Navegador headless de Playwright (scraping y PDF). Una vez por máquina, en entornos nuevos.
(cd backend && npx playwright install chromium)
```

`npm ci` instala exactamente lo que fija `package-lock.json` y falla si el lock y `package.json` no concuerdan. `npm install` se reserva para añadir, quitar o actualizar una dependencia de forma consciente (ver [docs/PRODUCTION_DEPS_GUIDE.md](docs/PRODUCTION_DEPS_GUIDE.md) y `.claude/rules/dependency-security.md`).

### Base de datos de desarrollo

`npm run db:bootstrap --prefix backend` crea una base **que no exista** y la deja lista en un solo paso. Ejecuta `init.sql`, registra todas las migraciones como aplicadas (baseline), siembra un ADMIN activo y carga las **semillas de contenido** (plantillas HTML, prompts de IA y los cinco blueprints maestros de `plantillas_flujo`, migración `069`). Si la base ya existe, aborta sin tocar nada.

> ⚠️ **El primer `docker compose up -d` sobre un volumen vacío ya crea `DB_NAME`** desde `init.sql` (variable `POSTGRES_DB`), pero sin ADMIN ni registro en `schema_migrations`, así que `db:bootstrap` abortará con «ya existe». Como esa base nace vacía, lo más limpio es borrarla y dejar que `db:bootstrap` la rehaga. El comando exacto (`DROP DATABASE …`) lo imprime el propio script al abortar. Hazlo **solo** sobre una base recién creada: borrar una base con datos los pierde.

```bash
npm run db:bootstrap --prefix backend    # base nueva: esquema + baseline + ADMIN + semillas
npm run db:migrate --prefix backend      # después: aplica solo las migraciones pendientes
```

No hacen falta bucles manuales de semillas tras el bootstrap. Más detalle en [docs/commands.md §3.1.2](docs/commands.md#312-crear-una-base-desde-cero).

### Arranque

```bash
cd backend  && npm run start:dev   # terminal 1 — API NestJS (no recarga backend/.env: reinicia al editarlo)
cd frontend && npm run dev         # terminal 2 — SPA Quasar
```

## Pruebas E2E

Las suites E2E montan el `AppModule` real contra PostgreSQL, así que **nunca** corren contra la base de desarrollo. Su base sale de `E2E_DB_NAME` en `backend/.env`:

```bash
cd backend
npm run test:bootstrap   # solo la primera vez: crea la base de pruebas (esquema + baseline + ADMIN + semillas)
npm run test:migrate     # al día con las migraciones pendientes
npm run test:e2e         # suites *.e2e-spec.ts (test/jest-e2e.json)
```

Ninguno necesita `DB_NAME=` en la línea de comandos. La precedencia es la misma en la guarda de Jest (`backend/test/helpers/e2e-database.guard.ts`) y en `scripts/with-test-env.sh`:

1. Un `DB_NAME='<nombre_bd_test>'` explícito, distinto del de desarrollo, gana.
2. Un `DB_NAME` heredado de `source backend/.env` (igual al de desarrollo) se ignora con un aviso y se usa `E2E_DB_NAME`.
3. Abortan **antes de conectar** si `E2E_DB_NAME` falta o coincide con `DB_NAME`.

`test:bootstrap` ya carga las semillas que valida `pipeline-seeds-integrity.e2e-spec.ts`. Una base de pruebas creada **antes** de este cambio puede tener la `069` registrada pero sin ejecutar (`plantillas_flujo` vacía). Si es así, recréala o aplica una vez `db/migrations/069-*.sql` con `psql -v ON_ERROR_STOP=1 -d "${E2E_DB_NAME}"`.

## Docker Compose: interpolación de variables

`docker-compose.yml` referencia `${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}`, `${DB_NAME}` para configurar el contenedor de PostgreSQL. Docker Compose resuelve esa interpolación **solo** leyendo un archivo `.env` ubicado junto al propio `docker-compose.yml` (o vía `--env-file`), nunca desde el `.env` de un servicio ni desde variables cargadas dentro de un proceso Node.

Como el `.env` real vive en `backend/.env`, la raíz usa un **symlink** hacia él (`ln -s backend/.env .env`) en lugar de duplicar el archivo. El symlink no se versiona (lo excluye `.gitignore`), así que hay que recrearlo tras cada clonado. Sin él, `docker compose up -d` mostrará avisos de «variable is not set» y el contenedor arrancará con credenciales vacías.

## Servidor MCP de PostgreSQL

`.mcp.json` define el servidor MCP que permite al asistente leer el esquema de la base de datos. Usa variables de entorno (`${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}`, `${DB_NAME}`) en lugar de credenciales literales, por lo que es seguro versionarlo.

Esas variables se resuelven desde el **entorno del shell**, no desde `backend/.env`. Expórtalas en la terminal antes de abrir el IDE o Claude Code (`set -a && source backend/.env && set +a`); sin este paso, el servidor MCP no podrá conectarse.
