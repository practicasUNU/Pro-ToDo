# Walkthrough · Bitácora de Desarrollo Proto-Do

Registro técnico del "por qué" de cada decisión de implementación. Los estados de la FSM se documentan aquí a medida que se implementan.

---

## 2026-08-25 · Refactor del módulo Gestión de Usuarios (CU-02) — rama `feat/CRUD-Users`

### Capas: extracción de `src/services/`

**Por qué.** `users.store.ts` llamaba a `api.get/post/patch/delete` directamente, violando `frontend-architecture.md` §1. La cadena obligatoria `Componente → acción de Pinia → Servicio → HTTP` estaba rota en su eslabón central: el store conocía rutas del backend y el tipo `AxiosResponse`, dos motivos de cambio ajenos a la lógica de negocio.

- Nuevo `frontend/src/services/users.service.ts`: única capa que conoce `/users` y `/users/:id`. Cuatro funciones puras (`fetchUsers`, `createUser`, `updateUser`, `deactivateUser`) que retornan `data` desestructurada. No capturan errores: los propagan.
- `users.store.ts` conserva firmas, el `try/finally` de `isLoading` y las mutaciones inmutables (`[...users.value, created]`, `.map(...)`); solo delega el I/O. Los componentes no se enteraron del cambio.
- Alias `@services` añadido a `build.alias` en `quasar.config.ts` (`quasar prepare` lo propaga a `.quasar/tsconfig.json`). Recordatorio: `@types` sigue inviable por TS6137.
- Se amplió `.claude/rules/frontend-architecture.md` con la **§2.1 Responsabilidad por Capa**: la regla prohibía HTTP en stores pero no decía dónde vive la lógica propia de un formulario o diálogo. Ahora la tabla lo fija: validación de campos, apertura de diálogo y temporizadores viven en el componente; el negocio y el estado compartido en el store; los helpers puros de formato en `src/utils/`.

**Consecuencia práctica:** la validación de dominio corporativo (`isCorporateEmail`) se quedó deliberadamente en `UserDialog.vue`. Es una regla del formulario, no un invariante de dominio, y muere con el componente.

### Presentación: sincronización con la paleta institucional

**Por qué.** `frontend-quasar.md` fue actualizado a la paleta **navy + degradado azul**, pero `app.scss` seguía implementando el briefing anterior (papel blanco, `#2e75b6`, shell `#1e1e1e`). Los tokens que el refactor visual necesitaba (`--pd-primary`, `--pd-primary-light`, `--pd-negative`, `--pd-disabled-bg`, `--pd-panel-solid`, …) simplemente no existían: nada podía consumirlos en runtime.

- `quasar.variables.scss`: brand vars alineadas (`$primary #2C4FC7`, `$dark #12142E`, `$dark-page #0D0F26`, tríada semántica) + nuevo `$heading-font-family` (Poppins → Montserrat → Inter).
- `app.scss`: los 20 tokens de la tabla de reglas, separados en tres bloques por **motivo de cambio**: los que conmutan con `body--dark`, los de marca que NO conmutan (azules, acentos, severidad) y el shell. Se **consolidaron** cinco tokens fuera de la lista cerrada (`--pd-input-bg`, `--pd-text-disabled`, `--pd-border-soft`, `--pd-primary-tint`, `--pd-shell-hover`) tras verificar por grep que ningún `.vue` los consumía.
- Los `--pd-row-*` se conservan como tokens derivados (no son colores nuevos: son la tríada de severidad a baja opacidad) porque las reglas exigen las clases `.row-urgente/-grave/-exitoso`; faltaba `--pd-row-exitoso`.
- Poppins se instaló vía `@fontsource/poppins` con importación de pesos explícita (500/600/700) en `App.vue`: **no tiene eje variable** en fontsource, a diferencia de Inter y JetBrains Mono. Sin CDN, coherente con el aislamiento perimetral.

### Detalles de implementación que no son obvios

- **Columna "Nombre"**: la entidad `usuarios` del backend no persiste un nombre propio (solo `id`, `correo`, `rol`, `activo`). Se creó el helper puro `src/utils/user-display.ts` con `deriveDisplayName(email)`: `mmolina@` → `M. Molina`, `victor.garcia@` → `Victor Garcia`. El umbral `MIN_SURNAME_LENGTH = 5` existe para evitar el falso positivo `admin` → `A. Dmin`; por debajo del umbral cae a capitalización simple. Decisión de presentación, cero cambios en BD.
- **UUID sin columna propia**: rompía la legibilidad de la tabla. Pasó a un `QTooltip` con `.pd-mono` sobre la celda del nombre — el dato técnico sigue accesible sin ocupar ancho.
- **`--pd-accent` vs `--pd-accent-text`**: `#5B8CE8` da ~3:1 de contraste, insuficiente para texto pequeño en modo claro (WCAG AA). Los badges de rol y los hovers de icono consumen `--pd-accent-text` (`#3D6BD9` en claro), no `--pd-accent`.
- **Estado "Inactivo" ya no es rojo**: usaba `color="negative"`, que semánticamente comunica *error*. Una cuenta desactivada es un estado neutro válido, de ahí `--pd-disabled-bg` / `--pd-disabled-text`.
- **Borde de los botones outline**: QBtn pinta su borde en `::before` con `currentColor`, así que el trazo seguía al color del texto. `.pd-btn-icon` fuerza `border-color` al token en `&.q-btn--outline::before` para que el borde sea `--pd-border` en reposo y `--pd-accent` en hover, independientemente del texto.
- **Estado deshabilitado**: Quasar aplica `opacity` a los botones deshabilitados, lo que atenuaría el degradado en lugar de sustituirlo. `.pd-btn-primary.disabled` fuerza `opacity: 1` y reemplaza el fondo por `--pd-disabled-bg`, cumpliendo la regla de que el texto nunca comparta tono con el fondo.
- **Countdown de 5 s**: `SafeDeleteModal.vue` ya lo implementaba correctamente (`COUNTDOWN_SECONDS = 5`, `:disable`, guarda en `onConfirm`, `clearInterval` en `onBeforeUnmount`). **No se tocó esa lógica**; solo pasó a `.pd-btn-danger` sólido y ganó la franja roja de 3 px vía `.pd-card--accent.pd-accent-urgente`.

### Checklist de dependencias restantes

- [ ] **Dark-first**: `theme.store.ts` y `quasar.config.ts` usan `dark: 'auto'`; las reglas piden arrancar en oscuro (`true`) con toggle persistido. Pendiente de decisión.
- [ ] **`ErrorNotFound.vue`**: aún usa `bg-dark`, `text-h4` y `style` inline (`font-size: 30vh`).
- [ ] **Iconografía outline**: `@quasar/extras` no trae el set `material-icons-outlined` en esta instalación, así que los iconos de navegación siguen siendo del set filled. Habría que añadir el paquete para cumplir la regla de trazo lineal en todos los glifos.
- [ ] **Tests**: falta el test AAA de `deriveDisplayName` y el de `users.store` con `users.service` mockeado.
