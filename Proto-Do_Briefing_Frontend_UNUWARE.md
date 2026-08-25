# Briefing Técnico y Sistema de Diseño Frontend
## Proyecto Proto-Do — UNUWARE (entorno Madrid+D)

> **Actualización de esta versión:** con el `.docx` de Ingeniería del Software y los dos logos ya en mano, esto deja de ser una propuesta genérica. Cambios de fondo respecto a la primera versión:
> - La paleta ya no es una invención razonada: es el azul real del logo (`#2E75B6`) más los colores que tu propio equipo ya usó en los wireframes que venían dentro del `.docx` (navbar casi negro, rojo/naranja/verde de severidad).
> - El wizard tiene **5 pasos reales** (Trigger → Extraer Variables → IA → Mapeo → Destino), no los 4 genéricos que asumí antes — y el "mapeo" (Vista 4) va **embebido como Paso 4 del wizard**, no como vista separada.
> - El `.docx` trae dos casos de uso que no estaban en el encargo de 6 vistas: **CU-06 (Gestión de Plantillas HTML)** y **CU-07 (Administrar Prompts e IA)**. Los añado como Vista 7 y Vista 8 porque, sin ellos, los pasos "IA" y "Mapeo" del wizard no tendrían de dónde seleccionar plantilla/prompt.
> - Cada vista trae ahora un mockup a color (SVG) coherente con los wireframes que ya existían en el documento, no solo tablas de especificación.
> - **Nuevo en esta revisión:** modo claro y modo oscuro reales, implementados con el plugin `Dark` de Quasar (no con `prefers-color-scheme` a pelo) — ver Sección 1.5 y Sección 4.4.

---

> ### ⚠️ Sincronización con la implementación real (rama `feat/CRUD-Users`)
>
> Este documento se redactó antes de implementar. Los siguientes puntos se han **corregido en el texto** para que coincida con el código que hay en `frontend/`; se listan aquí para que la desviación quede trazable:
>
> | Punto | Briefing original | Implementación real | Motivo |
> |---|---|---|---|
> | Fondo de página (claro) | `#F2F2F3` | **`#FFFFFF`** | Decisión de producto: el gris muestreado del wireframe apagaba la interfaz. Al quedar página y card en blanco, la separación pasa a ser el **borde**, y se añade `--pd-surface-muted` (`#F6F7F9`) como único gris de apoyo (`thead`, hover, bloques de código). |
> | `$dark-page` | §1.1 lo asignaba a `#262626` mientras §1.5 daba `#141516` para el fondo oscuro — **contradicción** | `$dark-page: #141516` | En Quasar `$dark-page` **es** el fondo de página en modo oscuro. `#262626` era en realidad el "shell alterno" (hover/activo de nav), ahora token propio `--pd-shell-alt`. |
> | Estado del tema | `composables/useThemeMode.js` + `boot/theme.js` | **`stores/theme.store.ts`** (Setup Store de Pinia, auto-inicializado) | El composable nunca se llegó a escribir. Centralizar en Pinia cumple la regla de proyecto de estado global tipado y elimina el boot file: `initTheme()` corre en el cuerpo del setup store, antes del primer pintado. |
> | Tipografía | Inter + JetBrains Mono, sin mecanismo definido | `@fontsource-variable/*` importado en `src/App.vue` | *Self-hosted*: cero peticiones a Google Fonts, coherente con el aislamiento perimetral del proyecto. |
> | Extensión de archivos | `.js` en `stores/`, `boot/`, `services/` | `.ts` en todo `src/` | Regla de proyecto: TypeScript estricto, prohibida la Options API. |
> | `assets/` y `code/` | Referenciados a lo largo del documento | **No existen en el repo** | Los mockups SVG y el código de ejemplo nunca se versionaron. Las tablas de este documento son la única fuente de verdad; el isotipo real vive en `frontend/src/assets/unuware-logo-isotype.svg`. |

---

## 0. Identidad de marca (fuente real)

| Activo | Origen | Uso |
|---|---|---|
| `assets/unuware-logo-wordmark.png` | Logo oficial proporcionado | Wordmark a color sobre fondos claros — pantallas de marketing, encabezados de documentos |
| `assets/unuware-logo-isotype.png` | Logo oficial proporcionado | Isotipo "U" — favicon, avatar de marca, rail de navegación colapsado |

<img src="assets/unuware-logo-wordmark.png" alt="Logotipo UNUWARE" height="60"/>　　<img src="assets/unuware-logo-isotype.png" alt="Isotipo UNUWARE" height="60"/>

Del wordmark se extrajo por muestreo de píxel el azul de marca: **`#2E75B6`**. Es el único valor de marca que llega confirmado — el resto de la paleta (Sección 1) se completó a partir de los colores que ya aparecían en los wireframes reales incluidos en el `.docx` (pantalla de login y dashboard de trazabilidad), no inventados desde cero.

---

## 1. Sistema de Diseño e Identidad Visual (Design Tokens)

### 1.1 Paleta cromática

Dirección visual: **monocromo casi-negro + azul de marca reservado + tríada semántica**. Esto no es una elección estética mía — es lo que ya estaba en los dos wireframes con color real del `.docx` (login y trazabilidad): fondo de shell casi negro (`#1E1E1E`), botones en gris oscuro neutro (no azul), y el azul de marca reservado casi exclusivamente para el logo, enlaces y estados de selección. Encaja bien con una herramienta de cumplimiento ENS: seria, sin ruido decorativo, con color reservado para lo que de verdad importa (severidad de alertas).

| Token | Hex | RGB | Variable SCSS Quasar | Uso | Origen |
|---|---|---|---|---|---|
| Brand / Primario | `#2E75B6` | `46, 117, 182` | `$primary` | Logo, enlaces, foco, estado seleccionado, barra superior de card | Muestreado del logo real |
| Brand tint (fondo suave) | `#EAF2FA` | `234, 242, 250` | `$primary-tint` (custom) | Fondos de chip/badge activos, fila seleccionada | Derivado |
| Shell (navbar + sidebar) | `#1E1E1E` | `30, 30, 30` | `$dark` / `--pd-shell-bg` | `QHeader`, `QDrawer`, panel de branding en Auth | Muestreado del wireframe de login/trazabilidad |
| Shell alterno (hover/activo) | `#262626` | `38, 38, 38` | `--pd-shell-alt` | Ítem de nav activo, hover sobre shell | Derivado |
| Botón de acción neutro | `#262626` → hover `#3A3A3A` | — | `--pd-shell-alt` → `--pd-shell-hover` | CTA primaria ("Enviar código", "Guardar", "Siguiente") | Muestreado del wireframe de login |
| Fondo de página | **`#FFFFFF`** | — | `--pd-page-bg` | Canvas general de `MainLayout` | Decisión de producto (ver nota de sincronización) |
| Superficie Card | `#FFFFFF` | — | `--pd-card-bg` | `QCard`, paneles, drawers — se distingue del fondo por **borde**, no por color | — |
| Superficie subordinada | `#F6F7F9` | `246, 247, 249` | `--pd-surface-muted` | `thead` de tabla, hover de fila, bloques de código. **Único gris admitido en modo claro** | Derivado |
| Borde / divisor | `#E3E5E8` | — | `--pd-border` | Bordes de card, separadores de tabla | — |
| Texto primario | `#1A1A1A` | — | — | Cuerpo, títulos | — |
| Texto secundario | `#6B6F76` | — | — | Subtítulos, metadatos | — |
| Positive (Éxito / EXITOSO) | `#2E7D32` | `46, 125, 50` | `$positive` | Estado `EXITOSO`, confirmaciones | Muestreado del wireframe de trazabilidad |
| Warning (Alerta GRAVE) | `#D4860A` | `212, 134, 10` | `$warning` | Estado `PAUSADO` / alerta GRAVE | Muestreado del wireframe de trazabilidad |
| Negative (Alerta URGENTE) | `#C0392B` | `192, 57, 43` | `$negative` | Estado `FALLIDO` / alerta URGENTE | Muestreado del wireframe de trazabilidad |
| Info (Alerta LEVE) | `#4E7796` | `78, 119, 150` | `$info` | Alerta LEVE (no bloqueante, el flujo sigue en `EXITOSO`) | Derivado del azul de marca, desaturado para no competir con `$primary` |

> Nota de fidelidad: en el wireframe de login el botón "Enviar Código" es gris oscuro neutro, **no azul** — se respeta esa decisión ya tomada en vez de "corregirla" hacia un azul corporativo genérico.

### 1.2 Tipografía y jerarquía

Los wireframes reales usan una única familia sans-serif de tipo grotesca (sin serifa, sin display diferenciado) tanto en títulos como en cuerpo — se mantiene esa unicidad en vez de introducir una segunda familia de "display" que no está en el material de referencia.

| Rol | Familia | Fallback | Peso(s) |
|---|---|---|---|
| UI (headings + body) | **Inter** | `Segoe UI, Roboto, Helvetica, Arial, sans-serif` | 400 (cuerpo), 500 (labels), 600–700 (títulos) |
| Monospace (JSON, `.log`, nombres técnicos de plantilla/prompt) | **JetBrains Mono** | `Consolas, ui-monospace, monospace` | 400 (valores), 500 (claves) |

**Escala tipográfica**

| Estilo | Tamaño | Line-height | Peso | Uso |
|---|---|---|---|---|
| H1 | 20–21px | 28px | 700 | Título de vista |
| H2 | 16px | 24px | 700 | Título de paso / sección de card |
| Subtitle | 12.5px | 18px | 400 | Subtítulo descriptivo bajo H1/H2 |
| Body | 12–13px | 18px | 400–500 | Texto de interfaz, celdas de tabla |
| Label / Caption | 10–10.5px | 14px | 700 | Labels de campo, encabezados de tabla, badges |
| Mono | 12–12.5px | 18px | 400–500 | `id_flujo`, nombres de plantilla/prompt, payload |

### 1.3 Iconografía y componentes base

- **Set de iconos:** Material Symbols (Outlined) — set nativo de Quasar, sin dependencias extra.
- **Iconografía de dominio (custom SVG):** los mockups de esta sección ya incluyen un set mínimo propio para los 5 tipos de nodo visibles (sobre — trigger, llaves `{}` — extracción, rayo — IA, `</>` — mapeo/plantilla, globo — destino HTTP), consistente con el estilo de trazo 1.5px usado en el resto de iconos.
- **Bordes:** `QCard`/paneles 8px, `QBtn` 6px, `QChip`/badge de severidad pill (999px), `QDialog` 10px.
- **Barra superior de card:** franja de 3–4px en la parte superior de cards clave (login, KPIs de trazabilidad, nodos del canvas), coloreada según categoría/severidad — patrón ya usado en el wireframe original y que se conserva.
- **Grid/espaciado:** unidad base 4px. `q-gutter-md` (16px) en formularios; `q-col-gutter-lg` (24px) entre bloques de página.

### 1.4 Tratamiento del logotipo

| Contexto | Tratamiento |
|---|---|
| `QHeader` (navbar) | Isotipo (24px, badge azul redondeado) + wordmark en mayúsculas espaciadas junto a él, alineado a la izquierda tras el botón de hamburguesa |
| `AuthLayout` (panel oscuro) | Isotipo (56px) centrado + wordmark (26px) + tagline "AUTOMATIZACIÓN MODULAR" en versalitas espaciadas, sobre fondo `#1E1E1E` con patrón sutil de puntos |
| Favicon / avatar colapsado | Solo isotipo, sobre fondo de marca `#2E75B6`, esquinas redondeadas ~22% |
| Sidebar colapsado (rail) | Solo isotipo, 24px, centrado |

> El isotipo usado en los mockups de esta sección es un **placeholder de posición y color** (badge azul + "U"), no un trazado del isotipo original — en producción se sustituye por el archivo real (`assets/unuware-logo-isotype.png` o su versión SVG) en las mismas dimensiones.

### 1.5 Modo Claro / Modo Oscuro

**Decisión de diseño:** el shell (`QHeader` + `QDrawer`) se queda oscuro en ambos modos — es la identidad de marca que ya estaba en los wireframes originales, el mismo patrón que usan Linear, Vercel o GitHub (navegación fija oscura, contenido conmutable). Lo que cambia entre modo claro y oscuro es **el área de contenido**: fondo de página, cards, tablas, bordes y texto. Los colores semánticos (`$positive`/`$warning`/`$negative`/`$info`) no cambian de valor — ya funcionan sobre fondo oscuro porque los badges de severidad usan relleno sólido + texto blanco (patrón ya presente en el wireframe original de Trazabilidad), así que no hace falta una segunda tríada para modo oscuro.

| Token de contenido | Modo claro | Modo oscuro | Variable CSS |
|---|---|---|---|
| Fondo de página | **`#FFFFFF`** | `#141516` | `--pd-page-bg` |
| Superficie Card | `#FFFFFF` | `#1E1F21` | `--pd-card-bg` |
| Superficie subordinada | `#F6F7F9` | `#26282B` | `--pd-surface-muted` |
| Fondo de input | `#FFFFFF` | `#232427` | `--pd-input-bg` |
| Borde | `#E3E5E8` | `#2E3033` | `--pd-border` |
| Borde suave | `#EFF1F3` | `#26282B` | `--pd-border-soft` |
| Texto primario | `#1A1A1A` | `#EDEDEE` | `--pd-text-primary` |
| Texto secundario | `#6B6F76` | `#9A9DA3` | `--pd-text-secondary` |
| Texto deshabilitado | `#A6A9AE` | `#5B5E63` | `--pd-text-disabled` |
| Tinte de marca | `#EAF2FA` | `#16283A` | `--pd-primary-tint` |
| Fila tabla · URGENTE | `#FCF3F2` | `#271C1B` | `--pd-row-urgente` |
| Fila tabla · GRAVE | `#FDF7ED` | `#2A2418` | `--pd-row-grave` |

> **Asimetría intencionada entre modos:** en claro, página y card comparten el `#FFFFFF` y la jerarquía la marca el **borde**; en oscuro la card (`#1E1F21`) sí es más clara que la página (`#141516`). Es el patrón habitual (Linear, Vercel, GitHub): en superficies claras se separa con línea, en oscuras con luminosidad.

**Mecanismo:** Quasar añade automáticamente `body--dark` al `<body>` cuando `$q.dark` está activo; las variables de la tabla anterior se redefinen bajo ese selector en `app.scss` (Sección 4.4). La app arranca respetando el `prefers-color-scheme` del sistema operativo (modo `'auto'` nativo de Quasar) salvo que el usuario ya haya elegido explícitamente un modo, en cuyo caso se persiste en `localStorage` (clave `proto-do:theme-mode`) y se aplica antes del primer pintado para evitar parpadeo.

El dueño único de ese estado es **`useThemeStore`** (`src/stores/theme.store.ts`), un Setup Store de Pinia que manipula la API imperativa `Dark` de Quasar. Se **auto-inicializa**: `initTheme()` se invoca en el cuerpo del setup store, que Pinia ejecuta una sola vez en el primer `useThemeStore()` — el `setup()` de `MainLayout`/`AppHeader`, anterior al commit del DOM. Por eso no hace falta boot file. `quasar.config.ts` fija además `framework.config.dark: 'auto'` como default declarativo para el instante previo a que el store exista.

`isDark` se deriva de `Dark.isActive` (que es reactivo) en lugar de mantenerse como `ref` propio: en modo `'auto'` Quasar ya registra su listener de `prefers-color-scheme`, así que un cambio de tema del sistema operativo en caliente se refleja sin recargar. El toggle es binario — tras el primer clic el modo queda explícito (`'light'`/`'dark'`) y no vuelve a `'auto'`.

**El control** es un `QBtn` redondo con icono sol/luna en el `QHeader`, visible en los dos mockups siguientes:

**Vista 6 — Trazabilidad (claro / oscuro):**

![Vista 6 claro](assets/vista6-trazabilidad-light.svg)
![Vista 6 oscuro](assets/vista6-trazabilidad-dark.svg)

**Vista 3+4 — Wizard/Mapeo (claro / oscuro):**

![Vista 3+4 claro](assets/vista3-4-wizard-mapeo-light.svg)
![Vista 3+4 oscuro](assets/vista3-4-wizard-mapeo-dark.svg)

> Se muestran estas dos vistas como prueba porque cubren los dos patrones de UI más distintos del sistema (tabla + KPIs vs. formulario + stepper). El resto de vistas (1, 2, 5, 7, 8) sigue exactamente las mismas variables de esta sección — no requieren un token nuevo, solo aplicar las clases `.pd-page` / `.pd-card` descritas en la Sección 4.4.

---

## 2. Arquitectura de Navegación y Rutas (Vue Router + Pinia)

### 2.1 Layout

Un único `MainLayout.vue` con `QHeader` (dark, 60px) + `QDrawer` (dark, 220px, colapsable con el botón de hamburguesa) + `QPageContainer` sobre `--pd-page-bg` (`#FFFFFF` en claro, `#141516` en oscuro). El ítem de navegación activo se pinta con `--pd-shell-alt` (`#262626`). `AuthLayout.vue` aparte, pantalla completa, sin header/drawer (ver Vista 1).

### 2.2 Mapa de rutas

Los nombres de ruta y de store se alinean con las entidades reales del modelo (`FLUJOS`, `PLANTILLAS_HTML`, `PROMPTS_IA`, `EJECUCIONES_FLUJO`, `ALERTAS_ERROR`) en vez de nombres genéricos.

| Ruta | Nombre | Guard | Vista | CU |
|---|---|---|---|---|
| `/auth/login` → `/auth/otp` | `auth-login` / `auth-otp` | `guestGuard` | Vista 1 | CU-01 |
| `/` | — | `authGuard` | Redirect a `/flujos` | — |
| `/flujos` | `flujos-list` | `authGuard` | Listado (apoyo, no detallado como vista propia) | — |
| `/flujos/:id` | `flujo-canvas` | `authGuard` | Vista 5 | CU-04 |
| `/flujos/nuevo`, `/flujos/:id/editar` | `flujo-wizard` | `authGuard` | Vista 3+4 | CU-03, CU-05 |
| `/plantillas` | `plantillas-list` | `authGuard` | Vista 7 | CU-06 |
| `/prompts` | `prompts-list` | `authGuard` | Vista 8 | CU-07 |
| `/trazabilidad` | `trace-dashboard` | `authGuard` | Vista 6 | CU-08, CU-09 |
| `/admin/usuarios` | `admin-users` | `authGuard` + `roleGuard('ADMINISTRADOR')` | Vista 2 | CU-02 |

### 2.3 Stores Pinia

| Store | Responsabilidad | Estado clave |
|---|---|---|
| `useSessionStore` | Sesión OTP + rol | `user`, `role` (`ADMINISTRADOR`\|`EDITOR`), `token`, `otpVerified` |
| `useFlujoDraftStore` | Borrador del wizard (los 5 pasos) | `trigger`, `sanitizacionScraper`, `ia`, `plantillaYMapeo`, `destino`, `stepValidity[]` |
| `usePlantillasStore` | Catálogo de `PLANTILLAS_HTML` | `plantillas[]`, `preview` (HTML renderizado con datos de ejemplo) |
| `usePromptsStore` | Catálogo de `PROMPTS_IA` | `prompts[]`, `modeloDefault` |
| `useExecutionStore` | Estado en vivo de `EJECUCIONES_FLUJO` (vía WebSocket) | `executionId`, `pasoActual` (cursor FSM), `estado` |
| `useAlertasStore` | `ALERTAS_ERROR` + tabla de trazabilidad | `alertas[]`, `filtros` (flujo/estado/fecha) |

`useExecutionStore` se suscribe al `NotificationGateway` (WebSocket, patrón *Gateway*) por el que el backend notifica cambios de estado ("Procesando" → "Listo") en tiempo real — alimenta principalmente la Vista 6; en la Vista 5 se usa opcionalmente para resaltar, sin permitir edición, cuál nodo está activo en la última ejecución.

---

## 3. Especificación Detallada de Pantallas y Módulos UI

### Vista 1 — Autenticación Passwordless OTP

**Ruta:** `/auth/login` → `/auth/otp` · **CU-01** · **RF-01, RF-02, RNF-02**

**Objetivo funcional:** acceso sin contraseñas (RNF-02: cero contraseñas o hashes almacenados), restringido a la subred/VPN corporativa (`RedLocalMiddleware`, RF-02) y validado por OTP de 6 dígitos enviado al correo corporativo.

**Cómo se verá:**

![Vista 1 - Login OTP](assets/vista1-login-otp.svg)

**Componentes Quasar:** `QForm`+`QInput` (correo, con sufijo fijo de dominio), `QOtpInput` (paso 2, no mostrado aquí), `QLinearProgress` (cuenta atrás de reenvío), `QBanner` (errores), `$q.loading` (envío en curso).

**Poka-Yoke:**
- Botón "Enviar código" deshabilitado hasta email válido.
- Reenvío bloqueado 60s, no cancelable.
- Tras 3 intentos fallidos, bloqueo temporal sin revelar si el correo existe (evita enumeración de usuarios).
- El middleware de red rechaza la petición *antes* de que la SPA cargue si la IP no está en la subred autorizada — el error de "IP no autorizada" es un estado propio de la pantalla, distinto de "OTP inválido".

---

### Vista 2 — Panel Administrativo de Usuarios (RBAC)

**Ruta:** `/admin/usuarios` · **CU-02** · **RF-03** · Exclusivo rol `ADMINISTRADOR`

**Objetivo funcional:** alta, consulta, modificación y suspensión de cuentas con rol `ADMINISTRADOR` o `EDITOR`. El MVP excluye explícitamente auto-registro y RBAC multi-rol — son solo estos dos perfiles fijos.

**Cómo se verá:**

![Vista 2 - Gestión de Usuarios](assets/vista2-usuarios-rbac.svg)

**Componentes Quasar:** `QTable` (paginada), `QBadge` de rol, `QSelect` de filtro, `QDialog` de confirmación.

**Poka-Yoke:**
- Un administrador no puede quitarse a sí mismo el rol de administrador ni desactivar su propia cuenta.
- Toda baja o cambio de rol pasa por `QDialog` de confirmación explícita.
- "Suspender" (no "eliminar") por defecto — coherente con que no existe recuperación de contraseña ni auto-registro: una cuenta mal dada de baja no se puede recrear sola.

---

### Vista 3 + 4 — Wizard de Configuración (5 pasos) + Mapeo Determinista

**Ruta:** `/flujos/nuevo`, `/flujos/:id/editar` · **CU-03 (Configurar Flujo), CU-05 (Mapear Variables)** · **RF-11, RF-15, RNF-04**

**Objetivo funcional:** los 5 pasos visibles agrupan las 7 estrategias internas (`INodeStrategy`) en una secuencia legible para un editor no técnico, sin exponer el JSON del pipeline:

1. **Trigger** — configurar `ImapTriggerStrategy` (buzón IMAP, filtros de asunto/remitente).
2. **Extraer Variables** — `ParserEmailStrategy` (sanitización pre-IA) + `WebScraperStrategy` (extracción anti-bots del enlace).
3. **IA** — selección de `PROMPTS_IA` y modelo (`LlmExtractorStrategy`), con `DataValidationSanitizerStrategy` como escudo posterior no configurable por el usuario.
4. **Mapeo** — selección de `PLANTILLAS_HTML` + mapeo determinista de variables (`TemplateMapperStrategy`) — esta es la vista que en el encargo original era "Vista 4" independiente; aquí va embebida como paso, tal como ya estaba en el wireframe original del wizard.
5. **Destino** — `DrupalHttpStrategy` / `AcensHttpStrategy` (endpoint, credenciales, modo publicación/campaña).

Cada paso incluye un botón de prueba en caliente (p. ej. "Probar mapeo") que ejecuta ese nodo aislado contra datos de muestra sin persistir nada — evita que un editor descubra un error de configuración solo hasta la primera ejecución real.

**Cómo se verá (Paso 4 · Mapeo, como ejemplo representativo):**

![Vista 3+4 - Wizard y Mapeo](assets/vista3-4-wizard-mapeo.svg)

**Componentes Quasar:** `QStepper` (`header-nav="false"`), `QSelect` cerrado (mapeo, sin entrada libre), `QBanner`, `QLinearProgress` (paso N de 5).

**Poka-Yoke (RNF-04):**
- Botón "Siguiente" deshabilitado hasta que el paso activo valide.
- `QSelect` de mapeo no admite texto libre — solo claves reales expuestas por el `StatePayloadContext` (namespaces `parsed_email`, `scraped_web`, `llm_response`) y campos reales de la plantilla seleccionada.
- Compatibilidad de tipos verificada en tiempo real; una clave ya mapeada se retira de las opciones disponibles en las siguientes filas.
- Autosave del borrador en `useFlujoDraftStore` en cada cambio.

---

### Vista 5 — Canvas de Topología Lineal (Solo Lectura)

**Ruta:** `/flujos/:id` · **CU-04** · **RNF-03**

**Objetivo funcional:** inspección visual, no editable, de la topología configurada — el orden y los parámetros solo se cambian desde el Wizard (Vista 3+4), nunca arrastrando nodos en este canvas (fuera de alcance explícito: *"Lienzo de arrastrar y soltar interactivo"*).

**Cómo se verá:**

![Vista 5 - Canvas de topología](assets/vista5-canvas-topologia.svg)

**Componentes Quasar:** composición custom sobre `QCard` (no `QTimeline`, dado el layout horizontal con conectores), `QBadge` por categoría de nodo (`TRIGGER`/`PROCESO`/`LLM·IA`/`HTTP·OUT`), controles de zoom, minimapa.

**Poka-Yoke:**
- Ningún control de edición se renderiza (ni oculto): es una vista de solo lectura real, no una vista editable con permisos desactivados.
- El botón "Editar flujo" navega a la Vista 3+4; no hay edición inline aquí.

---

### Vista 6 — Dashboard de Trazabilidad y Alertas

**Ruta:** `/trazabilidad` · **CU-08 (Auditar), CU-09 (Reintentar Paso Fallido)** · **RF-13, RF-14**

**Objetivo funcional:** consulta de ejecuciones (`EJECUCIONES_FLUJO`) y alertas (`ALERTAS_ERROR`) clasificadas por severidad — `LEVE` (no bloqueante, el flujo cierra `EXITOSO`), `GRAVE` (el flujo queda `PAUSADO` para inspección) y `URGENTE` (el flujo cierra `FALLIDO`).

**Cómo se verá:**

![Vista 6 - Trazabilidad y Alertas](assets/vista6-trazabilidad.svg)

**Componentes Quasar:** 4 `QCard` de KPI (con barra superior de color por severidad), `QTable` reactiva con fila teñida según severidad, `QSelect` múltiple de filtros, `QMenu` de acciones por fila.

**Poka-Yoke / CU-09:** una ejecución en estado `PAUSADO` expone en el menú de acciones "Reintentar desde este paso" — reactiva la FSM desde el cursor exacto donde falló (`EXTRACTOR_WEB`, `PROCESADOR_IA`, `NODO_VALIDACION` o `DESTINO_DRUPAL`, según el diagrama de estados), nunca desde cero. Tras 3 reintentos fallidos, el flujo pasa a `FALLIDO_DEFINITIVO` y ya no ofrece reintento automático.

---

### Vista 7 — Gestión de Plantillas HTML *(nueva — no estaba en el encargo original de 6 vistas)*

**Ruta:** `/plantillas` · **CU-06** · **RF-09**

**Objetivo funcional:** registrar, actualizar y probar plantillas HTML con marcadores dinámicos (`{{variable}}`) — es el catálogo del que se nutre el Paso 4 del wizard (Vista 3+4). Sin esta vista, "seleccionar plantilla" en el wizard no tendría de dónde leer.

**Cómo se verá:**

![Vista 7 - Plantillas HTML](assets/vista7-plantillas-html.svg)

**Componentes Quasar:** `QTable`/lista maestro-detalle, panel de vista previa con datos de ejemplo, `QChip` por cada marcador detectado automáticamente en el HTML.

**Poka-Yoke:** los marcadores esperados (`variables_esperadas`, campo JSONB de `PLANTILLAS_HTML`) se detectan por parseo del HTML al guardar, no se escriben a mano — así el mapeo del wizard siempre coincide con lo que la plantilla realmente espera.

---

### Vista 8 — Administrar Prompts e IA *(nueva — no estaba en el encargo original de 6 vistas)*

**Ruta:** `/prompts` · **CU-07** · **RF-07**

**Objetivo funcional:** mantener los `system_prompt` / `user_prompt_template` usados por `LlmExtractorStrategy` y elegir el modelo por defecto (`claude-sonnet-4-6`, `gpt-4o`, etc.) — catálogo del que se nutre el Paso 3 (IA) del wizard.

**Cómo se verá:**

![Vista 8 - Prompts IA](assets/vista8-prompts-ia.svg)

**Componentes Quasar:** lista maestro-detalle, `QSelect` de modelo, `QInput type="textarea"` para el prompt, `QChip` de variables esperadas (`variables_esperadas` JSONB).

**Poka-Yoke:** las variables que el prompt promete devolver se muestran como chips explícitos y deben coincidir con las que el Paso 4 (Mapeo) ofrece como "campo extraído (origen)" — si un prompt se edita y dos de sus variables, el sistema debería marcar como inconsistentes los flujos que ya mapeaban esas variables (recomendación de validación cruzada, no confirmada en el `.docx`, a validar con el equipo).

---

## 4. Directrices de Implementación Técnica

### 4.1 Convenciones de carpetas

```
src/
├── layouts/            (AuthLayout.vue, MainLayout.vue)
├── pages/
│   ├── auth/
│   ├── flujos/          (FlujosListPage.vue, FlujoWizardPage.vue, FlujoCanvasPage.vue)
│   ├── plantillas/       (PlantillasListPage.vue)
│   ├── prompts/          (PromptsListPage.vue)
│   ├── trazabilidad/     (TraceDashboardPage.vue)
│   └── admin/            (UsersPage.vue)
├── components/
│   ├── wizard/          (StepTrigger.vue, StepExtraccion.vue, StepIA.vue, StepMapeo.vue, StepDestino.vue)
│   ├── canvas/           (TopologyNode.vue, TopologyConnector.vue)
│   ├── trazabilidad/     (KpiCard.vue, AlertBadge.vue, RetryMenu.vue)
│   └── shared/           (AppHeader.vue, AppDrawer.vue, LogoMark.vue, ThemeToggle.vue)
├── css/                   (quasar.variables.scss, app.scss)
├── stores/               (theme.store.ts, session.store.ts, flujoDraft.store.ts, plantillas.store.ts,
│                          prompts.store.ts, execution.store.ts, alertas.store.ts)
├── boot/                 (axios.ts, socket.ts)
├── services/             (auth.service.ts, flujos.service.ts, plantillas.service.ts,
│                          prompts.service.ts, trace.service.ts)
├── types/                 (user.ts, flujo.ts, …  — réplicas de los DTO de NestJS)
└── router/                (routes.ts, index.ts)
```

> Sin `composables/` y sin `boot/theme`: el modo claro/oscuro vive íntegramente en `stores/theme.store.ts` (ver Sección 1.5). Convención de nombres real: `*.store.ts` y `*.service.ts`, todo en TypeScript.

### 4.2 Convención REST propuesta (alineada con los controladores reales)

El `.docx` confirma los controladores `AuthOtpController` y `WizardController` en NestJS, sin publicar las rutas exactas — la tabla siguiente es una **convención propuesta**, a confirmar contra el contrato real del backend antes de implementar:

| Acción | Método/Ruta propuesta | Controlador |
|---|---|---|
| Solicitar OTP | `POST /auth/otp/request` | `AuthOtpController` |
| Validar OTP | `POST /auth/otp/verify` | `AuthOtpController` |
| CRUD de flujos | `GET/POST/PUT/DELETE /wizard/flujos` | `WizardController` |
| Ejecutar/relanzar paso | `POST /wizard/flujos/:id/relaunch?paso=` | `WizardController` |
| CRUD plantillas / prompts | `GET/POST/PUT/DELETE /plantillas`, `/prompts` | (controlador propio, no nombrado en el `.docx`) |

### 4.3 Feedback global (plugins Quasar)

`$q.notify` (positive/info/warning con 4s; negative persistente cuando implica pérdida de datos), `$q.loading` (solo para OTP y guardado final del wizard), `$q.dialog` (toda confirmación destructiva, incluido el borrado seguro de 5s — RF-16).

### 4.4 Modo Claro / Modo Oscuro — implementación (Vue 3 + Quasar)

Implementado con las piezas nativas de Quasar (plugin `Dark`, `quasar.variables.scss`) más un store de Pinia. Archivos reales en `frontend/`:

| Archivo | Rol |
|---|---|
| `src/css/quasar.variables.scss` | Tokens de marca (`$primary`, `$dark`, `$positive`…), familias tipográficas y radios canónicos — iguales en ambos modos, Quasar resuelve el contraste por componente |
| `src/css/app.scss` | Custom properties de área de contenido bajo `:root` y `body.body--dark` (tabla de la Sección 1.5), tokens `--pd-shell-*` y clases utilitarias `.pd-*` |
| `src/stores/theme.store.ts` | **Dueño único del estado visual.** `isDark` + `initTheme()` + `toggleTheme()` sobre la API `Dark`, persistido en `localStorage` bajo `proto-do:theme-mode`. Auto-inicializado, sin boot file |
| `src/components/shared/ThemeToggle.vue` | El `QBtn` sol/luna que aparece en los mockups; consume el store, sin desestructurarlo |
| `src/components/shared/AppHeader.vue` | Dónde se monta el toggle dentro del `QHeader` (60px, `bg-dark text-white` inmutable) |
| `src/App.vue` | Importa las familias `@fontsource-variable/*` — es el único punto donde Vite puede empaquetar los `.woff2` |

Configuración en `quasar.config.ts` (no hay boot file de tema):

```ts
framework: {
  config: { dark: 'auto' }, // default declarativo previo al store
}
```

### 4.5 Tiempo real (WebSocket Gateway)

Confirmado en el `.docx` como patrón *Gateway*: el backend emite eventos por salas ("Procesando" → "Listo") hacia el `NotificationGateway`. `useExecutionStore` se suscribe al conectar y aplica cada actualización vía `$patch`; reconexión con backoff exponencial; desconexión explícita al salir de la Vista 5/6.

---

## 5. Trazabilidad encargo ↔ documento base

| Caso de uso (`.docx`) | Requerimiento | Vista |
|---|---|---|
| CU-01 Autenticarse vía OTP | RF-01, RF-02 | Vista 1 |
| CU-02 Gestionar Usuarios (CRUD) | RF-03 | Vista 2 |
| CU-03 Configurar Flujo (Wizard) | RF-11, RF-15 | Vista 3+4 |
| CU-04 Visualizar Canvas Estático | RNF-03 | Vista 5 |
| CU-05 Mapear Variables | RNF-04 | Vista 3+4 (Paso 4) |
| CU-06 Gestionar Plantillas HTML | RF-09 | **Vista 7 (nueva)** |
| CU-07 Administrar Prompts e IA | RF-07 | **Vista 8 (nueva)** |
| CU-08 Auditar Trazabilidad y Alertas | RF-13, RF-14 | Vista 6 |
| CU-09 Reintentar Paso Fallido | — | Vista 6 (menú de acciones) |
| CU-10 Eliminar Flujo de Trabajo | RF-16 | Vista 5/6 (modal de borrado seguro, 5s) |

## Pendiente

- [ ] Confirmar con el equipo si `Roles`, `Configuración` y `Reportes` (visibles en el wireframe original de Usuarios pero fuera de las 10 CU listadas) entran en el alcance del MVP o son navegación futura.
- [ ] Confirmar rutas REST exactas de `WizardController` / `AuthOtpController` y de los controladores de Plantillas/Prompts (no nombrados explícitamente en el `.docx`).
