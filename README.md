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

1. Copia `.env.example` a `.env` y completa las credenciales (base de datos, IMAP/SMTP, JWT, OTP, IA, Drupal, Acens).
2. Levanta la base de datos PostgreSQL con Docker: `docker compose up -d`.
3. Sigue las instrucciones de arranque específicas en [backend/README.md](backend/README.md) y [frontend/README.md](frontend/README.md).

Para el detalle de arquitectura, convenciones de código y reglas del proyecto, consulta [claude.md](claude.md).

## Servidor MCP de PostgreSQL

`.mcp.json` (raíz del proyecto) define el servidor MCP que permite al asistente leer el esquema de la base de datos. Usa variables de entorno (`${DB_USER}`, `${DB_PASSWORD}`, `${DB_PORT}`, `${DB_NAME}`) en lugar de credenciales literales, por lo que es seguro versionarlo.

Esas variables se resuelven desde el **entorno del shell**, no desde `backend/.env` (NestJS carga ese archivo dentro de su propio proceso, no lo exporta al sistema). Antes de abrir el IDE/Claude Code, expórtalas en la misma terminal:

```bash
set -a && source backend/.env && set +a
```

Sin este paso, el servidor MCP no podrá conectarse a la base de datos.
