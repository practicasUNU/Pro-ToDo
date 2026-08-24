# Proto-Do

Plataforma de automatización y orquestación basada en una máquina de estados finita (FSM), orientada a la ingesta de correos (IMAP), extracción y procesamiento de contenido web, inferencia con modelos de lenguaje (Claude / ChatGPT) y sincronización de resultados con Drupal y Acens.

## Estructura del monorepo

```text
Pro-ToDo/
├── backend/    # API NestJS + PostgreSQL, motor FSM y estrategias de nodos
├── frontend/   # SPA Vue 3 + Quasar
└── .claude/    # Reglas, skills y comandos del asistente
```

## Puesta en marcha rápida

1. Copia `backend/.env.example` a `backend/.env` y completa las credenciales (base de datos, IMAP/SMTP, JWT, OTP, IA, Drupal, Acens).
2. Crea el symlink que permite a Docker Compose interpolar esas variables (ver sección siguiente): `ln -s backend/.env .env`.
3. Levanta la base de datos PostgreSQL con Docker: `docker compose up -d`.
4. Sigue las instrucciones de arranque específicas en [backend/README.md](backend/README.md) y [frontend/README.md](frontend/README.md).

Para el detalle de arquitectura, convenciones de código y reglas del proyecto, consulta [claude.md](claude.md).

## Docker Compose: interpolación de variables

`docker-compose.yml` referencia `${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}`, `${DB_NAME}` para configurar el contenedor de PostgreSQL. Docker Compose resuelve esa interpolación **solo** leyendo un archivo `.env` ubicado junto al propio `docker-compose.yml` (o vía `--env-file`) — nunca desde el `.env` de un servicio ni desde variables cargadas dentro de un proceso Node.

Como el `.env` real vive en `backend/.env` (ver separación de contextos más abajo), la raíz del proyecto usa un **symlink** hacia él en lugar de duplicar el archivo:

```bash
ln -s backend/.env .env
```

Este symlink no se versiona (ya excluido en `.gitignore` junto con el resto de `.env*`), así que cada desarrollador debe recrearlo tras clonar el repo. Sin él, `docker compose up -d` mostrará warnings de "variable is not set" y el contenedor arrancará con credenciales vacías.

## Servidor MCP de PostgreSQL

`.mcp.json` (raíz del proyecto) define el servidor MCP que permite al asistente leer el esquema de la base de datos. Usa variables de entorno (`${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}`, `${DB_NAME}`) en lugar de credenciales literales, por lo que es seguro versionarlo.

Esas variables se resuelven desde el **entorno del shell**, no desde `backend/.env` (NestJS carga ese archivo dentro de su propio proceso, no lo exporta al sistema). Antes de abrir el IDE/Claude Code, expórtalas en la misma terminal:

```bash
set -a && source backend/.env && set +a
```

Sin este paso, el servidor MCP no podrá conectarse a la base de datos.
