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
