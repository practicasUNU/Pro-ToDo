# 🛠️ REGLAS ESTRICTAS DE ARQUITECTURA FRONTEND (VUE 3 + QUASAR) - PROTO-DO

Actúas como un Arquitecto Frontend experto. Al generar o refactorizar código para el frontend de Proto-Do, debes cumplir obligatoriamente los siguientes contratos técnicos:

## 1. Stack y Paradigma Base
- **Framework:** Vue 3 (Composition API estricta) + Quasar Framework (Vite).
- **Tipado:** TypeScript estricto. Prohibido el uso de `any` implícito y la Options API. Todas las interfaces DTO del frontend deben ser réplicas exactas de las exportadas por los controladores NestJS.
- **Sintaxis de Componente:** Usar exclusivamente `<script setup lang="ts">`.

## 2. Sistema de Diseño y Tokens (Modo Claro/Oscuro)
- **Aislamiento de Color:** Prohibido *hardcodear* colores hexadecimales en la lógica de los componentes.
- **Variables CSS:** Utilizar estrictamente las *Custom Properties* definidas en `app.scss`. La lista es cerrada — cualquier color nuevo se añade primero como token, nunca inline:

  | Grupo | Tokens | Conmuta con el tema |
  |---|---|---|
  | Superficies | `--pd-page-bg`, `--pd-card-bg`, `--pd-surface-muted`, `--pd-input-bg` | Sí (`:root` / `body.body--dark`) |
  | Bordes | `--pd-border`, `--pd-border-soft` | Sí |
  | Texto | `--pd-text-primary`, `--pd-text-secondary`, `--pd-text-disabled` | Sí |
  | Marca | `--pd-primary-tint` | Sí |
  | Severidad (fila) | `--pd-row-urgente`, `--pd-row-grave` | Sí |
  | Shell | `--pd-shell-bg`, `--pd-shell-alt`, `--pd-shell-hover`, `--pd-shell-text`, `--pd-shell-text-secondary` | **No** — idénticos en ambos modos |

- **Modo claro = papel blanco:** el fondo de página es `#FFFFFF` y las cards **no** se distinguen por color de fondo sino por `--pd-border`. `--pd-surface-muted` es el **único** gris admitido en modo claro, y solo para zonas subordinadas (`thead`, hover de fila, bloques de código). Prohibido usar las clases `bg-grey-N` / `text-grey-N` de Quasar como sustituto de un token.
- **Clases Utilitarias:** Aplicar `.pd-page` al contenedor principal `<q-page>` y `.pd-card` a las superficies elevadas. Para el Módulo de Trazabilidad, las filas de `<q-table>` usan obligatoriamente `.row-urgente` y `.row-grave` según el estado, y la tabla lleva `.pd-table`. La franja superior de 3px por severidad se aplica con `.pd-card--accent` + un modificador (`.pd-accent-exitoso` / `-leve` / `-grave` / `-urgente`), nunca con un `style` inline.
- **Tipografía:** dos familias, ambas *self-hosted* vía `@fontsource` e importadas en `src/App.vue` (prohibido enlazar Google Fonts u otro CDN — el frontend no hace peticiones a terceros). Prohibido declarar `font-family` en un componente: usar `$typography-font-family` (Inter, ya es el default global) o la clase `.pd-mono` para valores técnicos (`id_flujo`, nombres de plantilla/prompt, payload JSON, rutas `.log`). La jerarquía se aplica con `.pd-h1`, `.pd-h2`, `.pd-subtitle`, `.pd-label`, no con `text-h*` de Quasar.
- **Radios canónicos:** card/panel 8px (`$generic-border-radius`), botón 6px (`$button-border-radius`), `QDialog` 10px y badge de severidad pill vía `.pd-badge`. Prohibido redefinir `border-radius` por componente.
- **Layout:** El `QHeader` (60px) y `QDrawer` (220px) se mantienen permanentemente oscuros (`bg-dark`) por identidad de marca, con independencia de la variable `$q.dark`; consumen los tokens `--pd-shell-*` y jamás los `--pd-text-*`.

## 3. Arquitectura de Estado (Pinia) y WebSockets
- **Mapeo de Stores:**
  - `useSessionStore`: Administra JWT, `user`, y estado `otpVerified`.
  - `useFlujoDraftStore`: Controla la reactividad del Wizard (Vista 3+4). Mantiene el DTO temporal (Trigger, Extracción, IA, Mapeo, Destino) con autosave por cada paso.
  - `useExecutionStore`: Debe inyectar el cliente de Socket.io al montarse. Escucha el `NotificationGateway` del backend (salas `flow_${id}`) y parchea vía `$patch` el `pasoActual` (Cursor FSM) y el estado global.
- **Inmutabilidad:** El payload recibido desde el backend (`StatePayloadContext`) debe tratarse como inmutable en la UI.

## 4. Filosofía Poka-Yoke (Prevención de Errores UI)
- **Mapeo Determinista (Vista 4):** El componente de mapeo de plantillas DEBE usar un `<q-select>` cerrado. Está estrictamente prohibido permitir al usuario escribir *strings* libres para las variables. Solo se pueden seleccionar claves expuestas previamente por los *namespaces* del contexto (ej. `parsed_email`, `scraped_web`).
- **Wizard Stepper:** El botón "Siguiente" del `<q-stepper>` permanece inhabilitado (`:disable="true"`) hasta que el DTO del paso actual pase la validación del esquema de frontend.
- **Acciones Críticas:** Toda petición de borrado o desactivación de flujos/usuarios invoca un `<q-dialog>` encapsulado con un temporizador forzado de 5 segundos antes de habilitar el evento `@ok`.
- **Canvas Read-Only:** La vista de topología (`/flujos/:id`) renderiza nodos estáticos. No incluir librerías de *drag & drop* ni inyectar eventos de mutación.

## 5. Orden Estricto de Archivos SFC (.vue)
1. `<script setup lang="ts">`
2. `imports` ordenados: vue -> quasar -> stores -> components -> types.
3. Declaración de `props` y `emits`.
4. Variables reactivas (`ref`, `computed`) y hooks.
5. Funciones lógicas asíncronas (llamadas a endpoints).
6. `<template>`
7. `<style scoped lang="scss">`