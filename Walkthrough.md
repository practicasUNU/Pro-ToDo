# Walkthrough · Bitácora de Desarrollo Proto-Do

Registro técnico del "por qué" de cada decisión de implementación. Los estados de la FSM se documentan aquí a medida que se implementan.

---

## 2026-08-25 · Perímetro de red local y RBAC del CRUD de usuarios (PROT-04.2 / PROT-05) — rama `feat/Middleware-IP`

### Punto de partida

El backend era un CRUD abierto: sin `src/common/`, sin módulo `auth`, sin guards. `JWT_SECRET` y la variable de subred existían en `.env` pero **ningún código las leía**. Cualquiera con acceso al puerto podía listar y desactivar usuarios.

### Por qué el perímetro se implementa en DOS piezas y no en una

La tarea pedía un `RedLocalMiddleware`; el requisito de eximir rutas con un decorador `@PublicIp()` exige un `Reflector`, que solo existe dentro de un `ExecutionContext` — es decir, en un `CanActivate`. Pero un guard **no puede** proteger Swagger: `SwaggerModule.setup()` registra sus rutas directamente contra el adaptador Express, fuera del router de Nest, así que ningún guard llega a ejecutarse sobre `/api/docs`.

De ahí la separación por *alcance*, no por duplicación:

- **`IpWhitelistGuard`** (`APP_GUARD`, con `Reflector`) → todas las rutas del router de Nest.
- **`RedLocalMiddleware`** (Express puro) → solo las rutas de Swagger.
- Ambos delegan en **`IpAccessService`**, único lugar donde vive la política. Cambiar la regla es cambiar un archivo.

**Hallazgo de la verificación en vivo:** montar el middleware sobre el prefijo `/api/docs` dejaba `/api/docs-json` respondiendo **200 desde una IP externa**. Swagger registra el documento JSON/YAML como rutas **hermanas** (`api/docs-json`), no anidadas: se filtraba el inventario completo de endpoints fuera del perímetro. El middleware se monta ahora sobre las tres rutas (`SWAGGER_PERIMETER_PATHS` en `main.ts`). No lo detectó ningún test unitario; solo el `curl` contra el proceso real.

### Decisiones que no son obvias

- **Fail-closed sin excepción de entorno.** Si `ALLOWED_IP_RANGES` falta, está vacía o solo trae separadores, se rechaza con 403 — también en desarrollo. Un fallback permisivo en `NODE_ENV !== 'production'` es exactamente el tipo de configuración que acaba desplegada.
- **El motivo técnico del rechazo solo viaja al log.** `IpAccessService.buildDenial()` registra IP + método + URL + causa, pero al cliente le llega siempre el mismo `ACCESS_DENIED_MESSAGE`: no se le confirma si el problema fue la lista, su IP o la ausencia de cabeceras.
- **`x-forwarded-for` es falsificable.** El orden de prioridad (XFF → `x-real-ip` → `socket.remoteAddress` → `req.ip`) lo fija la especificación de la tarea, y es correcto **solo detrás de un proxy inverso de confianza**. Expuesto directamente, cualquiera envía la cabecera que quiera. Al desplegar, el proxy debe sobrescribir XFF, no anexarla.
- **`403` para rol insuficiente, `401` para token inválido.** Un EDITOR autenticado no es un anónimo: su token es válido, lo que le falta es autorización. `RolesGuard` nunca devuelve 401.
- **Guards a nivel de clase en `UsersController`** (Poka-Yoke): un endpoint nuevo nace protegido; no depende de que alguien recuerde decorarlo.
- **Se reutilizó el enum `UserRole` existente** en lugar de crear el `Role` que pedía el enunciado: ya está respaldado por el tipo Postgres `enum_rol_usuario` de `init.sql`. Un segundo enum sería una fuente de verdad duplicada.
- **`AuthModule` sin controlador, a propósito.** Aquí solo se **verifica** el JWT; emitirlo (OTP + throttler) es PROT-04.1. El módulo queda listo para recibir ese controlador.
- **Alias absolutos sin herramientas nuevas.** `@nestjs/cli@11` incluye un transformer (`lib/compiler/hooks/tsconfig-paths.hook.js`) que reescribe `@common/...` a rutas relativas en el JS emitido, tanto en `nest build` como en `nest start --watch`. Bastaron `baseUrl` + `paths` en `tsconfig.json`; **no** hicieron falta `tsc-alias` ni `module-alias`, y `start:prod` sigue funcionando. Jest sí necesitó su propio `moduleNameMapper`.
- **`noImplicitAny` pasó a `true`.** Estaba desactivado pese a que las reglas prohíben el `any` implícito; el código existente ya cumplía, así que el cambio no costó nada.

### Normalización de variables de entorno

Había **tres** nombres para la misma idea y ninguno se leía: `ALLOWED_IP_SUBNETS` (`.env`), `ALLOWED_SUBNET_CIDR` (`.env.example`). Canonizado a `ALLOWED_IP_RANGES` en ambos, con `::1/128` añadido (sin él, el loopback IPv6 quedaba fuera). También se alineó `JWT_EXPIRATION` → `JWT_EXPIRES_IN` en la plantilla.

### Verificación

`npm run build` limpio, `npm run lint` con 0 errores y **36 pruebas AAA en verde** (6 suites). Contra el proceso real: `/api/health` responde 200 desde cualquier IP; `/api`, `/api/users` y las tres rutas de Swagger devuelven 403 desde `8.8.8.8`; desde la VPN `10.20.30.40` el perímetro se supera y queda el 401 por falta de token. Con tokens firmados: EDITOR → 403 en los cinco endpoints, ADMIN → 200, token expirado o mal firmado → 401, y **ADMIN desde IP externa → 403**, confirmando que el perímetro se evalúa antes que las credenciales.

### Checklist de dependencias restantes

- [ ] **PROT-04.1**: endpoints de OTP (`otplib`), emisión del JWT y `@nestjs/throttler` sobre esas rutas.
- [ ] **`test/app.e2e-spec.ts`**: sigue siendo el boilerplate de `nest new` y falla porque levanta `AppModule` completo exigiendo Postgres. Ya fallaba antes de este cambio; no se tocó.
- [ ] **`trust proxy`**: decidir la configuración de Express al definir el proxy inverso de despliegue.
- [ ] **Winston**: instalado y con variables `LOG_*` en `.env`, pero sin usar. `IpAccessService` registra con el `Logger` nativo de Nest; migrará al servicio de trazabilidad cuando exista.

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
