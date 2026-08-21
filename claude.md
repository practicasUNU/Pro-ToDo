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
└── .claude/            # Configuración modular del asistente
    ├── rules/          # Reglas no negociables de arquitectura y Git
    ├── skills/         # Procedimientos técnicos detallados
    └── commands/       # Comandos personalizados (/slash-commands)
```

---

## 🧭 Índice de Configuración Modular

### 📜 Reglas del Proyecto (`.claude/rules/`)

* `architecture-patterns.md`: Ciclo de vida del motor FSM, patrón Strategy (`INodeStrategy`) y contrato inmutable de `StatePayloadContext`.
* `code-conventions.md`: Idioma de identificadores, estándares TypeScript/Vue y orden obligatorio de archivos.
* `git-workflow.md`: Convención de ramas (`feat/`, `fix/`) y Conventional Commits.
* `security-and-scope.md`: Validación de subred local, autenticación OTP y límites de alcance (*scope*).
* `testing-standards.md`: Patrón AAA, dobles de prueba y casos límite obligatorios en Jest.

### 🧠 Habilidades Especializadas (`.claude/skills/`)

* `documentacion-codigo.md`: Estándar TSDoc y separadores visuales por capas.
* `diagnostico-fsm-logs.md`: Cruce de errores entre PostgreSQL y logs físicos en disco.
* `diagnostico-entorno-linux.md`: Resolución de permisos, puertos y conflictos en Apache/NPM.

### ⚡ Comandos Rápidos (`.claude/commands/`)

* `/nueva-rama <nombre>`: Actualiza `main` y crea rama limpia `feat/<nombre>`.
* `/hacer-fix <desc>`: Ejecuta tests y sube commit `fix(<scope>)` a la rama activa.
* `/subir-main`: Corre tests, fusiona con `--no-ff` y publica en `main`.
* `/nuevo-nodo <nombre>`: Genera la estrategia `INodeStrategy` y su registro.
* `/crear-test <ruta>`: Genera suite en Jest con patrón AAA y mocks.
* `/siguiente-paso`: Analiza el estado del repo y presenta la próxima tarea.

---

## 🛠️ Comandos de Desarrollo Frecuentes

| Ámbito | Acción | Comando |
| --- | --- | --- |
| **Backend** | Iniciar en desarrollo | `cd backend && npm run start:dev` |
| **Backend** | Ejecutar pruebas | `cd backend && npm test` |
| **Frontend** | Iniciar servidor Vite | `cd frontend && npm run dev` |
| **Frontend** | Compilar producción | `cd frontend && npm run build` |