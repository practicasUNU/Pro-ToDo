# 🛠️ REGLAS ESTRICTAS DE ARQUITECTURA FRONTEND (VUE 3 + QUASAR) - PROTO-DO

Actúas como un Arquitecto Frontend experto. Al generar o refactorizar código para el frontend de Proto-Do, debes cumplir obligatoriamente los siguientes contratos técnicos:

## 1. Stack y Paradigma Base
- **Framework:** Vue 3 (Composition API estricta) + Quasar Framework (Vite).
- **Tipado:** TypeScript estricto. Prohibido el uso de `any` implícito y la Options API. Todas las interfaces DTO del frontend deben ser réplicas exactas de las exportadas por los controladores NestJS.
- **Sintaxis de Componente:** Usar exclusivamente `<script setup lang="ts">`.

## 2. Sistema de Diseño y Tokens (Modo Claro/Oscuro)

- **Identidad de marca:** paleta institucional UNUWARE (azules corporativos sobre neutros estructurados). El azul de marca y los acentos se mantienen idénticos entre modos para preservar consistencia identitaria.
- **Modo por defecto:** Dark mode first. La app inicia en oscuro (`$q.dark = true` por defecto en `quasar.config.ts`), con toggle a modo claro persistido (p. ej. en `useSessionStore` o `localStorage`).
- **Aislamiento de Color:** Prohibido *hardcodear* colores hexadecimales en la lógica de los componentes.
- **Variables CSS:** Custom Properties definidas en `app.scss`, mapeadas 1:1 a la paleta UNUWARE. La lista es cerrada — cualquier color nuevo se añade primero como token, nunca inline:

  | Token | Modo Oscuro | Modo Claro | Uso y Aplicación en Quasar |
  |---|---|---|---|
  | `--pd-page-bg` | `#0D0F26` | `#FAFBFF` | Fondo principal de la ventana / `<q-page>` |
  | `--pd-card-bg` | `#12142E` | `#EEF1FA` | `QCard`, `QDrawer` (Sidebar), `QStepper` |
  | `--pd-surface-muted` | `#161A3D` | `#E4EAFB` | Paneles secundarios, cabeceras de tabla, contenedores de input |
  | `--pd-primary` | `#2C4FC7` | `#2C4FC7` | Inicio de degradado de cabecera y botones primarios |
  | `--pd-primary-light` | `#4E74E8` | `#4E74E8` | Fin del degradado corporativo y foco activo |
  | `--pd-panel-solid` | `#3A5CE0` | `#3A5CE0` | Tarjetas de estado institucional, CTAs destacadas |
  | `--pd-accent` | `#5B8CE8` | `#5B8CE8` | Micro-interacciones, hover de superficies grandes, chips de variables |
  | `--pd-accent-text` | `#5B8CE8` | `#3D6BD9` | Enlaces y texto interactivo (cumple contraste AA en modo claro) |
  | `--pd-text-primary` | `#FFFFFF` | `#12142E` | Titulares (`H1`, `H2`), labels destacados, texto sobre azul |
  | `--pd-text-secondary` | `#B8C0DE` | `#4A4F6B` | Párrafos de cuerpo, metadatos |
  | `--pd-border` | `#B8C0DE` (40%) | `#D3D8EE` | Bordes de inputs, separadores, divisores |
  | `--pd-disabled-bg` | `#5B5B66` | `#C7C9D6` | Fondo de botones/inputs deshabilitados |
  | `--pd-disabled-text` | `#9CA0B5` | `#7A7E92` | Texto sobre `--pd-disabled-bg` (nunca el mismo tono que el fondo) |
  | `--pd-negative` | `#E74C3C` | `#D93A2B` | Asterisco obligatorio `*`, modales de borrado, severidad URGENTE |
  | `--pd-warning` | `#F59E0B` | `#F59E0B` | Severidad GRAVE, estados en pausa |
  | `--pd-positive` | `#10B981` | `#10B981` | Transiciones exitosas, estados operativos |
  | `--pd-shell-bg` / `--pd-shell-text` | `#12142E` / `#FFFFFF` | *(idéntico)* | `QHeader` / `QDrawer` — fijos, **no** conmutan con el tema |

- **Regla de contraste:** `--pd-accent` (`#5B8CE8`) tiene un ratio de contraste insuficiente (~3:1) para texto pequeño sobre fondos claros (WCAG AA). Se reserva para hover de superficies grandes, iconos e interacciones. Para enlaces de texto y elementos interactivos en modo claro, usar siempre `--pd-accent-text`.
- **Modo claro:** a diferencia de un esquema "papel blanco puro", las superficies elevadas usan `--pd-card-bg` (`#EEF1FA`) y `--pd-surface-muted` (`#E4EAFB`) como fondos tintados de marca — no solo distinción por borde. Prohibido usar las clases `bg-grey-N` / `text-grey-N` de Quasar como sustituto de un token.
- **Header:** degradado horizontal obligatorio `linear-gradient(90deg, var(--pd-primary) 0%, var(--pd-primary-light) 100%)`, isotipo/logotipo en `--pd-text-primary` (blanco) alineado a la izquierda. Nunca color sólido.
- **Clases Utilitarias:** `.pd-page` en el contenedor principal `<q-page>`, `.pd-card` en superficies elevadas. Para el Módulo de Trazabilidad, las filas de `<q-table>` usan `.row-urgente`, `.row-grave` y `.row-exitoso` según el estado, y la tabla lleva `.pd-table`. La franja superior de 3px por severidad se aplica con `.pd-card--accent` + un modificador (`.pd-accent-exitoso` / `-leve` / `-grave` / `-urgente`), nunca con un `style` inline.
- **Tipografía:** tres familias, todas *self-hosted* vía `@fontsource` e importadas en `src/App.vue` (prohibido enlazar Google Fonts u otro CDN — el frontend no hace peticiones a terceros):
  - `.pd-h1` / `.pd-h2`: **Poppins** (fallback `Montserrat`), 600 (SemiBold) / 700 (Bold), tracking ajustado — encabezados de vista, pasos del Wizard, títulos de modal.
  - Cuerpo de texto (default global, `$typography-font-family`): **Inter** (fallback `Roboto`), 400 (Regular) / 500 (Medium) — formularios, descripciones de pasos, tablas de trazabilidad.
  - Navegación / menú: Poppins 500 (Medium), mayúsculas, letter-spacing amplio.
  - Labels de formulario: Inter 700 (Bold), escala compacta (13px).
  - `.pd-mono`: **JetBrains Mono** (fallback `Fira Code`), 500 (Medium) 13px — para valores técnicos: `id_flujo`, namespaces/rutas interpoladas (`{{nodo.campo}}`), payload JSON, rutas `.log`.
  - Prohibido declarar `font-family` inline en un componente. La jerarquía se aplica con `.pd-h1`, `.pd-h2`, `.pd-subtitle`, `.pd-label`, no con `text-h*` de Quasar.
- **Radios canónicos:** card/panel 8px (`$generic-border-radius`), botón 6px (`$button-border-radius`), `QDialog` 10px, badge de severidad pill vía `.pd-badge`. Prohibido redefinir `border-radius` por componente.
- **Botones (`QBtn`):**
  - Primario (activo): degradado `linear-gradient(90deg, var(--pd-primary) 0%, var(--pd-primary-light) 100%)`, tipografía blanca bold, radio 6px, ícono de flecha diagonal (`↗`) al lateral derecho como micro-interacción.
  - Deshabilitado: fondo `--pd-disabled-bg`, texto `--pd-disabled-text` (nunca el mismo tono que el fondo), sin degradado ni hover.
  - Crítico / borrado seguro: rojo `--pd-negative`, sujeto a la cuenta regresiva de 5 segundos (ver sección 4, Acciones Críticas).
- **Formularios (`QForm`, `QInput`, `QSelect`):**
  - Campos: fondo `--pd-card-bg` (o transparente en oscuro), borde `--pd-border`, placeholder en `--pd-text-secondary`.
  - Obligatorios: asterisco `*` en `--pd-negative`.
  - Selectores deterministas (`QSelect` Poka-Yoke): chips en `--pd-accent` sobre `--pd-surface-muted`, sin entrada de texto libre (ver sección 4).
  - Enlaces dentro de formularios (ej. "Política de Privacidad"): usar `--pd-accent-text`.
  - Checkboxes: estructura cuadrada, borde nítido, sin relleno hasta activarse con `--pd-primary`.
- **Iconografía:** trazo lineal (*outline*, fino), sin rellenos pesados. Contenedores de icono en círculo con fondo claro y borde punteado, glifo en `--pd-primary` / `--pd-panel-solid`. Indicadores de acción con flecha diagonal (`↗`) en botones y enlaces externos. Botón flotante de scroll-top: circular, borde `--pd-primary`, flecha hacia arriba.
- **Tarjetas (`QCard`):**
  - Estándar: fondo `--pd-card-bg`, bordes sutiles (`--pd-border`), elevación plana.
  - Estado / información sólida: relleno sólido `--pd-panel-solid`, tipografía blanca, iconografía en círculos punteados.
  - Detalles ornamentales opcionales: patrones sutiles (dot grids, círculos tenues) como marca de agua de baja opacidad.
- **Layout:** El `QHeader` (60px) y `QDrawer` (220px) se mantienen permanentemente oscuros (`--pd-shell-bg`) por identidad de marca, con independencia de la variable `$q.dark`; consumen los tokens `--pd-shell-*` y jamás los `--pd-text-*`.

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
