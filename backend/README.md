# Proto-Do — Backend

API construida con [NestJS](https://nestjs.com/) que implementa el motor FSM del proyecto: ingesta de correos, extracción web, inferencia con LLM, validación/mapeo a plantillas y despacho hacia Drupal/Acens, con trazabilidad completa en PostgreSQL.

## Stack tecnológico

| Categoría | Librerías |
| --- | --- |
| **Framework** | NestJS 11 (Express), TypeORM 🐘 sobre PostgreSQL 16 |
| **Colas / Programación** | `@nestjs/bullmq`, `@nestjs/schedule` |
| **Tiempo real** | `@nestjs/websockets` + `socket.io` |
| **Ingesta de correo** | `imapflow` (conexión IMAP), `mailparser` (decodificación MIME) |
| **Extracción web** | `cheerio`, `playwright`, `@mozilla/readability`, `jsdom` |
| **Inferencia LLM** | `@anthropic-ai/sdk` (Claude), `openai` (ChatGPT) |
| **Validación / transformación** | `ajv`, `validator`, `sanitize-html`, `handlebars` |
| **Seguridad y perímetro** | `ip-range-check` (CIDR), `otplib` (OTP), `@nestjs/throttler` |
| **Trazabilidad** | `winston`, `winston-daily-rotate-file` |
| **Testing** | Jest, Supertest |

## Requisitos previos

- Node.js **24.16.0** (`.nvmrc` en la raíz) y npm ≥ 11, según `engines` de `package.json`.
- PostgreSQL 16 en el contenedor de [docker-compose.yml](../docker-compose.yml) (`sudo docker compose up -d` desde la raíz). Nunca contra una instalación nativa.
- `backend/.env` creado desde `backend/.env.example` y el symlink `.env -> backend/.env` en la raíz (ver [README raíz](../README.md#puesta-en-marcha)).
- **Chromium de Playwright** (obligatorio en entornos nuevos, una vez por máquina): `npx playwright install chromium` desde `backend/`. `npm ci` instala la librería pero no descarga navegadores (van a `~/.cache/ms-playwright`). Sin él fallan el nodo `EXTRACTOR_WEB`, la exportación a PDF y el caso PDF de `test/e2e/telemetry.e2e-spec.ts` con `Executable doesn't exist`.

## Instalación y arranque

```bash
npm ci                             # instalación determinista desde package-lock.json (nunca `npm install` en limpio)
npx playwright install chromium    # una vez por máquina: navegador headless (scraping y PDF)

npm run start:dev      # modo watch; NO recarga backend/.env, reinicia tras editarlo
npm run start          # ejecución simple
npm run start:debug    # con inspector de depuración
npm run build && npm run start:prod   # producción
```

## Base de datos

Sin CLI de TypeORM: el esquema se gestiona con SQL versionado (`init.sql` + `db/migrations/`).

```bash
npm run db:bootstrap   # crea DB_NAME si no existe: init.sql + baseline + ADMIN activo
npm run db:migrate     # aplica solo las migraciones pendientes (tabla schema_migrations)
```

Las semillas de contenido (`008, 018, 023, 024, 028, 029, 031, 032` y, para los blueprints maestros, `069`) se aplican a mano después del bootstrap. Ver [COMMANDS.md §3](../COMMANDS.md#3-migraciones-de-base-de-datos).

## Testing

```bash
npm test               # pruebas unitarias (Jest, rootDir src/)
npm run test:watch     # modo watch
npm run test:cov       # cobertura
npm run test:e2e       # integración/E2E contra PostgreSQL real (test/jest-e2e.json)
```

### Pruebas E2E: `E2E_DB_NAME`

La base de pruebas se declara una vez en `backend/.env`:

```dotenv
E2E_DB_NAME=<nombre_bd_test>   # distinto de DB_NAME
```

```bash
npm run test:bootstrap   # solo la primera vez: crea la base de pruebas
npm run test:migrate     # migraciones pendientes sobre la base de pruebas
npm run test:e2e
```

- Sin `DB_NAME=` en la línea de comandos. La guarda `test/helpers/e2e-database.guard.ts` (`setupFiles`) y `scripts/with-test-env.sh` (`test:migrate`, `test:bootstrap`) aplican la misma regla, implementada en `test/helpers/test-database.resolver.ts`.
- `DB_NAME='<nombre_bd_test>' npm run test:e2e` sigue funcionando como override explícito.
- Un `DB_NAME` heredado de `source backend/.env` (igual al de desarrollo) se descarta con un aviso.
- Abortan **antes de conectar** si `E2E_DB_NAME` falta o coincide con `DB_NAME`.

Consulta `.claude/rules/testing-standards.md` para el estándar AAA y los casos límite obligatorios en cada estrategia de nodo.

## Calidad de código

```bash
npm run verify                              # build + typecheck + jest
npx tsc --noEmit -p tsconfig.build.json     # referencia de tipos del código de producción
npm run lint                                # ESLint + Prettier con autofix
npm run format                              # Prettier sobre src/ y test/
```

> ⚠️ `npm run typecheck` **no sustituye** a `npm run build`: `nest build` puede rechazar código que `tsc` acepta (ver [COMMANDS.md](../COMMANDS.md#verificación-del-backend-antes-de-cerrar-un-cambio)).

## Dependencias

`package-lock.json` se versiona siempre. Antes de integrar en `main`, ejecuta `npm audit --audit-level=high`; nunca `npm audit fix --force` sin aprobación. Ver [docs/PRODUCTION_DEPS_GUIDE.md](../docs/PRODUCTION_DEPS_GUIDE.md).
