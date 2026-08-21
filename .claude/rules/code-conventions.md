# Reglas de Convenciones de Código y Nomenclatura

## 1. Regla de Idiomas
- **Identificadores de Código:** Todo el código fuente debe escribirse en **inglés**:
  - Variables, métodos, funciones y propiedades: `camelCase` (ej. `activeCursor`, `executeNode()`).
  - Clases, interfaces, tipos y enums: `PascalCase` (ej. `FsmEngineService`, `StatePayloadContext`).
  - Constantes globales: `UPPER_SNAKE_CASE` (ej. `MAX_RETRY_ATTEMPTS`).
- **Comentarios y Documentación:** Todos los comentarios en código (`//`, `/* */`, JSDoc) y archivos de documentación (`.md`) deben redactarse en **español**.
- **Mensajes de Commit:** La descripción después del prefijo convencional debe redactarse en **español**:
  - Estructura: `tipo(alcance): descripción en español`
  - Ejemplo: `feat(websockets): agregar conexion inicial con socket.io`

---

## 2. Estándares de TypeScript (Backend NestJS)
- **Modo Estricto:** Prohibido el uso de `any` implícito. Todo tipo de entrada y salida debe estar declarado explícitamente.
- **Validación de Entradas:** Toda petición HTTP debe validarse mediante DTOs con decoradores de `class-validator` y `class-transformer`.
- **Cláusulas de Guarda (Guard Clauses):** Validar precondiciones al inicio de cada función y retornar anticipadamente para evitar anidación excesiva de `if/else`.
- **Separación de Responsabilidades:** 
  - Los controladores (`*.controller.ts`) únicamente reciben peticiones, aplican DTOs y delegan al servicio.
  - La lógica de negocio reside exclusivamente en los servicios (`*.service.ts`) o estrategias (`*.strategy.ts`).
  - El acceso a base de datos se limita a los repositorios TypeORM (`*.repository.ts` o repositorios inyectados).

---

## 3. Estándares de Frontend (Vue 3 + Quasar)
- **Componentes:** Usar siempre la sintaxis `<script setup lang="ts">` de Vue 3 Composition API.
- **Componentes Nativos:** Priorizar componentes oficiales de Quasar (`QStepper`, `QSelect`, `QTimeline`, `QBadge`) antes de crear soluciones personalizadas.
- **Feedback Visual:** Utilizar los plugins nativos de Quasar (`$q.notify`, `$q.loading`, `$q.dialog`) para interactuar con el usuario.
- **Manejo de Estado:** El estado global compartido debe gestionarse a través de stores de Pinia tipados.

---

## 4. Estructura y Orden Obligatorio en Archivos (ES6+ / TypeScript)

Todo archivo de código (`.ts`, `.vue`) debe seguir estrictamente este orden de arriba hacia abajo:

1. 📦 **Importaciones (Imports):**
   - Primero dependencias externas / librerías (`node_modules`, NestJS, Vue).
   - Segundo módulos internos del proyecto (servicios, entidades, DTOs).
   - Tercero tipos e interfaces (`import type { ... }`).

2. 🏷️ **Tipos, Interfaces y Constantes Locales:**
   - Declaración de `type` e `interface` específicos del archivo.
   - Constantes de configuración y variables globales del módulo (`UPPER_SNAKE_CASE` o `camelCase`).

3. ⚙️ **Definición de Clases, Funciones o Componentes:**
   - Declaración de la clase (`export class ...`), función o `<script setup>`.
   - Implementación de métodos, propiedades y lógica interna.

4. 🚀 **Suscripciones, Event Listeners y Exportaciones Finales:**
   - Registro de manejadores de eventos, listeners o exportaciones por defecto si aplican.

---

## 5. Estándares de Sintaxis Moderna (ES6+)

- 🚫 **Sin `var`:** Usar exclusivamente `const` por defecto, y `let` únicamente cuando la reasignación sea indispensable.
- 🏹 **Funciones Flecha:** Usar `() => {}` para funciones anónimas, callbacks y composición.
- 📦 **Desestructuración y Propagación:**
  - Uso de desestructuración de objetos y arrays: `const { id, name } = payload`.
  - Operador spread (`...`) para clonado e inmutabilidad de objetos y contextos.
- 🔗 **Operadores Modernos:**
  - Encadenamiento opcional (`?.`) para navegación segura de propiedades.
  - Coalescencia nula (`??`) en lugar de `||` para valores por defecto.
- ⏳ **Manejo Asíncrono:** Usar siempre `async / await` en lugar de encadenamiento con `.then()` / `.catch()`.

---

## 6. Resolución de Rutas e Importaciones (Path Aliasing)

- 🚫 **Prohibidas las rutas relativas profundas:** No usar `../../` con más de un nivel de profundidad.
- 🎯 **Uso obligatorio de Alias Absolutos:**
  - **Backend (NestJS via `tsconfig.json`):**
    - `@core/*` ➔ Componentes centrales (`FsmEngineService`, `StatePayloadContext`, base).
    - `@modules/*` ➔ Módulos funcionales (`auth`, `nodes`, `templates`, `logs`).
    - `@strategies/*` ➔ Estrategias polimórficas de nodos (`INodeStrategy`).
    - `@common/*` ➔ DTOs compartidos, guardas, filtros y utilidades.
  - **Frontend (Quasar via `tsconfig.json` / Vite):**
    - `@components/*` ➔ Componentes Vue reutilizables.
    - `@stores/*` ➔ Stores globales de Pinia.
    - `@boot/*` ➔ Archivos de inicialización (Axios, Socket.io).
    - `@types/*` ➔ Definiciones de tipos e interfaces TypeScript.