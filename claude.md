# Proto-Do 🤖

> Plataforma de automatización y orquestación FSM para ingesta de correos, extracción con LLM y sincronización con Drupal y Acens.

---

## 💬 Pautas de Comunicación

- Avanzar paso a paso, esperando validación antes de aplicar cambios estructurales.
- Identificar la causa raíz de cualquier incidencia antes de proponer una solución técnica.
- Código en inglés (métodos, variables, interfaces) y comentarios/documentación en español.

---

## 🖥️ Entorno y Estructura Monorepo

- **SO:** Linux (Zorin OS) | **Shell:** Bash | **Ruta:** `/var/www/html/UNUWARE/Pro-ToDo/`
- **Backend:** NestJS 🦁 + PostgreSQL 🐘 (`/backend`)
- **Frontend:** Vue 3 + Quasar Framework ⚡ (`/frontend`)

```text
Pro-ToDo/
├── backend/            # API NestJS, FSM Engine y repositorios
├── frontend/           # SPA Vue 3 + Quasar
├── db/
│   └── migrations/     # Migraciones SQL (TypeORM synchronize: false)
└── .claude/            # Configuración modular del asistente
    ├── rules/          # Reglas no negociables de arquitectura y Git
    ├── skills/         # Procedimientos técnicos detallados
    └── commands/       # Comandos personalizados (/slash-commands)
```

---

## 📦 Stack Tecnológico

| Categoría | Librerías |
| --- | --- |
| **Ingesta de correo** | `imapflow` (conexión IMAP), `mailparser` (decodificación MIME) |
| **Sanitización & extracción web** | `cheerio` (DOM), `playwright` (navegación headless), `@mozilla/readability` (aislamiento de artículos) |
| **Inferencia LLM** | `@anthropic-ai/sdk` (Claude), `openai` (ChatGPT) |
| **Validación / transformación** | `ajv` (JSON Schema para Drupal), `validator` / `@types/validator`, `sanitize-html`, `handlebars` |
| **Seguridad y perímetro** | `ip-range-check` (CIDR), `otplib` (OTP) |
| **Trazabilidad** | `winston`, `winston-daily-rotate-file` |
| **Colas** | `bullmq`, `@nestjs/bullmq` |
| **Tiempo real (deps instaladas, sin uso aún)** | `socket.io`, `@nestjs/websockets`, `@nestjs/platform-socket.io` (backend), `socket.io-client` (frontend) — ver estado de avance más abajo |
| **Infraestructura** | Docker Compose (PostgreSQL 16, puerto host `${DB_PORT:-5433}` → contenedor `5432`) |

> Nota: `backend/.env.example` declara `PORT=5000` para la API pero `ASSETS_BASE_URL=http://localhost:3000/...` — inconsistencia real del archivo de entorno, no de esta tabla. Revisar antes de asumir el puerto de assets.

---

## 🚧 Estado de Avance

- ✅ Motor FSM (`FsmEngineService`), `StatePayloadContext` inmutable y protocolo de resiliencia (log en disco vía Winston → checkpoint en PostgreSQL → pausa del cursor) — implementado y operativo.
- ✅ Tríada de nodos (servicio/store/componente) completa para `TRIGGER_IMAP`, `PARSER_PRE_IA`, `EXTRACTOR_WEB`, `MAPEADOR_PLANTILLA`. `TRIGGER_CRON` no tiene `.service.ts` por diseño (validación resuelta enteramente en cliente).
- ⏳ **Pendiente:** `NotificationGateway` (WebSocket) y `useExecutionStore` en frontend — las dependencias (`socket.io`, `@nestjs/websockets`, `socket.io-client`) están instaladas pero no existe ningún gateway, listener ni sala `flow_${id}` implementados. El contrato sigue vigente en `rules/architecture-patterns.md` y `rules/frontend-quasar.md` como arquitectura objetivo.
- ✅ Estrategia `PROCESADOR_IA` (`LlmExtractorStrategy`) registrada en `NodeStrategyFactory`, con freno de emergencia por ejecución y simulación de coste cero (`MockLlmProvider`). Solo `MOCK` y `GEMINI` tienen cliente; `ANTHROPIC` y `OPENAI` se rechazan en ejecución con `ERR_LLM_PROVIDER_UNSUPPORTED` en vez de caer al simulador.
- ✅ Cliente HTTP saliente compartido `HttpClientService` (`@core/http/`, exportado por `HttpCoreModule`): timeout, backoff exponencial y traducción de errores de Axios a `NodeErrorDetail`. Es el primer consumidor de `@nestjs/axios`.
- ⏳ **Pendiente:** estrategia `ESCUDO_POST_IA` — declarada en el enum `NodeType` pero sin `INodeStrategy` registrada en `NodeStrategyFactory`. Es el validador natural de la salida de `PROCESADOR_IA`.
- ⏳ **Pendiente:** nodo `DESTINO_ACENS` — existe como fila de catálogo en PostgreSQL pero sin valor de enum ni estrategia (`GET /api/nodos` lo marca `implemented: false`).
- 📄 Detalle de contratos/DTOs por implementar: `PLAN.md`. Bitácora de desarrollo paso a paso: `Walkthrough.md`.

---

## 🧭 Índice de Configuración Modular

### 📜 Reglas del Proyecto (`.claude/rules/`)

* `architecture-patterns.md`: Ciclo de vida del motor FSM, patrón Strategy (`INodeStrategy`), contrato inmutable de `StatePayloadContext` y librerías externas por tipo de nodo.
* `code-conventions.md`: Idioma de identificadores, estándares TypeScript/Vue y orden obligatorio de archivos.
* `frontend-architecture.md`: Capa de servicios HTTP, flujo Componente → Store → Servicio y patrón Layouts vs Componentes.
* `frontend-quasar.md`: Sistema de diseño y tokens `--pd-*`, tríada modular de nodos del pipeline y filosofía Poka-Yoke en Vue 3 + Quasar.
* `git-workflow.md`: Convención de ramas (`feat/`, `fix/`) y Conventional Commits.
* `security-and-scope.md`: Aislamiento de PostgreSQL en Docker, validación de subred local, autenticación OTP y límites de alcance (*scope*).
* `system-prompt.md`: Identidad del asistente ("Proto-Do Tech Lead"), regla de aclaración proactiva y artefactos obligatorios (`PLAN.md`, `Walkthrough.md`).
* `testing-standards.md`: Patrón AAA, dobles de prueba y casos límite obligatorios en Jest.

### 🧠 Habilidades Especializadas (`.claude/skills/`)

* `documentacion-codigo.md`: Estándar TSDoc y separadores visuales por capas.
* `diagnostico-fsm-logs.md`: Cruce de errores entre PostgreSQL y logs físicos en disco.
* `diagnostico-entorno-linux.md`: Resolución de permisos, puertos y conflictos en Apache/NPM.
* `diagnostico-docker-postgres.md`: Conflicto de puerto 5432, permisos de volumen `pgdata/` y reinicialización limpia del contenedor.

### ⚡ Comandos Rápidos (`.claude/commands/`)

* `/nueva-rama <nombre>`: Actualiza `main` y crea rama limpia `feat/<nombre>`.
* `/hacer-fix <desc>`: Ejecuta tests y sube commit `fix(<scope>)` a la rama activa.
* `/subir-main`: Corre tests, fusiona con `--no-ff` y publica en `main`.
* `/nuevo-nodo <nombre>`: Genera la estrategia `INodeStrategy` y su registro.
* `/crear-test <ruta>`: Genera suite en Jest con patrón AAA y mocks.
* `/siguiente-paso`: Analiza el estado del repo y presenta la próxima tarea.
* `/docker-db <up|down|restart|status|reset>`: Gestiona el ciclo de vida del contenedor PostgreSQL.

---

## 🐳 Docker: Base de Datos PostgreSQL

- **Ciclo de vida:**

| Acción | Comando |
| --- | --- |
| Iniciar en segundo plano | `docker compose up -d` |
| Detener contenedor | `docker compose down` |
| Ver estado | `docker compose ps` |
| Seguir logs | `docker compose logs -f postgres` |
| Reinicializar limpio (⚠️ borra datos) | `docker compose down -v && docker compose up -d` |

- **Conexión MCP:** `postgresql://${DB_USER}:${DB_PASSWORD}@localhost:${DB_PORT}/${DB_NAME}` (puerto real por defecto: `5433`, ver `docker-compose.yml` y `backend/.env.example`) — nunca credenciales literales, ver `rules/security-and-scope.md §0`.
- **Regla clave:** el backend nunca debe depender de una instalación nativa de PostgreSQL ni de sockets fuera del contenedor — ver `rules/security-and-scope.md`.

---

## 🛠️ Comandos de Desarrollo Frecuentes

| Ámbito | Acción | Comando |
| --- | --- | --- |
| **Backend** | Iniciar en desarrollo | `cd backend && npm run start:dev` |
| **Backend** | Ejecutar pruebas | `cd backend && npm test` |
| **Frontend** | Iniciar servidor Vite | `cd frontend && npm run dev` |
| **Frontend** | Compilar producción | `cd frontend && npm run build` |