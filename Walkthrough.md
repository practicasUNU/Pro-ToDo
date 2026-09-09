# Walkthrough · Bitácora de Desarrollo Proto-Do

Registro técnico del "por qué" de cada decisión de implementación. Los estados de la FSM se documentan aquí a medida que se implementan.

---

## 2026-08-27 · Revocación de sesiones aislada por dispositivo + sincronización multi-pestaña — rama `feat/auth-otp`

Cierra el pendiente que dejó la entrega anterior (*"el backend no persiste `deviceId`"*) y, con él, la deuda multi-pestaña que arrastraba la entrega del endurecimiento del JWT. Las dos mitades van juntas a propósito: la primera, sola, convertiría una pestaña desincronizada en un cierre de sesión global.

### Lo que cambia de comportamiento

`refresh_tokens` gana `id_dispositivo UUID NOT NULL` (migración 004), y `issue()` pasa a recibir el dispositivo. Emitir un token ahora revoca el token vivo anterior **de ese mismo dispositivo** y deja intactos los de los demás equipos del usuario. Volver a entrar desde el portátil ya no deja dos sesiones vivas en él, y no expulsa al móvil.

### El orden dentro de la transacción es la propiedad de corrección

Son tres pasos con tres motivos distintos, y dos de ellos tiran en direcciones opuestas:

| Paso | Por qué ahí |
|---|---|
| 1. Revocar `{userId, deviceId, isRevoked: false}` | **Antes** de insertar. Después, el filtro `isRevoked: false` alcanzaría al token recién creado y lo revocaría al nacer. |
| 2. Insertar el token nuevo | — |
| 3. Podar los inservibles | **Después** de insertar. El token nuevo nace vigente, así que no es candidato (razonamiento ya documentado en la entrega de la poda). |

### Desviación deliberada del encargo: el repositorio transaccional

La especificación pedía `this.refreshTokenRepository.update(...)`. Se usa el `repository` que entrega `manager.transaction`, no el inyectado: `this.refreshTokenRepository` opera **fuera** de la transacción de `issue()`, así que si la inserción fallara después, la revocación quedaría confirmada y el usuario perdería su sesión en ese dispositivo sin recibir reemplazo. La invariante que ya declaraba el comentario del método —*"nunca se borra nada sin que su reemplazo exista"*— exige el repositorio transaccional. Hay una prueba que fija el orden vía `mock.invocationCallOrder`.

### `rotate()` devuelve `RotatedSession`, no `User`

Devolvía solo el usuario y **descartaba la fila**, que es donde vive el `deviceId`. Ahora devuelve `{ user, deviceId }`, y `refreshSession` lo pasa a `buildTokenResponse`.

La alternativa era que el cliente reenviara el `deviceId` en `/auth/refresh`. Se descartó: el dispositivo se fija en el login y lo transporta la cadena de tokens, de modo que un token en rotación no puede cambiar de etiqueta de dispositivo a mitad de sesión. `RefreshTokenDto` no se tocó.

### El falso positivo de reutilización se acepta: es comportamiento esperado del servidor

Un login nuevo en el dispositivo D revoca el token vivo anterior de D. Si algún cliente todavía conserva ese token y lo presenta, `rotate()` lo ve revocado, lo interpreta como robo y ejecuta `revokeAllForUser()`: **caen todas las sesiones del usuario**.

Es una decisión, no un descuido. La detección de reutilización **no puede distinguir** un token robado de uno que un cliente desincronizado conservaba: ambos son la misma observación (una credencial revocada que reaparece). Resolver la ambigüedad en el backend exigiría una columna de motivo de revocación —`ROTACION` vs `SUPERSEDIDO`— y ramificar `rotate()`; se descartó explícitamente para no ampliar el esquema, y ante la duda el servidor elige el lado seguro: asumir robo.

**Por tanto la sincronización es responsabilidad del frontend**, y de ahí la segunda mitad de esta entrega.

### Nota de seguridad sobre el `deviceId`

Lo elige el cliente y **no está autenticado**: cualquiera puede enviar el UUID que quiera. Solo se usa acotado a `userId`, así que un usuario únicamente puede afectar a sus propias filas — no hay vector cruzado. Jamás debe usarse como entrada de autorización.

### Frontend: el evento `storage` cierra el agujero

`session.store.ts` escucha `storage`, que **solo se dispara en las otras pestañas**, nunca en la que escribió — así que adoptar el estado no puede realimentarse.

- **Se relee el trío completo, no solo el access token.** Adoptar únicamente el access token dejaría el `refreshToken` viejo en memoria, que es *exactamente* la credencial que dispara la detección de reutilización descrita arriba. Adoptar los tres es lo que cierra el agujero.
- **`writeSession` escribe tres claves**, así que un login ajeno llega como tres eventos. Reaccionar a cualquiera releyendo el estado completo converge al valor correcto; los intermedios son transitorios.
- **Sin token en disco se propaga el cierre**: cerrar sesión en una pestaña desloguea las demás.
- **El temporizador se reinicia solo.** No hace falta tocar el monitor: `useSessionMonitor` ya tiene `watch(() => sessionStore.accessToken, scheduleWarning)`, y `scheduleWarning` limpia el intervalo y vuelve a sondear desde cero. Actualizar el ref **es** reiniciar el temporizador, y así el store sigue sin conocer Quasar ni `$q.dialog` (`frontend-architecture.md` §2.1).
- **Las claves salen de `session-storage.ts`** mediante un `isSessionStorageKey` nuevo: el store no hardcodea `'proto-do:access-token'`, el módulo hoja sigue siendo el único dueño de los nombres.

### Desviación deliberada: el listener NO se retira en `clear()`

El encargo lo pedía. Sería un bug: `clear()` corre en cada cierre de sesión, y una pestaña sin listener no volvería a enterarse de un login posterior en otra — la desincronización regresaría en cuanto el usuario cierre y vuelva a entrar. El listener vive tanto como el store, que es un singleton de la aplicación.

Se expone `stopCrossTabSync()` para pruebas y desmontaje, y el módulo guarda la referencia al listener activo porque en HMR se reevalúa y cada recarga en caliente apilaría un listener más.

### Verificación

93 pruebas en verde (9 suites): las 87 previas más 6 nuevas —revoca el token del mismo dispositivo, no alcanza a otros dispositivos, revoca antes de insertar, persiste el `deviceId`, `rotate` devuelve el dispositivo, y el arrastre en la renovación—. `npx tsc --noEmit` **en cero errores**: de paso se cerró el TS2741 preexistente de `refresh-token.service.spec.ts:13` (`ACTIVE_USER` sin `otpSecret`), que era el único del proyecto. `eslint` y `nest build` limpios. En frontend, `vue-tsc --noEmit`, `eslint` y `npm run build` limpios; sin pruebas automatizadas porque el frontend aún no tiene arnés.

Pendiente de verificación manual contra el backend real: los puntos 6-12 del plan de esta entrega, en particular que un login desde otro navegador **no** cierre la sesión del primero, y que dos pestañas se mantengan sincronizadas al renovar.

### Checklist de dependencias restantes

- [ ] **Aplicar la migración 004** — es requisito de arranque: hasta entonces cualquier login falla con `column RefreshToken.id_dispositivo does not exist`. Borra las sesiones abiertas.
- [ ] **La ventana de detección de reutilización es por usuario, no por dispositivo:** `RETAINED_DEAD_TOKENS = 5` cuenta sobre todos los tokens muertos del usuario, así que con varios equipos la ventana efectiva **por dispositivo** se estrecha (~5/N rotaciones). Hacer la poda por `(userId, deviceId)` la restauraría y acotaría el crecimiento a `sesiones_vivas + 5 × dispositivos`.
- [ ] **Diálogo de expiración obsoleto:** si una pestaña tiene el aviso abierto y adopta un token fresco de otra, el diálogo no se cierra solo (`scheduleWarning` reprograma el sondeo pero no toca `dialogHandle`). Queda con una cuenta regresiva vieja; "Mantener sesión" renueva con el token nuevo, sin daño. El arreglo es un `closeExpiryDialog()` dentro del `watch` de `useSessionMonitor.ts` cuando el token nuevo tenga holgura — fuera del alcance "solo `session.store.ts`" de esta entrega.
- [ ] **`@Cron` sobre `purgeExpired()`:** sigue pendiente desde la entrega de la poda.

---

## 2026-08-27 · `deviceId` en `verifyOtp` (solo frontend) — rama `feat/auth-otp`

El frontend genera y persiste un identificador de dispositivo (`crypto.randomUUID()`, vía el plugin nativo `LocalStorage` de Quasar) y lo adjunta al `POST /auth/otp/validate`. Alcance acotado a propósito a esta capa.

- **`frontend/src/utils/device-id.ts`** (nuevo): `getOrCreateDeviceId()` lee `proto-do:device-id` de `LocalStorage`, genera un UUID si no existe y lo persiste. Sigue el mismo criterio de `session-storage.ts` — es un helper que hace I/O de almacenamiento, no de red, así que se aparta de la regla "helpers puros, sin I/O" de `frontend-architecture.md` §2.1 por el mismo motivo ya documentado ahí.
- **`quasar.config.ts`**: se añadió `'LocalStorage'` a `framework.plugins`. No estaba registrado — solo `Notify` y `Dialog` — y sin registrarlo el plugin no funciona (mismo tropiezo que tuvo `Dialog` en la entrega del 26).
- **`auth.service.ts`**: `verifyOtp` gana un tercer parámetro `deviceId` y lo incluye en el body.
- **`session.store.ts`**: la acción `verifyOtp` llama a `getOrCreateDeviceId()` internamente; su firma pública `(email, code)` no cambió, así que `LoginPage.vue` no se tocó.

### El backend todavía no hace nada con este campo

`VerifyOtpDto` solo declara `email` y `code`. El `ValidationPipe` global usa `whitelist: true` sin `forbidNonWhitelisted` (`main.ts:29`), así que el `deviceId` que llega en el body se **descarta en silencio**: la petición no falla, pero el dato se pierde antes de llegar a `AuthService.verifyOtp`. No hay columna en `refresh_tokens` ni en ningún otro sitio para persistirlo.

Es una decisión de alcance, no un olvido: esta entrega es deliberadamente frontend-only. Para que el `deviceId` sirva para algo (p. ej. distinguir sesiones por dispositivo, o mostrarlas en un futuro "cerrar sesión en otros dispositivos") hace falta una entrega aparte que extienda `VerifyOtpDto`, añada la columna a `refresh_tokens` (migración) y la hidrate en `RefreshTokenService.issue()`.

### Checklist de dependencias restantes

- [x] **Wiring de backend** — *resuelto el 2026-08-27* (ver la entrada de revocación por dispositivo, arriba): `VerifyOtpDto.deviceId` pasa a ser obligatorio, `refresh_tokens` gana `id_dispositivo` (migración 004) y `issue()` lo persiste. El campo ya no se descarta.

---

## 2026-08-26 · Cierre del oráculo de enumeración en la solicitud de OTP — rama `feat/auth-otp`

Revierte la tarea 1 de la entrega anterior, que había hecho que una cuenta registrada pero inactiva respondiera `401 Cuenta inactiva` mientras un correo desconocido seguía devolviendo `202`. Esa diferencia bastaba para recorrer una lista de correos corporativos y deducir cuáles estaban dados de alta.

Los tres caminos vuelven a ser indistinguibles desde fuera:

| Situación | Respuesta |
|---|---|
| Código enviado | `202` + mensaje genérico |
| Correo no registrado | `202` + **el mismo** mensaje |
| Cuenta desactivada | `202` + **el mismo** mensaje |

El motivo real del descarte viaja solo al `Logger.warn` del servidor, que distingue "correo inexistente" de "cuenta desactivada" para quien lee los logs.

### El coste que se acepta a cambio

Un usuario cuya cuenta fue desactivada no recibe ninguna pista: pide el código, ve un mensaje de éxito y espera un correo que no llega. Es incómodo a propósito. La alternativa era la vulnerabilidad, y el canal correcto para avisarle es el administrador que lo dio de baja, no un endpoint público sin autenticar.

### La prueba cambió de bando

`DOCUMENTA EL ORACULO DE ENUMERACION`, que verificaba que los caminos **diferían**, se sustituyó por `ANTI-ENUMERACION: cuenta inexistente, inactiva y valida son indistinguibles`, que compara el desenlace de los tres y exige que sean idénticos. Falla si alguien vuelve a abrir el oráculo.

### Limpieza derivada en el frontend

`LoginPage.sendOtp` inspeccionaba el `401` para mostrar "Tu cuenta esta desactivada". Ese 401 ya no puede ocurrir — el guard de IP da 403 y el throttler 429 —, así que era código muerto y se retiró. El `catch` queda para fallo de red, 429 y 5xx.

### Nota para el futuro

El controlador **no** lleva `try/catch` alrededor de `requestOtp` porque el servicio no lanza. Si algún día lanzara (por ejemplo, un fallo de SMTP que hoy sube como 500), envolverlo pasa a ser obligatorio: un 500 que solo ocurre con correos existentes reabre el oráculo por la puerta de atrás. Queda anotado en el propio controlador.

---

## 2026-08-26 · Correcciones de UX del login, pool SMTP y RBAC en el router — rama `feat/auth-otp`

### ⚠️ Se abrió un oráculo de enumeración en `POST /auth/otp/generate` — **CERRADO el 2026-08-26**

> **Resuelto.** Duró una entrega. `requestOtp` volvió al `return` silencioso para
> ambos casos y el controlador homologa los tres caminos con el mismo `202`. Lo que
> sigue se conserva como registro de por qué existió y por qué se revirtió.


`requestOtp` ahora distingue dos casos que antes eran indistinguibles:

| Situación | Antes | Ahora |
|---|---|---|
| Correo no registrado | `202` silencioso | `202` silencioso |
| Cuenta registrada pero inactiva | `202` silencioso | **`401 Cuenta inactiva`** |

Esa diferencia es explotable: un atacante recorre una lista de correos corporativos y **deduce cuáles están dados de alta** por el código de respuesta. Es exactamente lo que la regla anti-enumeración de la entrega PROT-04.1 existía para impedir, y contradice el requisito original ("si no encuentra el email o está inactivo, retorna `void`; NUNCA arrojes 404").

Se implementa así por decisión de producto: se quiere que el frontend pueda decirle al usuario que su cuenta está desactivada en lugar de dejarlo esperando un correo que nunca llega. Cerrarlo es volver al `return` silencioso en `AuthService.requestOtp`; hay una prueba (`DOCUMENTA EL ORACULO DE ENUMERACION`) que falla en cuanto ambos caminos vuelvan a comportarse igual, para que el cambio no pase inadvertido.

Nota: `POST /auth/otp/validate` **sí** sigue devolviendo el mismo 401 genérico para cuenta inexistente, inactiva, sin inscribir y código erróneo. El oráculo está solo en `generate`.

### Pool SMTP: por qué el segundo correo tardaba

Sin `pool`, NodeMailer abre una conexión nueva por envío: saludo SMTP, handshake TLS y autenticación otra vez. Ahí estaban los segundos de latencia. Con `pool: true` la conexión queda abierta y el siguiente envío la reutiliza.

`maxConnections: 1` porque el volumen real es un OTP por inicio de sesión, y abrir varios canales en paralelo solo invita al proveedor a aplicar límites. `maxMessages: 100` recicla la conexión antes de que el servidor la corte por su cuenta.

Efecto secundario que obligó a añadir `onModuleDestroy`: un pool con conexiones abiertas mantiene vivo el bucle de eventos y el proceso de Node no termina. `transporter.close()` al apagar lo resuelve.

### La plantilla del correo es la única excepción a la regla de tokens CSS

`frontend-quasar.md` prohíbe hexadecimales inline, pero un cliente de correo no tiene `var(--pd-*)`: Gmail y Outlook descartan las hojas externas y el `<style>` del `<head>`. La paleta se replica como constantes en `email.service.ts` y todo el CSS va inline, con maquetación en `<table>` porque el soporte de flex/grid en Outlook es irregular.

### Casillas de OTP: por qué el avance escucha `update:model-value` y no `keyup`

`OtpCodeInput.vue` mantiene seis casillas internas pero expone al padre la cadena completa por `v-model`. El avance automático se dispara en `update:model-value` en lugar de en `keyup`, que era lo pedido: el autorrelleno del código desde el gestor de contraseñas o desde la notificación del correo **no genera pulsaciones de tecla**, así que con `keyup` el foco se quedaría clavado en la primera casilla. Pegar el código entero en cualquier casilla lo reparte por las siguientes.

Al completarse las seis emite `complete` y el login valida solo, sin pulsar el botón.

### `q-toggle` del tema: no se ata a `$q.dark.isActive`

`$q.dark.isActive` es de solo lectura — escribirlo no conmuta nada, hay que llamar a `Dark.set()`. Y aunque funcionara, saltarse `useThemeStore` perdería la persistencia en `localStorage` y el tema se olvidaría al recargar. El toggle usa un `computed` con `get`/`set` que delega en el store.

### Guarda RBAC: se redirige, no se cancela

La tarea pedía `next(false)` **y** redirigir a `/`. Son excluyentes en vue-router 4: se devuelve una ubicación o `false`, no ambas. Se devuelve `{ path: '/' }`, que además es lo correcto — `next(false)` deja la barra de direcciones mostrando la URL prohibida, porque el navegador ya la había escrito.

El diálogo usa `Dialog.create()` importado del paquete, no `useQuasar()`: dentro de una guarda no hay componente montado del que obtener la instancia.

`meta.requiresAdmin` va en `/users`, espejando el `@Roles(UserRole.ADMIN)` del `UsersController`. **No es control de acceso**: solo evita pintar una vista que el backend contestaría con 403. La autoridad sigue siendo el `RolesGuard` de NestJS.

### Monitor de expiración: de `setTimeout` a `setInterval`

Un `setTimeout` programado a 59 minutos vista no sobrevive de forma fiable a una suspensión del equipo ni a un salto del reloj del sistema. El sondeo de 1 s recalcula `exp * 1000 - Date.now()` en cada vuelta y se autocorrige solo.

Se conserva el `visibilitychange` de la entrega anterior porque sigue haciendo falta por otro motivo: los navegadores frenan los temporizadores de pestañas en segundo plano hasta ~1 vuelta por minuto, así que al volver podría pasar casi un minuto hasta el siguiente tick.

### Tareas que no tenían dónde aplicarse

- **Formateo de fechas:** no existe ningún componente de trazabilidad, y el CRUD de usuarios no muestra **ninguna** fecha (`User` es `id`, `email`, `role`, `isActive`). Se creó `@/utils/date-format.ts` listo para usar, sin consumidores todavía. Usa `Intl.DateTimeFormat` y **no** `date.formatDate` de Quasar: `formatDate` da formato pero no convierte husos, así que por sí solo no resolvería el problema. Añade la `Z` a las cadenas ISO sin sufijo de zona, porque el navegador las interpretaría como hora local en lugar de UTC.
- **`localStorage`:** ya estaba limpio. Tres claves (`proto-do:access-token`, `proto-do:refresh-token`, `proto-do:user`), sin hashes inventados y sin ningún `setItem` fuera de `session-storage.ts` y `theme.store.ts`. Sin cambios.
- **`mdi-v7` estaba comentado** en `extras` de `quasar.config.ts`, así que `mdi-shield-crown` no habría renderizado. Habilitado; la fuente se empaqueta (`materialdesignicons-webfont-*.woff2`).

---

## 2026-08-26 · Secreto TOTP persistido por cuenta y blindaje de la serialización — rama `feat/auth-otp`

### Qué cambió

El secreto TOTP pasa de **derivarse** (`base32(HMAC-SHA256(OTP_SECRET, correo))`) a ser **aleatorio y persistido** en `usuarios.secreto_otp`. La entrada del 25 documenta el diseño anterior; se conserva como registro histórico.

### Por qué, y qué se pierde

**Se gana:** poder rotar o revocar la inscripción de **un** usuario sin tocar a nadie más. Con una semilla maestra, cambiar `OTP_SECRET` invalidaba los códigos de todas las cuentas a la vez, así que en la práctica no se podía rotar nunca.

**Se pierde, y hay que decirlo:** el secreto se muda a la base de datos. Con la derivación, un volcado de `usuarios` **no** permitía forjar códigos — hacía falta además conocer `OTP_SECRET`, que vive en el entorno del proceso. Ahora un lector de la tabla puede generar códigos válidos para cualquier cuenta. Es exactamente lo contrario del razonamiento que justificó hashear los refresh tokens, y es una regresión consciente aceptada a cambio de la rotación por usuario.

Si esa exposición no resulta aceptable, la salida es cifrar `secreto_otp` en reposo (AES-256-GCM con clave en el entorno): conserva la rotación por usuario y devuelve la propiedad de que el volcado por sí solo no basta. No está implementado.

### La inscripción es perezosa, y por qué el UPDATE es condicional

Las cuentas existentes y las que crea el CRUD no traen secreto. En lugar de una migración de datos, se genera en la primera solicitud de código. Eso deja `secreto_otp` como `NULL`able, que es lo correcto: refleja el estado real "aún no inscrita".

El `UPDATE` de `ensureOtpSecret` filtra por `otpSecret IS NULL` y vuelve a leer el valor persistido. Sin esa condición, dos solicitudes concurrentes sobre la misma cuenta nueva escribirían secretos distintos y el segundo invalidaría el código que el primero ya envió por correo. Con ella, el perdedor de la carrera adopta el secreto ganador y emite un código válido. Hay una prueba AAA para ese caso.

### `verifyOtp` no inscribe

Solo `requestOtp` genera secretos. Si `verifyOtp` recibe una cuenta sin secreto, devuelve el 401 genérico y no inscribe: no existe código legítimo que validar, e inscribir ahí convertiría la ruta de validación en un canal de alta silencioso.

### Doble barrera contra la fuga del secreto

Las dos capas cubren casos distintos y por eso están las dos:

- **`select: false`** en la columna: ningún `find` la trae, así que el secreto ni llega a memoria en el CRUD. Sacarlo exige `addSelect` explícito, que vive en un único método (`findByEmailWithOtpSecret`).
- **`@Exclude()`** de `class-transformer`: actúa cuando el secreto **sí** se ha cargado, que es justo el flujo de autenticación.

Encima, el CRUD responde con `UserResponseDto`, que lleva `@Exclude()` **de clase** en vez de `@Exclude()` campo a campo. La diferencia importa: invierte la política por defecto, de modo que un campo nuevo en la entidad no aparece en la respuesta hasta que alguien lo exponga a propósito. La alternativa —excluir lo sensible— falla en silencio la próxima vez que alguien añada una columna.

`ClassSerializerInterceptor` está en `UsersController` y en `AuthController`. En el de autenticación es defensa en profundidad y hoy no hace nada: `AuthTokenResponse.user` se construye campo a campo como objeto plano, y el interceptor solo transforma instancias de clase. Sirve para el día en que alguien devuelva la entidad desde una ruta de auth.

La prueba de `UsersController` carga el secreto **a propósito** en el doble del servicio y verifica que no aparece en ninguno de los cinco verbos. Al hacerlo saltó una aserción antigua que comparaba la respuesta contra la entidad completa: buena señal, el filtrado funcionaba.

### Lo que la tarea daba por hecho y no existía

- No había **CRON job** ni uso de `@nestjs/schedule` que eliminar; el paquete está instalado pero sin usar.
- No había **tabla de códigos temporales**, sino dos columnas huérfanas en `usuarios` (`codigo_otp`, `expiracion_otp`) que ningún código leía. La migración 003 las retira.
- Los nombres `AuthOtpController` / `AuthOtpService` no existen: son `AuthController` / `AuthService`.
- La columna se llama `secreto_otp`, no `otpSecret`, por coherencia con el resto de `init.sql`; la entidad la mapea con `@Column({ name })` como ya hacía `User`.

### Consecuencia operativa

`OTP_SECRET` dejó de leerse y se retiró de `backend/.env.example`. En `backend/.env` queda como resto inofensivo.

**La migración 003 es requisito de arranque:** hasta aplicarla, `findByEmailWithOtpSecret` falla con `column user.secreto_otp does not exist` y el login entero queda roto. El CRUD sigue funcionando porque `select: false` mantiene la columna fuera del `SELECT` por defecto.

---

## 2026-08-25 · Autenticación OTP y ciclo de sesión con rotación de refresh tokens (PROT-04.1 / PROT-06.4) — rama `feat/auth-otp`

### Punto de partida

PROT-04.2 dejó el `AuthModule` capaz de **verificar** un JWT pero incapaz de emitirlo: no había forma de iniciar sesión. Además, `grep -rni refresh` no devolvía **ninguna** coincidencia en todo el repositorio: cuando el token caducaba, la única salida era volver a pedir un OTP.

### Por qué el secreto TOTP se deriva por usuario

`otplib` trabaja sobre un secreto. La tentación es usar `OTP_SECRET` directamente, y es un fallo grave: el TOTP depende **solo** del secreto y del instante, así que con una semilla compartida el mismo código de 6 dígitos sería válido para **todas** las cuentas en la misma ventana. Cualquiera podría pedir su propio código y entrar como otro.

La derivación es `base32( HMAC-SHA256( OTP_SECRET, email.toLowerCase() ) )`. Al ser determinista no hay nada que persistir: el secreto se recalcula en cada operación. El correo se normaliza (`trim` + minúsculas) para que `ADMIN@UNUWARE.COM` y `admin@unuware.com` no deriven secretos distintos.

**Nota sobre `otplib` v13:** la API `authenticator` de la v12 **ya no existe**. La v13 es modular y hay que inyectar los plugins a mano (`NobleCryptoPlugin`, `ScureBase32Plugin`) en un `new TOTP({...})`, y sus métodos son asíncronos.

### Por qué en la base de datos solo vive el hash del refresh token

El refresh token es una credencial portadora: quien lo tenga renueva la sesión. Guardarlo en claro significa que **una lectura de la tabla** — un volcado, una copia de seguridad extraviada, una inyección SQL de solo lectura — entrega sesiones utilizables de todos los usuarios durante 7 días. Con SHA-256 hexadecimal en `hash_token`, lo que se filtra no sirve para autenticarse: el servicio hashea lo que recibe y compara.

Es exactamente el mismo razonamiento que se aplica a las contraseñas, con **una diferencia deliberada**: aquí no hay sal ni derivación lenta (bcrypt/argon2). Esas defensas existen porque una contraseña humana tiene poca entropía y admite diccionarios precomputados. El token son 256 bits de `randomBytes`, así que no hay nada que precomputar y una función rápida es la elección correcta; encadenar argon2 en cada renovación solo añadiría latencia.

**El token es opaco, no un JWT.** Un JWT sería autovalidable y por tanto irrevocable hasta su caducidad. Que la validez viva en la tabla es justo lo que permite cerrarlo antes de tiempo.

### Rotación y detección de reutilización

Cada `POST /auth/refresh` **revoca** el token presentado y emite uno nuevo. La consecuencia útil es que un refresh token válido solo puede aparecer una vez: si reaparece uno ya revocado, hay dos copias en circulación y una de ellas es de un atacante.

No se puede saber cuál, así que `rotate()` responde revocando **toda la familia** del usuario (`revokeAllForUser`) y devolviendo 401. El legítimo y el ladrón quedan fuera, y recuperar el acceso exige un OTP nuevo al correo corporativo — un canal que el atacante no controla. El coste es que un usuario legítimo puede verse desconectado por una condición de carrera entre pestañas; se acepta a cambio de cerrar el robo de sesión.

Los cinco modos de fallo de `rotate()` (inexistente, revocado, caducado, dueño inexistente, cuenta desactivada) devuelven **el mismo mensaje**: distinguirlos le diría a un atacante en qué estado está la credencial que tiene en la mano. Hay una prueba AAA que verifica esa igualdad literal.

### Decisiones que no son obvias

- **El access token bajó de 8 h a 1 h.** Un JWT es autocontenido: el backend no puede invalidarlo, así que `logout` revoca el refresh pero el access sigue vivo hasta caducar. Ocho horas de ventana para un token robado era demasiado; con refresh tokens la sesión ya no depende de que el access dure mucho. Efecto secundario: el diálogo de expiración del frontend se vuelve verificable a los 59 minutos en lugar de a las 7 h 59 m.
- **`POST /auth/logout` no estaba en el encargo.** Se añadió porque sin él "Cerrar sesión" solo limpiaría el navegador, dejando un refresh token válido **7 días** en la base de datos. Es idempotente: cerrar una sesión ya cerrada no es un error.
- **`generate` devuelve `expiresInSeconds`.** El frontend necesita el tiempo real para su cuenta regresiva y la alternativa era codificar 120 s a ciegas. No rompe la regla anti-enumeración porque es configuración global, idéntica para toda cuenta, exista o no.
- **La respuesta de `generate` es constante.** Correo inexistente y cuenta desactivada devuelven el mismo `202` con el mismo mensaje que un envío real. Sin eso, el endpoint sería un validador de cuentas corporativas.
- **El `ThrottlerGuard` no es global.** Se aplica solo en `AuthController`: el resto de la API no debe pagar un límite calibrado contra la fuerza bruta del OTP. Dentro del controlador, `refresh` y `logout` suben a 10/60 s con `@Throttle` porque tres pestañas abiertas agotarían el cupo de 3.
- **El controlador pasó de `@Controller('auth/otp')` a `@Controller('auth')`** con el prefijo `otp/` bajado a cada handler. `/auth/refresh` no podía colgar de un prefijo de OTP. Las dos URLs existentes no cambiaron.
- **El código OTP nunca sale del correo.** No se retorna, no se registra en logs y hay pruebas que verifican que no aparece en el JSON de respuesta. `EmailService` registra el destinatario y el fallo, jamás el código.

### Esquema y migración

`refresh_tokens` sigue la convención en español de `init.sql` (`id_usuario`, `expiracion`, `revocado`, `fecha_creacion`) y la entidad la mapea a propiedades inglesas con `@Column({ name })`, igual que `User`.

TypeORM corre con `synchronize: false` — y debe seguir así: activarlo dejaría que TypeORM alterase o borrase columnas de las nueve tablas del esquema. Como `init.sql` solo se ejecuta con el volumen `pgdata_protodo` vacío, el DDL vive **duplicado a propósito** en dos sitios: `init.sql` para clonados nuevos y `db/migrations/001-refresh-tokens.sql`, idempotente, para las bases ya pobladas.

**Nota operativa:** el `.env` de este equipo tiene finales de línea **CRLF**, así que un `source backend/.env` deja cada valor con un `\r` pegado. De ahí que los comandos de `psql` documentados lleven usuario y base literales en lugar de `$DB_USER` / `$DB_NAME`.

### El arranque en frío del RBAC (migración 002)

El CRUD de usuarios exige `ADMIN`, pero **crear** un usuario pasa por ese mismo CRUD. Con la tabla `usuarios` sin ningún `ADMIN`, nadie puede crear el primero: un bloqueo circular que la API no puede romper por definición. La verificación en vivo lo destapó — la única cuenta de la base era `EDITOR`, y `GET /api/users` con un token válido devolvía **403** correctamente.

`db/migrations/002-bootstrap-admin.sql` lo rompe desde fuera, y solo eso: promueve la cuenta activa más antigua **si y solo si** no existe ya ningún `ADMIN` activo. Con uno presente no toca nada, porque a partir de ahí gestionar roles es competencia del CRUD y no de una migración.

No se versiona ningún correo concreto: el caso de instalación desde cero queda como un `INSERT` comentado al final del archivo para rellenar con el correo real. La cuenta debe existir en un buzón accesible de verdad — la autenticación es por OTP contra ese correo y no hay contraseña que definir.

### Frontend: por qué el interceptor no lee el token de Pinia

La cadena natural sería `boot/axios → session.store → auth.service → boot/axios`: un ciclo de imports. Se rompe con `src/utils/session-storage.ts`, un módulo **hoja** que no importa nada; tanto el store como el interceptor dependen de él y él de nadie.

Eso lo aparta de la regla "helpers puros, sin I/O" de `frontend-architecture.md` §2.1. Es deliberado y acotado: solo toca `localStorage`, nunca la red, y toda lectura y escritura va con `try/catch` porque en modo incógnito o con las cookies bloqueadas el acceso lanza excepción.

### Dos instancias de Axios, no una

`api` lleva los interceptores; `authApi` es su hermana **sin ninguno**. Sin esa separación, un 401 de `POST /auth/refresh` dispararía el manejador que limpia la sesión y redirige — el propio intento de renovar la sesión la cerraría — y un 401 del login se comería el mensaje de error antes de que `LoginPage.vue` pudiera mostrarlo.

El interceptor de respuesta **no reintenta ni renueva en silencio**: un 401 purga y sale. Renovar es tarea del monitor proactivo, que avisa al usuario; hacerlo también aquí crearía dos caminos compitiendo por el mismo refresh token, y el segundo en llegar activaría la detección de reutilización y tumbaría todas las sesiones.

### El monitor es un composable, no un componente

`useSessionMonitor()` no pinta nada, así que como componente *renderless* incumplía `vue/valid-template-root` (un SFC exige nodo raíz). Se invoca desde `MainLayout.vue`, que envuelve todas las rutas autenticadas: su ciclo de vida coincide con el de la sesión y se desmonta solo al salir a `/login`. El `$q.dialog` sigue viviendo en la capa de componentes; el store nunca conoce Quasar.

### Resiliencia ante suspensión del sistema operativo

`setTimeout` no sobrevive de forma fiable a una suspensión: al despertar puede dispararse tarde, o no haberse disparado mientras el token ya caducaba, dejando al usuario dentro de una sesión muerta hasta que una petición fallara con 401.

Por eso hay un `visibilitychange`: cada vez que la pestaña vuelve a ser visible se **recalcula** `exp * 1000 - Date.now()` contra el reloj real en lugar de confiar en el temporizador. Si el resultado es ≤ 0 no se ofrece renovación — se purga la sesión, se notifica y se redirige de inmediato.

### Otros detalles del frontend

- **`meta: { requiresAuth: true }` va en la ruta padre**, no en cada hijo: una vista nueva bajo `MainLayout` nace protegida sin depender de que alguien recuerde marcarla (Poka-Yoke, mismo criterio que los guards a nivel de clase en `UsersController`).
- **La guarda del router solo mira el estado local.** La autoridad real es el backend, que responde 401. Sirve para no pintar vistas privadas que acabarían vacías, no como control de seguridad.
- **El plugin `Dialog` no estaba registrado** en `quasar.config.ts` (solo `Notify`): sin añadirlo, `$q.dialog` es `undefined`.
- **`isCorporateEmail` subió a `@/utils/corporate-email`.** Vivía dentro de `UserDialog.vue`; al necesitarla también el login se aplicó el criterio de la §3: si otra vista necesita el mismo resultado, sube.
- **El contador del login lee `expiresInSeconds` del backend** y solo cae a 120 s si no llega. Con `OTP_EXPIRATION_MINUTES=5` mostrará 300 s; para el estándar literal de 120 s basta poner `OTP_EXPIRATION_MINUTES=2`.
- **`decodeJwtClaims` decodifica, no verifica.** El navegador no tiene el secreto y cualquier validación de firma en cliente sería teatro; solo sirve para saber *cuándo* caduca. Devuelve `null` ante cualquier anomalía en vez de lanzar.

### Checklist de dependencias restantes

- [ ] **Purga de tokens caducados:** `purgeExpired()` existe pero nadie la llama. Falta engancharla a un `@Cron` de `@nestjs/schedule` (ya instalado); mientras tanto, la tabla solo crece.
- [ ] **`SMTP_HOST=smtp.example.com`:** hasta poner credenciales reales, `requestOtp` responde 500 y el recorrido de extremo a extremo exige leer el código de otra forma.
- [ ] **Columnas `codigo_otp` / `expiracion_otp` de `usuarios`:** quedaron huérfanas en `init.sql`. El diseño TOTP no persiste códigos, así que deberían eliminarse en una migración futura.
- [ ] **`test/app.e2e-spec.ts`:** sigue siendo el boilerplate de `nest new` y falla al exigir Postgres. No se tocó.
- [ ] **Credenciales SMTP reales:** con `SMTP_HOST=smtp.example.com` el login por navegador no se puede completar. La verificación se hizo derivando el código OTP con la misma función del backend.

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

---

## 2026-08-27 · Endurecimiento del ciclo de vida del JWT (PROT-06.4) — rama `feat/auth-otp`

Auditoría de la coordinación entre el interceptor de Axios, `session.store.ts` y `useSessionMonitor.ts`. La funcionalidad ya estaba completa (decodificación de `exp`, aviso a 60 s, renovar / cerrar, limpieza de temporizadores); lo que fallaba era el reparto de responsabilidades entre las tres piezas. Cuatro defectos, ninguno visible en la ruta feliz.

**Se descartó mover el temporizador al store.** Un `setTimeout` calculado a `timeRemaining - 60000` se programa, con un JWT de 60 minutos, a 59 minutos vista: no sobrevive a una suspensión del equipo ni a un salto del reloj del sistema, y el usuario recibiría un 401 seco en vez del aviso. El sondeo de 1 s recalcula contra `Date.now()` en cada vuelta y se autocorrige. Además, un `$q.dialog` dentro del store rompe `frontend-architecture.md` §2.1 y obliga a `useQuasar()` fuera de un `setup()`.

### Defecto 1 — El interceptor 401 desincronizaba el store (crítico)

`boot/axios.ts` llamaba a `clearSession()`, el helper de `localStorage`, **no** a `sessionStore.clear()`. Los refs de Pinia quedaban vivos con el token muerto, y como la guarda del router lee `isAuthenticated`, la redirección a `/login` rebotaba a `/` (`router/index.ts:78`): el usuario quedaba atrapado en un dashboard sin tokens, con cada petición dando 401 y **sin poder alcanzar el login**. Peor: `refreshToken.value` seguía en memoria, así que "Mantener sesión" podía resucitar una sesión ya rechazada por el backend.

El arreglo purga el store. El import de `@stores/session.store` es **diferido dentro del manejador**, no en el nivel de módulo: ahí cerraría el ciclo `boot → store → service → boot` que documenta `session-storage.ts`. La instancia de Pinia sale del parámetro `store` que `defineBoot` ya recibía sin usarse. `clear()` invoca `clearSession()` por dentro, así que el helper dejó de importarse en `axios.ts`.

### Defecto 2 — Carrera entre `refreshTokens()` y el sondeo

`.onOk()` bajaba `isDialogOpen` **antes** de que la renovación resolviera, y el sondeo seguía corriendo sobre el token viejo. Al tick siguiente el aviso se reabría encima de la renovación en curso; y si la petición tardaba más que el tiempo restante, `millisecondsUntilExpiry <= 0` disparaba `logout()` **con el refresh en vuelo** — la renovación resolvía después y `applyTokens()` reescribía `localStorage`, dejando una sesión zombi con el usuario ya en `/login`.

Se añadió el flag `isRefreshing`, levantado *antes* de lanzar la petición (el siguiente tick llega en 1 s) y bajado en el `finally`. Lo respetan como guarda temprana tanto `checkExpiry()` como `onVisibilityChange()`: volver a la pestaña durante una renovación tampoco debe cerrar la sesión mirando el token que está a punto de morir.

### Defecto 3 — Diálogo huérfano al expirar

`terminateSession()` no cerraba un diálogo abierto. Al ser `persistent` y montarse fuera del árbol de `MainLayout`, quedaba flotando sobre la vista de login. Se conserva el `DialogChainObject` que devuelve `$q.dialog()` y se llama a `.hide()` desde `closeExpiryDialog()`. La cuenta regresiva interna de `SessionExpiryDialog.vue` se mantiene como respaldo visual, pero la autoridad sobre la terminación pasa a ser sólo el monitor.

### Defecto 4 — Sondeo residual tras `clear()`

`clear()` pone `accessToken = null`, lo que dispara el `watch` → `scheduleWarning()`, que reinstalaba un `setInterval` de 1 s aunque `checkExpiry` saliera de inmediato por `millisecondsUntilExpiry === null`. Ahora `scheduleWarning()` sale sin reinstalar el intervalo cuando no hay token legible.

### Deuda técnica conocida: multi-pestaña — **RESUELTA el 2026-08-27**

> **Resuelto.** El listener de `storage` en `session.store.ts` propaga el par nuevo entre pestañas (ver la entrada de revocación por dispositivo, al principio del archivo). Lo que sigue se conserva como registro del problema.

Cada pestaña corre su propio monitor **sin sincronización**. Si la pestaña A renueva, el backend rota el refresh token; la pestaña B conserva el viejo en memoria y al pulsar "Mantener sesión" lo presenta de nuevo — lo que según `auth.service.ts` **derribaría todas las sesiones del usuario** por detección de reuso. No se abordó aquí: el arreglo (listener de `storage` para propagar el par nuevo, o un lock de renovación en `localStorage`) es un cambio de mayor calado.

### Verificación

`npx vue-tsc --noEmit` sin errores, `eslint` sobre los dos archivos tocados con salida limpia y `npm run build` correcto (SPA, Quasar v2.25.1). `session.store.ts`, `jwt.ts` y `SessionExpiryDialog.vue` no se tocaron: su lógica ya era correcta.

### Checklist de dependencias restantes

- [x] **Multi-pestaña** — *resuelto el 2026-08-27* con el listener de `storage` en `session.store.ts`.
- [ ] **Tests**: faltan las pruebas AAA de `decodeJwtClaims` (base64url con relleno, token corrupto, `exp` ausente) y del monitor con temporizadores falsos de Jest — en particular la carrera del Defecto 2.
- [ ] **`trust proxy`**: sigue pendiente de la definición del proxy inverso de despliegue.

---

## 2026-08-27 · Poda transaccional de refresh tokens (PROT-06.4) — rama `feat/auth-otp`

Cierra la mitad del punto pendiente *"la tabla solo crece"*: cada emisión de token limpia ahora las filas muertas de ese usuario. La poda vive en `RefreshTokenService.issue()`, **no** en `AuthService` — este último no inyecta repositorio, y `RefreshTokenService` es el único punto del backend que conoce la tabla (`code-conventions.md` §2).

### Por qué no se poda "por los 2 más recientes"

La regla intuitiva —conservar los N tokens más recientes por `createdAt`— **borra tokens activos de otros dispositivos**. Con dos sesiones abiertas:

| Paso | Filas del usuario (`createdAt` desc) | Poda "top 2" |
|---|---|---|
| Portátil inicia sesión | `A(activo)` | — |
| Móvil inicia sesión | `B(activo)`, `A(activo)` | conserva B, A |
| Móvil refresca: `rotate(B)` revoca B, `issue()` inserta D | `D(activo)`, `B(revocado)`, `A(activo)` | conserva D, B → **borra A** |

El refresco rutinario de un equipo expulsa al otro, porque el token revocado `B` ocupa una de las dos plazas. De facto limita a un solo dispositivo, y la expulsión es silenciosa: la víctima recibe un 401 genérico. Con tres dispositivos, el tercer login mata al primero directamente.

### Regla adoptada

> Borrar los tokens **ya inservibles** (revocados **o** caducados) del usuario, **excepto los `RETAINED_DEAD_TOKENS = 5` más recientes**. Un token vigente no se toca jamás, sea cual sea su antigüedad.

Los 5 supervivientes no son decorativos: son la ventana de detección de reutilización de `rotate()`. Un token robado que reaparece dentro de esas últimas rotaciones todavía encuentra su fila y dispara `revokeAllForUser()`; sin ella daría un 401 plano, la familia no caería y la brecha pasaría desapercibida. Es el control que la FSM de `PLAN.md:202` dibuja como `rotate() de nuevo ⇒ REUTILIZACIÓN`.

El crecimiento queda acotado a `sesiones_vivas + 5` filas por usuario.

### Detalles de implementación

- **Transacción sin `DataSource`.** Se usa `this.refreshTokenRepository.manager.transaction()`, que llega gratis con el repositorio ya inyectado. Evita un provider nuevo y deja `auth.module.ts` intacto. Si la poda falla, el token nuevo tampoco se persiste.
- **El orden insertar → podar es la propiedad de seguridad.** El token recién creado nace `isRevoked: false` con `expiresAt` futuro, así que nunca entra en el filtro de candidatos. No hace falta excluirlo explícitamente.
- **Dos pasos (`find` + `delete`) en vez de un `DELETE ... NOT IN (subquery)`.** Dentro de la transacción es igual de seguro, se expresa con nombres de propiedad de la entidad en lugar de columnas crudas (`id_usuario`, `revocado`, `expiracion`) y es trivial de mockear. El `where` en forma de array es el OR revocado/caducado.
- **Sin migración.** El índice `idx_refresh_tokens_id_usuario` ya cubre el filtro; ordenar unas pocas filas por usuario es trivial. Relevante porque `app.module.ts:35` fija `synchronize: false`.
- **El doble de repositorio del spec se devuelve a sí mismo** como repositorio transaccional (`manager.transaction` ejecuta el callback en el acto con un `getRepository` que retorna el mock). Sin ese puente, las tres pruebas previas de `issue` rompían al no encontrar `manager`.

### Verificación

85 pruebas en verde (9 suites), 5 nuevas sobre la poda: transacción única, criterio con `skip`/`order`/`where` de dos ramas, retorno temprano sin candidatos, borrado por ids exactos y regresión de la sesión vigente ajena. `eslint` limpio y `nest build` correcto. Nota: `refresh-token.service.spec.ts:13` arrastra un error de `tsc` preexistente (`otpSecret` ausente en el literal `ACTIVE_USER`), anterior a este cambio y no introducido aquí.

### Checklist de dependencias restantes

- [ ] **`@Cron` sobre `purgeExpired()`:** la poda de `issue()` solo actúa cuando el usuario emite un token; una cuenta que deja de entrar conserva sus 5 filas muertas indefinidamente. El barrido periódico con `@nestjs/schedule` (ya instalado) sigue pendiente.
- [ ] **`rotate()` e `issue()` no comparten transacción:** la revocación se confirma antes de que `AuthService.buildTokenResponse` llame a `issue()`. Si la emisión fallara, el usuario queda sin token y debe reentrar por OTP. Comportamiento **preexistente**; unificarlo exige propagar un `EntityManager` a través de `buildTokenResponse`.
- [ ] **`ACTIVE_USER` sin `otpSecret`** en `refresh-token.service.spec.ts`: error de `tsc` pendiente desde la incorporación de TOTP.

---

## 2026-08-27 · Bloqueo de auto-modificación/eliminación en el CRUD de usuarios (MOD-01) — rama `feat/auth-otp`

Un ADMIN autenticado podía ejecutar `PATCH /users/:id` o `DELETE /users/:id` sobre su propio `id`: desactivarse o degradar su propio rol lo dejaría fuera del único módulo que gestiona cuentas, sin otro ADMIN activo que lo revirtiera.

- **Nuevo `@common/decorators/current-user.decorator.ts`.** No existía forma de extraer `req.user` fuera de un guard; los guards acceden directo a `context.switchToHttp().getRequest<RequestWithUser>()` (`roles.guard.ts:29`). El decorador reutiliza ese mismo contrato — mismo patrón que `public-ip.decorator.ts` para un concepto transversal — y no repite la comprobación de "sin usuario": para cuando se evalúa, `RolesGuard` ya lanzó `ForbiddenException` si `req.user` faltaba.
- `UsersController.update()` y `.remove()` reciben `@CurrentUser() currentUser: AuthenticatedUser` y abren con `assertNotOperatingOnSelf()`, extraído como método privado en vez de duplicar el `if` en los dos endpoints.
- `@ApiForbiddenResponse` de clase actualizado para reflejar la causa nueva del 403.

### Verificación

87 pruebas en verde (85 previas + 2 nuevas: PATCH y DELETE contra el propio `ADMIN_USER.id` → 403, servicio no invocado), reutilizando el arnés existente de `users.controller.spec.ts` (app real con `RolesGuard` auténtico). `eslint` limpio, `nest build` correcto. El error de `tsc` en `refresh-token.service.spec.ts:13` sigue siendo el mismo preexistente, ajeno a este cambio.

---

## 2026-08-27 · El CRUD de usuarios muestra el motivo real del error (no un texto genérico) — rama `feat/auth-otp`

Tras MOD-01, un ADMIN que intenta modificar o eliminar su propia cuenta recibía un toast
genérico ("No se pudo guardar el usuario") en vez del mensaje real del backend
("Operación denegada: No puedes modificar ni eliminar tu propio usuario."). La causa no era
específica de MOD-01: los cuatro `catch` del CRUD de usuarios (`UserDialog.vue` `onSubmit`,
`UsersManager.vue` `confirmDeactivation`/`activateUser`/`loadUsers`) usaban `catch {}` **sin
parámetro**, así que era estructuralmente imposible que leyeran el error real.

- Nuevo helper puro `frontend/src/utils/api-error.ts`: `extractApiErrorMessage(error, fallback)`
  lee `error.response.data.message` con el mismo patrón de detección que
  `boot/axios.ts:47` (`axios.isAxiosError`). Normaliza tanto el `string` de un
  `ForbiddenException(...)` como el `string[]` de un error de validación de `class-validator`.
  `fallback` conserva exactamente el texto que cada sitio mostraba antes, para errores de red o
  respuestas sin este formato.
- Los cuatro `catch` pasaron a recibir el error y usar el helper con su fallback original. No se
  tocó `users.store.ts` ni `users.service.ts`: las excepciones ya se propagaban sin capturar
  (`frontend-architecture.md` §2.1), que es justo lo que este cambio necesitaba.
- `SafeDeleteModal.vue` no se tocó: es un componente genérico de confirmación ajeno al resultado
  de la operación; el `$q.notify` con el mensaje correcto sigue apareciendo después de cerrarse.

### Verificación

`eslint --fix` limpio, `vue-tsc --noEmit` sin errores, `npm run build` correcto. Sin pruebas
automatizadas: el frontend no tiene arnés de tests todavía (deuda ya anotada en este archivo).
Verificación manual pendiente para quien pruebe contra el backend real: editar/desactivar la
propia cuenta ADMIN debe mostrar el mensaje de MOD-01 textual, no el genérico.

---

## 2026-08-29 · Contratos y validación topológica del `pipeline_schema` (PROT-07) — rama `feat/fsm-contracts`

Primera pieza del motor FSM. Antes de escribir una sola estrategia hacía falta el contrato del grafo
que el `FsmEngineService` va a recorrer: sin él, un `configuracion_pipeline` mal formado —un
`nextStep` colgando, dos nodos escribiendo el mismo namespace, un camino que nunca termina— solo se
descubriría en runtime, con la ejecución a medias y el `StatePayloadContext` ya corrompido. Este
cambio mueve ese fallo al momento de guardar el flujo.

### `@ValidateNested({ each: true })` no funciona sobre un `Record`

El diseño de partida ponía `@ValidateNested({ each: true })` + `@Type(() => PipelineNodeConfigDto)`
sobre `nodes: Record<string, PipelineNodeConfigDto>`. No valida nada. En class-validator 0.15.1
(`node_modules/class-validator/cjs/validation/ValidationExecutor.js:272`) la rama `each` solo se
activa para `Array`, `Set` y `Map`:

```js
if (Array.isArray(value) || value instanceof Set || value instanceof Map) { /* itera */ }
else if (value instanceof Object) { this.execute(value, targetSchema, error.children); }
```

Un objeto plano cae a la segunda rama y valida el **mapa entero** como si fuera un único
`PipelineNodeConfigDto`; `@Type` lo empeora convirtiendo el `Record` completo en una sola instancia.
Sumado a `forbidNonWhitelisted: true`, el resultado habría sido un error `property nodo_trigger
should not exist` por cada nodo, sin llegar a validar un solo campo real.

La iteración se hace a mano en `PipelineValidatorService.validateNodes()`. No es solo un parche: al
recorrer `Object.entries(nodes)` se conserva la clave del nodo en la ruta del error
(`nodes.nodo_ia.retryPolicy.maxRetries`), que es exactamente lo que el wizard del frontend necesita
para señalar el paso culpable. Con el decorador nunca se habría tenido esa ruta.

### Por qué `onErrorStep` sí puede apuntar hacia atrás

El recorrido de detección de ciclos sigue **solo** `nextStep`. Un `onErrorStep` que vuelve a un nodo
anterior no es un defecto sino el patrón de reintento o recuperación; prohibirlo habría impedido
modelar declarativamente lo que el protocolo de resiliencia (`architecture-patterns.md` §4) ya
contempla. El grafo de `nextStep` es funcional —un sucesor como máximo por nodo—, así que basta un
recorrido lineal con un `Set` de visitados: no hace falta DFS ni componentes fuertemente conexas.

### Por qué los nodos huérfanos no invalidan el esquema

Un nodo inalcanzable desde el `entrypoint` se ignora en silencio. Un flujo en construcción puede
tener ramas todavía sin conectar, y rechazar el esquema entero por eso convertiría el validador en
un estorbo durante la edición. Lo que sí es innegociable es que el camino activo **termine**: si
`nextStep` cierra un ciclo, no hay nodo terminal y la ejecución no pararía nunca.

### Detalles de implementación

- `NodeType` es un `enum` de TypeScript y no un union type: `@IsEnum()` necesita un objeto
  disponible en runtime.
- `nextStep` / `onErrorStep` usan `@ValidateIf((_, value) => value !== null)` y no `@IsOptional()`.
  `null` es un valor legítimo (nodo terminal), `undefined` no: `@IsOptional()` habría dejado pasar
  un campo ausente. Comprobado que esto no rompe el whitelist —`ValidationExecutor.whitelist()` solo
  descarta propiedades sin metadata alguna, y estas la tienen.
- La topología se ejecuta **solo** si forma y tipos ya son válidos. Sobre un `nextStep` numérico o un
  `nodes` que no es objeto, esas comprobaciones solo añadirían ruido sobre el error real.
- `Object.hasOwn()` en lugar de `Object.prototype.hasOwnProperty.call()`: lo segundo devuelve `any` y
  disparaba `@typescript-eslint/no-unsafe-return`.
- El validador topológico es una función pura sin DI ni estado, testeable al margen de Nest.
- `db/migrations/005-tipos-nodo-fsm.sql` alinea `tipos_nodo` con el enum: `NODO_PARSER_CORREO` →
  `PARSER_PRE_IA`, `NODO_VALIDACION` → `ESCUDO_POST_IA`, `DESTINO_DRUPAL` → `DESTINO_HTTP`. Como
  `codigo` es `VARCHAR(50) UNIQUE` y no un `ENUM` de PostgreSQL, basta un `UPDATE`. **No se borra
  ninguna fila**: `nodos.id_tipo_nodo` es FK contra esta tabla, así que `TRIGGER_CRON` y
  `DESTINO_ACENS` se quedan en el catálogo aunque hoy no sean declarables en un `pipeline_schema`.

### Verificación

16 pruebas nuevas en verde (109 en total en el backend), cubriendo los 5 casos obligatorios —Notiweb
completo de 7 nodos, huérfano aceptado, ciclo rechazado, namespace duplicado, clave ≠ `nodeId`— más
`entrypoint` inexistente, punteros colgantes, `nodeType` fuera del enum, `maxRetries > 5`,
`onErrorStep` hacia atrás aceptado, propiedad desconocida, `outputNamespace` no snake_case, `version`
no SemVer, nodo que no es objeto y payload que no es JSON. `npx tsc --noEmit` sin errores,
`eslint "src/core/**/*.ts"` limpio.

La migración `005` **no se pudo aplicar** en esta sesión: el demonio de Docker exige `sudo` con
contraseña interactiva. Queda pendiente de ejecutar contra el contenedor.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql`** contra `protodo_postgres` y comprobar el
      `SELECT` final (7 códigos del enum + `TRIGGER_CRON` + `DESTINO_ACENS`).
- [ ] **`FsmModule`**: `PipelineValidatorService` está `@Injectable()` pero no lo declara ningún
      módulo. Se registrará cuando exista su primer consumidor (el CRUD de flujos).
- [ ] **Entidad TypeORM `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`, para
      invocar el validador antes de persistir.
- [ ] **`StatePayloadContext`, `INodeStrategy`, `NodeStrategyFactory`**: el resto del contrato del
      motor sigue sin implementar (`architecture-patterns.md` §2 y §3).
- [ ] **Ampliar `NodeType`** con `TRIGGER_CRON` y un destino Acens cuando se escriban sus
      estrategias; hasta entonces esas dos filas del catálogo son inalcanzables desde un pipeline.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e, así que la
      suite e2e sigue rota (deuda previa, ajena a PROT-07).

---

## 2026-08-29 · Contexto inmutable, mutex de ejecución y limpieza en arranque (PROT-08) — rama `feat/fsm-payload-context`

PROT-07 dejó el contrato del grafo, pero el motor seguía sin poder ejecutar nada: faltaba la
estructura que transporta los resultados entre nodos y la fila donde se persiste el checkpoint.
Además `PipelineValidatorService` había quedado `@Injectable()` sin módulo que lo declarara — código
inalcanzable desde el contenedor de Nest.

### `structuredClone` en ambas direcciones, no *spread*

El enunciado pedía inmutabilidad estricta y la implementación de referencia de
`architecture-patterns.md` §3 la resuelve con *spread*. No basta: el *spread* copia superficialmente,
así que `context.getNamespace('ia').meta.titulo = 'otro'` alcanza el objeto interno a través del
segundo nivel y corrompe un checkpoint que quizá ya se había dado por bueno. `StatePayloadContext`
clona en profundidad la entrada de `setNamespace`, su salida, y la de `getAllContext`. Hay tres
pruebas que fuerzan exactamente esa fuga —mutando la salida en dos niveles, y mutando el objeto de
entrada *después* de haberlo escrito— para que la garantía no dependa de que nadie toque el código.

`setNamespace` además **fusiona** con el namespace existente en vez de reemplazarlo, de modo que un
nodo pueda escribir en dos tandas sin perder lo anterior.

### El mutex necesita la reconciliación, o se autobloquea

`idx_flujo_activo` es un índice único **parcial**: `UNIQUE (id_flujo) WHERE estado = 'EN_PROCESO'`.
La garantía la da PostgreSQL, no un bloqueo en memoria que se perdería al escalar a varios procesos,
y al ser parcial deja fuera los estados terminales: un flujo puede acumular todo el histórico de
ejecuciones que haga falta, pero solo una viva.

Ese diseño tiene un fallo latente que obliga a la segunda mitad del cambio. Una fila `EN_PROCESO`
afirma "hay un bucle atendiendo este flujo ahora mismo". Tras un reinicio esa afirmación es falsa:
no queda ningún bucle, pero la fila **sigue reservando el mutex** y el flujo no podría volver a
arrancar nunca. De ahí el `onModuleInit` de `FsmModule`, que las pasa a `PAUSADO` al levantar: libera
el índice y las deja donde el protocolo de resiliencia (`architecture-patterns.md` §4) espera
encontrarlas para el reintento de CU-09.

El error de esa reconciliación **no se captura** a propósito: arrancar el motor sobre un estado que
no se ha podido reconciliar es peor que no arrancar. Se registra con `Logger.warn` cuántas filas se
reconciliaron, y silencio cuando son cero.

La clase del módulo inyecta el repositorio directamente por constructor —Nest lo permite igual que en
cualquier provider— en vez de crear un servicio intermedio que hoy no tendría más responsabilidad.

### La interpolación falla en vez de callar

`getInterpolatedValue` lanza `MissingContextVariableException` ante una variable ausente o nula, en
lugar de resolverla como `''` como hace la implementación de referencia. Interpolar en silencio
publicaría en Drupal un artículo con el título vacío, y el fallo aparecería aguas abajo, lejos de su
causa. La excepción lleva el nombre de la variable culpable (`ia_result.titulo`) para que el mensaje
sea accionable.

Por el mismo motivo, un valor no escalar **no** se convierte con `String()`. El linter lo detectó
(`@typescript-eslint/no-base-to-string`) y tenía razón: un objeto mapeado por error habría acabado
como el literal `[object Object]` dentro del artículo publicado. Ahora las cadenas se insertan tal
cual y todo lo demás pasa por `JSON.stringify`, que además resuelve números y booleanos sin añadir
comillas (`42` → `42`).

### Detalles de implementación

- **`FsmExecution` mapea `ejecuciones_flujo`**, la tabla que ya existía, en vez de crear una
  `fsm_executions` paralela. `logs_nodo` y `alertas_error` tienen FK apuntándole; duplicarla habría
  dejado dos fuentes de verdad para el mismo concepto. Propiedades en inglés, columnas en español
  vía `@Column({ name })`, igual que `User` y `RefreshToken`. Es la primera entidad del proyecto con
  columnas `jsonb`.
- `ruta_archivo_log` y `fecha_fin` quedan sin mapear, como `User` no mapea `fecha_creacion`; entran
  con el protocolo de resiliencia.
- **El decorador `@Index` no crea nada** con `synchronize: false`. Es declarativo; el índice real lo
  crea la migración. Va dicho en un comentario de la entidad para que nadie lo dé por aplicado.
- `StatePayloadContext` **no** es `@Injectable()`: se instancia una por ejecución. Un provider sería
  un singleton compartido entre ejecuciones concurrentes, justo lo contrario de lo que necesita ser.
- `db/migrations/006-fsm-execution-mutex.sql` añade `INACTIVO` al tipo `enum_estado` con
  `BEFORE 'EN_PROCESO'` (orden natural del ciclo de vida), crea `retry_state` y
  `fecha_actualizacion`, normaliza `contexto_acumulado` a `NOT NULL DEFAULT '{}'` y crea el mutex.
  La cabecera avisa de dos cosas: es **requisito de arranque** (sin ella el `onModuleInit` falla por
  la columna `fecha_actualizacion` que añade `@UpdateDateColumn` al `SET`), y **no debe envolverse en
  `BEGIN`/`COMMIT`** porque PostgreSQL prohíbe usar un valor de enum en la misma transacción en que
  se añade.
- El endpoint `POST /api/fsm/validate-schema` lleva `@PublicIp()` y **queda sin ninguna protección**:
  es el único guard global, `JwtAuthGuard` no lo es, y `RedLocalMiddleware` solo cubre las rutas de
  Swagger. Es temporal y para Postman; va marcado con `TODO(PROT-08)` en el propio controlador.
  Mitigación mientras tanto: no lee ni escribe en base de datos, solo valida un JSON en memoria.
- Comprobado que el `ValidationPipe` global no interfiere con `@Body() rawJson: unknown`: `unknown`
  emite `Object` como metatipo y `ValidationPipe.toValidate()` descarta ese tipo
  (`validation.pipe.js:119`), así que el cuerpo llega intacto — imprescindible, porque el servicio
  necesita ver las propiedades no declaradas para rechazarlas.

### Verificación

17 pruebas nuevas en verde (126 en total en el backend), cubriendo los 3 casos obligatorios —copias
profundas, aislamiento entre namespaces, interpolación múltiple y excepción ante nulos— más fusión
sin pérdida, clonado del objeto de entrada, `getAllContext`, namespace ausente, cursor e
identificadores, espacios dentro de las llaves, plantilla sin variables, namespace inexistente,
`null` explícito, el nombre de la variable en la excepción, y la serialización de números, booleanos
y objetos. `npx tsc --noEmit` sin errores, `npm run lint` limpio (queda el warning preexistente de
`main.ts:59`, ajeno a este cambio), `nest build` correcto.

**Sin verificación contra la base de datos**: las migraciones las aplica el usuario. Ni el mutex ni
la reconciliación de arranque se han ejercitado todavía contra PostgreSQL.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Verificar el mutex** con dos `INSERT` `EN_PROCESO` del mismo `id_flujo` (debe violar
      `idx_flujo_activo`) y la reconciliación reiniciando el backend con una fila viva.
- [ ] **Proteger o retirar `POST /api/fsm/validate-schema`** antes de cualquier despliegue: quitar
      `@PublicIp()` y añadir `@UseGuards(JwtAuthGuard, RolesGuard)`.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema` e invoque el
      validador antes de persistir.
- [ ] **`FsmEngineService`, `INodeStrategy`, `NodeStrategyFactory`**: el bucle de ejecución que
      consumirá `StatePayloadContext` y escribirá los checkpoints sigue sin implementar.
- [ ] **Servicio de dominio sobre `FsmExecution`**: la entidad se declara y se reconcilia, pero
      ninguna lógica de negocio la consulta todavía.
- [ ] **Ampliar `NodeType`** con `TRIGGER_CRON` y un destino Acens cuando se escriban sus estrategias.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Motor FSM, bucle de ejecución y factoría de estrategias (PROT-09) — rama `feat/fsm-engine`

PROT-07 definió el grafo y PROT-08 la memoria inmutable con su checkpoint, pero nada los recorría:
`StatePayloadContext` no lo consumía ningún servicio y `ejecuciones_flujo` solo se tocaba en la
reconciliación de arranque. Este cambio pone el orquestador.

### Resiliencia de dos niveles

El motor tiene dos `try` con responsabilidades distintas, y confundirlos sería el error clásico:

- **Interno (`runNode`)**: aísla el fallo de *un nodo*. Cualquier excepción no controlada de una
  estrategia —incluida `StrategyNotFoundException`— se normaliza a un `NodeResult` con nivel
  `URGENTE` en vez de propagarse. Un nodo defectuoso no puede tumbar la ejecución entera, y mucho
  menos el proceso de Node.
- **Externo**: atrapa el fallo catastrófico, típicamente que PostgreSQL deje de responder. Registra,
  intenta marcar `FALLIDO` y **re-lanza**, porque quien invocó el motor tiene que enterarse.

El intento de marcar `FALLIDO` va envuelto en su propio `try/catch`: si lo que falló fue justamente
la base de datos, ese guardado también fallará, y no debe enmascarar el error original.

### La validación previa queda fuera del `try` externo

Buscar la ejecución, comprobar que no esté ya `EN_PROCESO` y marcarla se hacen **antes** de abrir el
`try`. No es un descuido. Si marcar `EN_PROCESO` choca contra el mutex `idx_flujo_activo` —porque
otra ejecución del mismo flujo está viva—, la excepción debe propagarse **sin** marcar `FALLIDO`: no
ha fallado el flujo, simplemente no le tocaba el turno. Meterlo dentro del `try` habría convertido
una colisión de concurrencia perfectamente normal en una ejecución marcada como rota.

### Defensa en dos capas contra ciclos, y por qué los reintentos van anidados

PROT-07 permite **a propósito** que `onErrorStep` apunte hacia atrás: es el patrón de recuperación.
El precio es que `A → falla → B → A` es un esquema topológicamente válido que, con un
`while (cursor !== null)` desnudo, colgaría el worker para siempre. De ahí las dos capas:

| Capa | Mecanismo | Qué acota | Al agotarse |
|---|---|---|---|
| 1 | `@Max(5)` en `RetryPolicyDto` (ya existía, de PROT-07) | Reintentos intra-nodo, sin mover el cursor | Fallback a `onErrorStep` o `PAUSADO` |
| 2 | `MAX_TRANSITIONS = 100` | Saltos entre nodos | Log `URGENTE` + `PAUSADO` |

La decisión de diseño que las mantiene separadas: **los reintentos viven en un bucle anidado**, no en
un `continue` del bucle externo. Reintentar con `continue` habría hecho que cada reintento consumiera
presupuesto de transiciones, mezclando dos conceptos que no tienen nada que ver — un nodo con
`maxRetries: 5` habría gastado cinco saltos de grafo sin moverse del sitio. Anidándolo, el contador
cuenta saltos reales *por construcción*, sin excepciones que recordar al leer el código. Hay una
prueba dedicada a eso: tres ejecuciones del mismo nodo producen una sola transición.

### Otras decisiones que no son obvias

- **Solo `GRAVE` reintenta.** `URGENTE` es irrecuperable (contrato roto, credenciales, dato corrupto)
  y `LEVE` no justifica insistir; ambos van directos a `onErrorStep` o a `PAUSADO`. La severidad
  gobierna el control de flujo, no solo la traza.
- **El contador de reintentos no se limpia al tener éxito.** Es por ejecución, no por visita: si un
  `onErrorStep` hacia atrás devuelve el flujo a un nodo que ya agotó intentos, no vuelve a
  reintentar. Acota el trabajo total y complementa el circuit breaker.
- **`initialPayload` aterriza en el namespace reservado `trigger`**, de modo que las plantillas lo
  interpolan como `{{trigger.campo}}` con independencia de qué nodo dispare el flujo.
- **Al terminar no se escribe un `EN_PROCESO` con cursor nulo.** La primera versión persistía ese
  estado intermedio y acto seguido `EXITOSO`: dos `UPDATE` para el mismo instante lógico, y un estado
  sin significado en la tabla. Lo detectó una aserción de la prueba del flujo lineal al contar los
  checkpoints. Ahora el nodo terminal rompe el bucle y la finalización escribe `EXITOSO` directamente.
- **`checkpoint()` hace `Object.assign` sobre la entidad en memoria** además del `update`, así la
  instancia devuelta refleja el estado final sin un `findOne` extra.
- **`QueryDeepPartialEntity` no admite un `Record` con firma de índice**: intenta hacerlo parcial
  recursivamente y no cuadra con `Record<string, unknown>`. Hizo falta un cast acotado en el `update`,
  documentado en el propio archivo; es seguro porque `CheckpointPatch` solo declara columnas reales.
- **El registro de estrategias es explícito**, no por descubrimiento automático: una estrategia solo
  entra en juego si alguien la declara, lo que evita que un archivo suelto en `src/strategies/` se
  active sin querer. `NodeStrategyFactory` se exporta desde `FsmModule` para que los módulos de nodos
  registren contra la misma instancia que consume el motor.

### Verificación

18 pruebas nuevas en verde (144 en total en el backend). Cubren los casos obligatorios —flujo lineal
de 3 nodos, reintento intra-nodo sin alterar la ruta, límite del DTO, fallo con `onErrorStep`, fallo
sin fallback, aislamiento de excepción, estrategia inexistente, circuit breaker cortando en
exactamente 100 visitas, y reanudación desde el cursor persistido— más `LEVE` sin reintentar, el
backoff exponencial con temporizadores falsos, el namespace `trigger` interpolable, y las
precondiciones (`NotFoundException`, `ConflictException`) junto al fallo catastrófico.

Las pruebas usan la **factoría real** con estrategias falsas registradas, no un doble de la factoría:
así se ejercita de verdad el camino de registro y resolución, y el caso de estrategia inexistente
sale gratis con no registrar nada.

`npx tsc --noEmit` sin errores, `npm run lint` con 0 errores (queda el warning preexistente de
`main.ts:59`), `nest build` correcto.

**Sin verificación contra la base de datos**: el repositorio va mockeado y las migraciones siguen
pendientes de aplicar.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Estrategias concretas** en `src/strategies/` y su registro en `NodeStrategyFactory`
      (PROT-10). Hoy la factoría arranca vacía y cualquier flujo pausaría en el primer nodo.
- [ ] **Quién invoca `executeWorkflow`**: no hay endpoint, disparador ni consumidor de cola todavía.
- [ ] **Volcado a `.log` físico con Winston** y fila en `alertas_error` ante un fallo
      (`architecture-patterns.md` §4, pasos 1 y 2). Hoy el motor solo escribe en el `Logger` de Nest.
- [ ] **Notificación WebSocket** (`node_started`, `node_completed`, `flow_finished`, `flow_failed`) a
      la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: «asíncrono» aquí es `async/await`; el bucle corre en el proceso que lo invoca
      y el backoff duerme ese hilo. Las ejecuciones pesadas deben pasar a productor-consumidor (§5).
- [ ] **Proteger o retirar `POST /api/fsm/validate-schema`**: sigue con `@PublicIp()` temporal.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Motor de interpolación funcional (PROT-10) — Épica 3 finalizada

`getInterpolatedValue` solo sabía resolver rutas de **dos segmentos**: la regex capturaba
`(nodo)\.(campo)` y hacía un acceso plano `namespaces[nodo]?.[campo]`. Basta para
`{{parsed_email.subject}}`, pero se queda corto en cuanto llegan los datos reales — un correo trae
cabeceras anidadas, el extractor devuelve arreglos de URLs y el nodo de IA responde con listas de
artículos. `{{ llm_response.articles[1].title }}` ni siquiera casaba con el patrón: se habría
quedado literal dentro del artículo publicado.

### El algoritmo: normalizar y reducir

Dos decisiones lo mantienen en veinte líneas sin `eval` ni parser de expresiones, ambos prohibidos
por `security-and-scope.md` §3:

1. **Normalizar los corchetes a puntos** (`urls[0]` → `urls.0`) antes de trocear. Así solo hay *una*
   gramática que recorrer, y como efecto secundario `{{ node.items[0].id }}` y `{{ node.items.0.id }}`
   resultan equivalentes gratis, sin código que los reconcilie.
2. **Navegar por reducción** sobre los segmentos, con tres cortes de seguridad en cada salto: clave
   bloqueada, nodo intermedio no navegable, propiedad no propia. Cualquiera de los tres devuelve
   `undefined` y el fail-safe final lo convierte en `MissingContextVariableException`.

`resolvePath` es una función **pura exportada**: no toca estado ni hace I/O, así que se prueba al
margen de la clase y podrá reutilizarla el nodo `MAPEADOR_PLANTILLA` cuando llegue.

La excepción cita siempre la ruta **literal** que escribió el autor
(`parsed_email.extracted_urls[99]`), no la normalizada. El mensaje debe mencionar lo que esa persona
puede buscar en su plantilla, no una forma interna que no reconocería.

### Las dos barreras de seguridad, y por qué ninguna sobra

Aquí está el hallazgo del ticket. El enunciado pedía una lista de bloqueo con `__proto__`,
`constructor` y `prototype`. Al añadir además `Object.hasOwn` en cada salto, comprobé por mutación
si cada guarda era portante — y la primera pasada dijo que **la lista de bloqueo era redundante**:
retirarla no rompía ninguna prueba, porque esas tres claves son heredadas y `Object.hasOwn` ya las
detenía.

Esa conclusión era incompleta. `JSON.parse('{"__proto__":{"polluted":"si"}}')` crea `__proto__` como
propiedad **propia** — no invoca el setter—, y comprobado en Node: sobrevive intacta a
`structuredClone` y al spread de `setNamespace`. Es decir, `Object.hasOwn` devuelve `true` y sin la
lista de bloqueo el interpolador leería datos controlados por el atacante. Y no es un vector
hipotético: es exactamente el camino de la respuesta del nodo de IA, que llega como texto y se
parsea.

Con la prueba 5.13 escrita para ese caso concreto, ambas guardas quedan verificadas por mutación:

| Barrera | Detiene | Prueba que falla si se retira |
|---|---|---|
| `BLOCKED_KEYS` | `__proto__` / `constructor` / `prototype` aunque sean **propias** | 5.13 (`__proto__` inyectado vía JSON) |
| `Object.hasOwn` | Todo lo **heredado** (`toString`, `valueOf`, `hasOwnProperty`) | 5.10 (propiedades heredadas no listadas) |

Sin `Object.hasOwn`, `{{ ns.dato.toString }}` devolvería una función; `JSON.stringify` de una función
es `undefined`, así que la plantilla acabaría con ese literal dentro del artículo.

Matiz sobre los índices fuera de rango: `{{ urls[99] }}` lo detiene el fail-safe final por sí solo,
no `Object.hasOwn`. La guarda no le añade nada ahí; su aportación real es la cadena heredada.

### Serialización estricta por tipo

Las ramas se escriben con `typeof` explícito en vez de un `String(value)` sobre `unknown`, que
volvería a disparar `no-base-to-string` como en PROT-08. El `bigint` acompaña a los números porque
`structuredClone` lo preserva y `JSON.stringify(1n)` lanza `TypeError`.

### Cierre del endpoint público

Se retiró el `@PublicIp()` que PROT-08 dejó marcado con `TODO(PROT-08)` en `FsmController`, aplicando
lo que el propio comentario prescribía: `@UseGuards(JwtAuthGuard, RolesGuard)` más `@ApiBearerAuth()`.
Sin `@Roles(...)`, porque `RolesGuard` deja pasar cuando no hay metadata de roles y configurar flujos
es competencia del rol EDITOR, no solo del ADMIN (`security-and-scope.md` §2). Al quitar `@PublicIp()`
la ruta vuelve además bajo el `IpWhitelistGuard` global: doble barrera, igual que `AuthController`.

### Verificación

17 pruebas nuevas en verde (161 en total en el backend). La red de seguridad real fue la
retrocompatibilidad: las 8 pruebas de interpolación de PROT-08 y las 2 del spec del motor pasaron
**sin tocar una sola línea**, lo que confirma que el patrón nuevo —que exige al menos un segmento
tras el namespace— sigue casando con `{{ns.campo}}` exactamente igual que el anterior.

`npx tsc --noEmit` sin errores, `npm run lint` con 0 errores (queda el warning preexistente de
`main.ts:59`), `nest build` correcto.

---

## Balance de cierre de la Épica 3

| Ticket | Entregado | Verificado |
|---|---|---|
| PROT-07 · Contratos y validación topológica | `PipelineSchemaDto`, `validatePipelineTopology`, `PipelineValidatorService` | 16 pruebas unitarias |
| PROT-08 · Contexto inmutable y persistencia | `StatePayloadContext`, `FsmExecution`, mutex `idx_flujo_activo`, reconciliación en arranque | 17 pruebas; **mutex y reconciliación sin ejercitar contra PostgreSQL** |
| PROT-09 · Motor y bucle de ejecución | `FsmEngineService`, `NodeStrategyFactory`, resiliencia de dos niveles, circuit breaker | 18 pruebas con repositorio mockeado |
| PROT-10 · Interpolación funcional | `resolvePath`, serialización por tipo, blindaje de prototipos | 17 pruebas, dos de ellas validadas por mutación |

**Lo que la épica NO ha demostrado todavía**, y conviene tener presente antes de darla por buena:

- **Nada se ha ejecutado contra PostgreSQL.** Las migraciones 005 y 006 siguen sin aplicar; toda la
  persistencia está verificada con dobles. El mutex, la reconciliación de arranque y los checkpoints
  no han tocado una base de datos real ni una vez.
- **El motor no tiene nada que ejecutar.** `NodeStrategyFactory` arranca vacía: cualquier flujo real
  pausaría en el primer nodo con `StrategyNotFoundException`. Las estrategias concretas son PROT-11+.
- **Nadie invoca `executeWorkflow`.** No hay endpoint, disparador ni consumidor de cola.

### Checklist de dependencias restantes

- [ ] **Aplicar `db/migrations/005-tipos-nodo-fsm.sql` y `006-fsm-execution-mutex.sql`**. La 006 es
      requisito de arranque: sin ella el backend no levanta.
- [ ] **Verificar el mutex y la reconciliación** contra la base de datos real.
- [x] **Proteger `POST /api/fsm/validate-schema`** — resuelto el 2026-08-31 en PROT-10.
- [ ] **Estrategias concretas** en `src/strategies/` y su registro en la factoría.
- [ ] **Quién invoca `executeWorkflow`**: endpoint, disparador IMAP/Cron o consumidor de cola.
- [ ] **Volcado a `.log` físico con Winston** y fila en `alertas_error` (`architecture-patterns.md` §4).
- [ ] **Notificación WebSocket** a la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: hoy el bucle corre en el proceso que lo invoca y el backoff duerme ese hilo.
- [ ] **Entidad `Flujo`** que mapee `flujos.configuracion_pipeline` a `PipelineSchema`.
- [ ] **`test/jest-e2e.json` sin `moduleNameMapper`**: los alias no resuelven en e2e (deuda previa).

---

## 2026-08-31 · Primera ejecución real del motor contra PostgreSQL (runner E2E) — rama `feat/fsm-e2e`

El balance de cierre de la Épica 3 dejaba una afirmación incómoda por escrito: **nada se había
ejecutado contra PostgreSQL**. 161 pruebas, todas con dobles; el repositorio mockeado; la factoría
vacía. El motor nunca había recorrido un pipeline de verdad ni escrito un checkpoint real, y el
cableado de Nest jamás se había arrancado. Esta entrada cierra esa brecha.

### El bloqueo que el enunciado no contemplaba

La FASE 2 pedía insertar la ejecución con «`id_flujo`: UUID aleatorio (`v4()`)». Eso habría fallado
en el primer intento: `ejecuciones_flujo.id_flujo` es **clave foránea a `flujos`**, y esa tabla
estaba vacía. Y `flujos.id_usuario_creador` es a su vez FK contra `usuarios`. La siembra necesita la
cadena entera: localizar un ADMIN activo → crear el flujo → crear la ejecución. Se reutiliza uno de
los tres ADMIN que ya existen en lugar de inventar usuarios de prueba, y `flujos` se inserta con SQL
directo porque todavía no tiene entidad TypeORM.

### Estrategias dummy con tipos reales, no inventados

El enunciado proponía `'DUMMY_INPUT' as any`. Se descartó: las tres dummy se registran bajo
`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA` y `DESTINO_HTTP`, que son exactamente los roles que representan
y los huecos que ocuparán las estrategias definitivas. Cero casts, y una ventaja que no es cosmética:
**el esquema dummy pasa el `PipelineValidatorService`**, así que el e2e asevera de paso que sigue
siendo un pipeline legítimo según el contrato de PROT-07. Con un tipo inventado eso era imposible.

### El andamiaje no puede cablearse en un módulo

Las dummy y el runner viven en `src/` (donde los pedía el enunciado) pero se excluyen de
`tsconfig.build.json` con `**/dummies/**` y `**/scripts/**`, para que no viajen a `dist/`. Eso tiene
una consecuencia que condiciona el diseño: **si `FsmModule` los declarara en `providers`,
`nest build` fallaría**, porque el módulo referenciaría archivos que la compilación deja fuera. Por
eso no se cablean en ningún módulo; el runner y el spec los instancian con `new` y los pasan a
`NodeStrategyFactory.registerStrategy()`, que es justo el punto de extensión que PROT-09 preparó.

De ahí también que `DummyLogDispatcherStrategy` cree su `Logger` con `new` en lugar de inyectarlo:
vive fuera del contenedor, no hay inyección que resolver.

### Reparar la suite e2e costó tres pasadas

`test/jest-e2e.json` llevaba roto desde que se introdujeron los alias, y arreglarlo tuvo más aristas
de las esperadas:

1. Faltaba el `moduleNameMapper`. Al añadirlo con `<rootDir>/src/...` **seguía fallando**: `rootDir`
   es `"."` **relativo al propio archivo de configuración**, es decir `backend/test/`, no `backend/`.
   Las rutas correctas son `<rootDir>/../src/...`.
2. Después falló al resolver `otplib`, que publica fuentes TS/ESM. El jest principal ya lo
   contemplaba con `transformIgnorePatterns` y `allowJs` en el transform; hubo que replicar ambos.

Con eso, `app.e2e-spec.ts` —que estaba roto desde hacía tickets— **pasa por primera vez**.

### Resultado de la primera ejecución real

```
[NodeStrategyFactory] Estrategia registrada para el nodo "TRIGGER_IMAP".
[NodeStrategyFactory] Estrategia registrada para el nodo "MAPEADOR_PLANTILLA".
[NodeStrategyFactory] Estrategia registrada para el nodo "DESTINO_HTTP".
[RunDummyE2E] El esquema dummy supera PipelineValidatorService.
[DummyLogDispatcherStrategy] [PROTO-DO MOTOR FSM] -> Salida generada:
    Noticia: Innovacion en Madrid | remitente: prensa@unuware.com

estado = EXITOSO | paso_actual = null
namespaces = input_data, rendered_message, dispatch_result
```

La plantilla del nodo mapeador combina a propósito una ruta compuesta con índice de arreglo
(`{{ input_data.articulos[0].titulo }}`) y otra simple, de modo que la corrida certifica que el
resolutor funcional de PROT-10 opera sobre datos que ya pasaron por `structuredClone`, por el
checkpoint y por una columna `jsonb` de PostgreSQL. Que la interpolación resuelva ahí es la prueba
que ninguna suite con dobles podía dar.

### Verificación

- `npm run test:fsm:manual` — el runner completa el pipeline e imprime el checkpoint releído de la base.
- `npm run test:e2e` — **7 pruebas en verde**: 1 de `app.e2e-spec.ts` (reparada) + 6 de
  `fsm-engine.e2e-spec.ts`.
- `npm test` — **161 unitarias**, que siguen sin necesitar base de datos: la suite unitaria no quedó
  acoplada a Docker.
- `npx tsc --noEmit` sin errores, `npm run lint` con 0 errores, `nest build` correcto y **`dist/`
  verificado sin rastro** de `dummies/` ni `scripts/`.
- Comprobado en la base: dos ejecuciones persistidas (runner + e2e), ambas `EXITOSO`, `paso_actual`
  nulo y los tres namespaces en `contexto_acumulado`.

La prueba que más valor aporta es la que lee con SQL directo, al margen del mapeo de TypeORM:
comprueba lo que quedó **escrito**, no lo que el motor creía haber escrito.

### Checklist de dependencias restantes

- [x] **Aplicar las migraciones 005 y 006** — resuelto: verificadas como aplicadas el 2026-08-31.
- [x] **Verificar el motor contra PostgreSQL real** — resuelto el 2026-08-31 con el runner y el e2e.
- [x] **`test/jest-e2e.json` sin `moduleNameMapper`** — resuelto el 2026-08-31; `app.e2e-spec.ts`
      vuelve a ejecutarse.
- [ ] **Ejercitar el mutex `idx_flujo_activo` contra la base**: cada corrida crea su propio flujo, así
      que dos ejecuciones nunca colisionan. Falta una prueba que fuerce dos `EN_PROCESO` del mismo
      `id_flujo` y espere la violación de unicidad.
- [ ] **Ejercitar la reanudación y la pausa contra la base**: el e2e solo cubre el camino feliz. Falta
      un flujo que falle sin `onErrorStep`, quede `PAUSADO` y se reanude desde el cursor persistido.
- [ ] **Estrategias reales** en `src/strategies/`: las dummy son andamiaje, no implementan IMAP,
      plantillas ni publicación HTTP.
- [ ] **Quién invoca `executeWorkflow`** en producción: endpoint, disparador o consumidor de cola.
- [ ] **Volcado a `.log` con Winston** y fila en `alertas_error` (`architecture-patterns.md` §4).
- [ ] **Notificación WebSocket** a la sala `flow_${flowId}` (§4 paso 4 y §5).
- [ ] **Cola BullMQ**: el bucle sigue corriendo en el proceso que lo invoca.
- [ ] **Entidad `Flujo`**: la siembra usa SQL directo porque `flujos` aún no está mapeada.

---

## 2026-09-02 · Gestor de plantillas HTML y nodo `MAPEADOR_PLANTILLA` (PROT-11.1 / PROT-11.2) — rama `feat/html-template-mapper`

PROT-10 dejó la interpolación resuelta pero la plantilla seguía viviendo dentro del
`pipeline_schema`, en `params.template`. Cambiar un `<h1>` obligaba a editar el JSON de cada flujo
que lo usara, y dos flujos no podían compartir el mismo maquetado. Esta entrega mueve la plantilla a
`plantillas_html` y deja al nodo declarando solo `params.templateId`.

Lo que sigue son las cuatro decisiones donde el código **se separa del enunciado**, y el porqué.

### La estrategia no escribe en el contexto

El enunciado pedía que `execute()` terminase con
`context.setNamespace(outputNamespace, { compiled_markup, mapped_at })`. No se hizo.

`FsmEngineService` ya escribe `result.data` en `node.outputNamespace` en cuanto un nodo devuelve
`success: true` (`fsm-engine.service.ts`, rama `if (result.success)`). Añadir la escritura desde la
estrategia no la sustituye: la **duplica**. El payload acabaría en dos namespaces distintos —el
`params.outputNamespace` que eligiera la estrategia y el `node.outputNamespace` del esquema— y una
plantilla aguas abajo podría leer del que no toca sin que nada fallara. Además el TSDoc de
`INodeStrategy` es explícito: el contexto llega para **leerse**, y quien escribe es el motor.

La estrategia devuelve `data` y punto. El test `3.1` lo blinda comparando `getAllContext()` antes y
después: si alguien vuelve a meter un `setNamespace` aquí, la suite lo caza.

### `strict: true`, contra lo que pedía el enunciado

Handlebars con `strict: false` (lo especificado) interpola una variable ausente como cadena vacía y
sigue adelante. Eso es exactamente lo que PROT-10 decidió **no** hacer cuando
`getInterpolatedValue` pasó a lanzar `MissingContextVariableException` en vez de callar: un titular
en blanco se publicaría en Drupal sin que nadie se enterase, y el fallo aparecería lejos de su causa.

Sería incoherente que el motor fuese estricto y el nodo que consume plantillas no lo fuese. Se compila
con `strict: true` y el fallo se traduce a `NodeResult` con nivel `GRAVE`.

### El pre-chequeo de variables existe para no informar de una en una

Con `strict: true` bastaría para detener el flujo, pero Handlebars lanza en la **primera** variable
ausente. Un operador con tres variables mal cableadas tendría que arreglar, reintentar, descubrir la
siguiente, y así tres veces.

Antes de compilar se recorre `requiredVariables` con `resolvePath` —la función pura que PROT-10 ya
exportaba del contexto FSM, así que la comprobación usa exactamente la misma gramática de navegación
que la interpolación real— y se acumulan **todas** las que faltan en `missingFields`. El `try/catch`
alrededor de la compilación se queda como red: cubre el modo `rawTemplate`, donde no hay
`requiredVariables` precalculadas.

### La lista blanca valida la raíz, no dos segmentos

El regex del enunciado (`/\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\s*\}\}/g`) solo ve rutas de dos
segmentos. Pero Handlebars resuelve `{{llm_response.articles.[0].title}}` igual de bien, así que esa
ruta habría pasado sin que su namespace se comprobara nunca — el Poka-Yoke tendría un agujero del
tamaño de cualquier ruta anidada.

El patrón implementado captura la raíz y el resto por separado, a cualquier profundidad, y valida la
raíz. Las rutas se guardan normalizadas (`.[0]` → `.0`) para que `resolvePath` las navegue tal cual.

#### Y el residuo: lo que el patrón *no* reconoce

Validar lo que casa no basta. `{{titulo}}` (namespace suelto), `{{mi-var.campo}}` (guion) o un
marcador mal cerrado no casan con el patrón, así que sin más se colarían: pasarían la validación, no
figurarían en `requiredVariables` y reventarían en ejecución con Handlebars estricto.

La extracción usa el **residuo** del `replace` —el HTML con las variables válidas ya consumidas— y
rechaza cualquier `{{...}}` que sobreviva. Analizar y limpiar en la misma pasada evita mantener dos
gramáticas que podrían divergir.

### Sintaxis prohibida: el añadido que no estaba en el enunciado

`security-and-scope.md` §3 limita la transformación de datos a "sustitución determinista de
variables". Handlebars trae bastante más, y todo se rechaza **al guardar**:

| Token | Por qué se rechaza |
|---|---|
| `{{{` y `{{&` | Desactivan el escapado de HTML. Un valor del contexto (la respuesta del nodo de IA, por ejemplo) podría inyectar markup en el artículo publicado |
| `{{#` y `{{/` | Bloques y helpers: lógica dentro de la plantilla |
| `{{>` | Parciales: cargarían una plantilla externa, fuera del control del gestor |

Prohibir el triple-stash es lo que permite confiar en el escapado por defecto de `{{ }}`. El test
`1.4` de la estrategia lo comprueba de frente: un `<script>` en el contexto sale como `&lt;script&gt;`.

### Detalles de implementación

- **La tabla ya existía** en `init.sql` desde el esquema original, con `nombre VARCHAR(100)`, sin
  `descripcion`, sin `activo` y con `contenido_html`/`variables_esperadas` anulables. La migración
  `008` la alinea; `init.sql` se actualiza en paralelo para que un clonado nuevo nazca igual, como se
  hizo con `allowed_ips`.
- **`id_usuario_creador` se conserva** `NOT NULL` en vez de eliminarla. No entra por el DTO: el
  controlador la toma de `@CurrentUser()`, de modo que el cliente no puede falsificar la autoría. Es
  lo que sostiene la trazabilidad que justifica el borrado lógico.
- **`variables_esperadas` pasa a `NOT NULL DEFAULT '[]'`**: el servicio la recalcula en cada
  escritura, así que un `NULL` significaría "nunca se validó", estado que el gestor ya no permite
  alcanzar.
- **El cambio de tipo de `fecha_creacion`** (`TIMESTAMP` → `TIMESTAMPTZ`) va en su propia sentencia,
  separado del `SET DEFAULT`: combinarlos en un mismo `ALTER TABLE` obliga a PostgreSQL a recastear
  el default a medio camino del cambio de tipo.
- **El registro de la estrategia** vive en `NodesModule.onModuleInit()`, no dentro de
  `NodeStrategyFactory`. El enunciado pedía "añadir el mapeo al registro interno de la factoría",
  pero la factoría es agnóstica a propósito: registro explícito, sin descubrimiento automático, para
  que un archivo suelto no se active sin querer. `FsmModule` exporta la instancia justo para esto.
- **`DummyTemplateMapperStrategy` sigue ganando en el e2e.** `fsm-engine.e2e-spec.ts` importa
  `AppModule` (que ya registra la estrategia real) y después llama a `registerDummyStrategies`, que
  la sustituye dejando un `warn`. Es lo correcto: el runner manual no debe depender de que haya
  plantillas en la base.
- **`PUT` y no `PATCH`**, siguiendo el enunciado, aunque el resto del repo use `PATCH`.
- **El perímetro de red no necesitó nada.** El enunciado pedía `RedLocalMiddleware` sobre
  `/templates`; ese middleware solo se monta sobre las rutas de Swagger porque escapan al router de
  Nest. `/templates` ya lo cubre `IpWhitelistGuard`, registrado como `APP_GUARD` global.

### Verificación

```
npx tsc --noEmit    13 errores, todos preexistentes en allowed-ips.service.spec.ts
npm run lint        1 warning, preexistente en main.ts
npm run build       OK
npm test            18 suites, 217 pruebas (32 nuevas)
```

Las 32 pruebas nuevas se reparten en: 19 de `templates.service.spec.ts` (lista blanca, rutas
profundas, sintaxis prohibida, residuo, unicidad, borrado lógico), 12 de
`template-mapper.strategy.spec.ts` (compilación, escapado, los cinco fallos `GRAVE`, inmutabilidad
del contexto) y 1 de `nodes.module.spec.ts`, que comprueba el registro en la factoría sin arrancar
Nest ni PostgreSQL — sin ella, un cableado roto no se detectaría hasta que un flujo real reventase
con `StrategyNotFoundException`.

Los dos archivos SQL se validaron con `pglast` (el parser real de PostgreSQL, vía `libpg_query`): 11
sentencias en la migración, 29 en `init.sql`, todas correctas. La semántica sobre datos reales queda
pendiente de aplicar la migración.

### Checklist de dependencias restantes

- [ ] **Aplicar la migración 008** (`db/migrations/008-plantillas-html.sql`): la ejecuta el usuario.
      Hasta entonces, el CRUD de `/templates` fallará contra la base aunque la suite unitaria pase.
- [ ] **Entidad `Nodo` y `Flujo`**: `nodos.id_plantilla` sigue sin mapear, así que nada valida todavía
      que el `templateId` de un `params` corresponda a la plantilla enlazada en el nodo.
- [ ] **Frontend de Vista 4**: el `<q-select>` cerrado debe alimentarse de `requiredVariables`, que ya
      viaja en la respuesta de `GET /templates`.
- [ ] **Estrategias reales restantes**: IMAP, extracción web, IA y publicación HTTP siguen siendo
      dummies. `MAPEADOR_PLANTILLA` es la primera real.
- [ ] **Volcado a `.log` con Winston** y fila en `alertas_error`: los fallos `GRAVE` de este nodo aún
      no se persisten (`architecture-patterns.md` §4).

---

## 2026-09-02 · Catálogo de plantillas y tríada modular de nodos (PROT-11 · Quasar) — rama `feat/html-template-mapper`

El backend de PROT-11 quedó cerrado en el commit anterior, pero sin nada en el frontend: el catálogo
no se podía administrar y el nodo `MAPEADOR_PLANTILLA` no tenía componente de configuración. Esta
entrega cierra el ciclo, y antes fija una regla de arquitectura que no existía.

### La regla se escribió sobre un hueco, no sobre un problema

El encargo pedía "eliminar la nomenclatura secuencial acoplada (`StepN`)". Un `grep` sobre
`frontend/src` no encontró **ningún** archivo `Step`, ni un `q-stepper`, ni un wizard: las únicas
menciones a "Wizard" estaban en el propio `.md` de reglas. No había nada que renombrar.

Eso cambia la naturaleza del trabajo pero no su valor: la regla es **preventiva**. El razonamiento
que se dejó escrito es el que importa — el orden de un nodo es un dato del `pipeline_schema`, no una
propiedad del componente. Con `Step1.vue`…`Step5.vue`, reordenar un flujo obligaría a renombrar
archivos, y un mismo nodo no podría reutilizarse en dos flujos que lo colocan en posiciones
distintas. El nombre describe el tipo funcional: `TemplateMapperConfig.vue`.

### `tipo_nodo` no existe en el JSON

El encargo pedía resolver los componentes "según la propiedad `tipo_nodo` del schema JSON". No hay
tal propiedad: `PipelineNodeConfigDto` usa **`nodeType`**, y `tipo_nodo` es el nombre de la columna
SQL de la tabla `nodos`. Escribir la regla con el nombre de la columna habría enviado a quien
implemente el siguiente nodo a buscar un campo que no está, además de contradecir
`code-conventions.md` §1 (identificadores en inglés). La regla dice `nodeType`.

### El registro, y por qué no un `v-if`

```typescript
export const nodeConfigRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.MAPEADOR_PLANTILLA]: defineAsyncComponent(
    () => import('@components/nodes/TemplateMapperConfig.vue'),
  ),
};
```

Encadenar `v-if="node.nodeType === 'MAPEADOR_PLANTILLA'"` en el anfitrión funcionaría hoy, con un
solo nodo. Con siete, cada tipo nuevo obliga a editar el anfitrión — que es exactamente el
acoplamiento que la tríada quiere evitar, solo que movido de los nombres de archivo a una plantilla.
El registro deja el anfitrión cerrado a modificación.

`Partial` es deliberado: los seis tipos sin implementar simplemente no están, y el anfitrión debe
contemplar el `undefined`. Cuando existan los siete, retirar el `Partial` hará que el compilador
exija cobertura total, sin que nadie tenga que acordarse.

El build confirma que la carga diferida hace su trabajo: `TemplateMapperConfig-ChsWNX52.js` sale como
chunk propio, así que un flujo que use dos nodos no descarga los siete.

### La vista previa vive en el backend, y esa es la decisión de fondo

El encargo pedía que el servicio del nodo "probara compilación de payloads simulados", pero el
backend no tenía endpoint de previsualización. Había tres salidas y dos eran malas:

- Compilar en el navegador añadiendo `handlebars` al frontend: dos motores, y cualquier divergencia
  futura (modo estricto, sintaxis prohibida) daría una vista previa que **miente** sobre lo que se va
  a publicar. Es justo el fallo que PROT-11.1 se propuso evitar validando al guardar.
- Pintar el HTML crudo sin interpolar: no verifica que la plantilla compile de verdad.
- Añadir `POST /templates/:id/preview`. Más trabajo, pero una sola fuente de verdad.

Se eligió la tercera, y para sostenerla se extrajo `TemplateRendererService`: la lógica de Handlebars
sale de `TemplateMapperStrategy` y pasa a un servicio con **dos consumidores** —la estrategia en
tiempo de ejecución y el endpoint del gestor—, cada uno traduciendo el mismo `RenderOutcome` a su
propio contrato (`NodeResult` o respuesta HTTP). El renderer no conoce a ninguno de los dos.

#### Marcadores autogenerados

El endpoint construye el contexto a partir de `requiredVariables`, poniendo `«parsed_email.clean_title»`
donde irá el titular, y fusiona encima el `samplePayload` que envíe el cliente. Así la vista previa
**nunca falla por falta de datos**: el editor abre el diálogo y ve la maqueta al instante, y donde
aporte valores reales se ven esos. Las comillas angulares se eligieron porque no aparecen en texto
corriente y sobreviven al escapado de Handlebars sin convertirse en entidades.

### El refactor del constructor y las pruebas que casi se vuelven mentira

Extraer el renderer cambió la firma de `TemplateMapperStrategy` de uno a dos parámetros, lo que rompe
la instanciación de las 12 pruebas existentes. Lo evidente era mockear el renderer en todas.

No se hizo, porque cuatro de esas pruebas —`1.1` interpolación, `1.3` ruta con índice, `1.4` escapado
de `<script>`, `2.5` variable ausente— dejarían de ejercitar Handlebars y pasarían a comprobar que un
doble devuelve lo que se le dijo. Habrían seguido en verde sin verificar nada, y precisamente la
cobertura perdida es la que impide que la vista previa mienta.

La suite quedó partida en dos:

| Bloque | Renderer | Qué prueba |
|---|---|---|
| 1–3 (las 12 originales) | **Real** | Compilación, escapado, rutas anidadas, fallos `GRAVE`, inmutabilidad |
| 4 (nuevo, 6 pruebas) | **Mockeado** | Que se invoca `renderStrict(html, requiredVariables, namespaces)` y que las 3 variantes de `RenderOutcome` se traducen a su `NodeResult` |

El renderer real es puro —sin repositorio, red ni estado—, así que usarlo no introduce I/O ni acopla
la prueba a nada externo. `buildStrategy` lo instancia por defecto y admite el doble por parámetro.

### `iframe sandbox` y no `v-html`

El contenido de una plantilla es markup arbitrario escrito por un editor. Un `v-html` ejecutaría
cualquier `<script>` que contenga, en el mismo origen que la sesión y con el JWT en `localStorage` al
alcance. El `<iframe sandbox="">` sin ningún token `allow-*` desactiva scripts, formularios y
navegación por completo.

Es una barrera **independiente** del escapado de Handlebars, y ninguna sobra: el escapado protege de
los valores del contexto (la respuesta del nodo de IA), el sandbox protege del HTML de la propia
plantilla. Hacen falta las dos porque el vector es distinto.

### Detalles de implementación

- **Convención de nombres de store.** El encargo pedía `useTemplatesStore.ts` y
  `nodes/useTemplateMapperStore.ts`. Se mantuvo `<dominio>.store.ts` (`templates.store.ts`,
  `nodes/template-mapper.store.ts`), que es lo que usan los cinco stores existentes; adoptar el otro
  estilo habría dejado el proyecto con dos convenciones de nombre de archivo conviviendo.
- **`nativeEl`, no el ref del componente.** El primer intento de insertar el chip de namespace en el
  cursor leía `selectionStart` del ref de la `QInput`, que apunta al **componente** y no al
  `<textarea>`. Habría pasado el typecheck y fallado en silencio en tiempo de ejecución; se corrigió
  a `htmlInput.value?.nativeEl`. La recolocación del caret va dentro de `nextTick` porque antes del
  repintado el textarea aún contiene el texto viejo.
- **Las llaves no pueden vivir en la plantilla.** `<span>{{ '{{#if}}' }}</span>` rompe el compilador
  de Vue (`vue/no-parsing-error`): no distingue unas llaves literales de una interpolación anidada.
  Los ejemplos con llaves se declararon como constantes en el `<script setup>`.
- **`/templates` no lleva `requiresAdmin`.** A diferencia de `/users` y `/ip-whitelist`, el
  `TemplatesController` admite `@Roles(ADMIN, EDITOR)`: configurar plantillas es operación de flujos,
  no gestión de cuentas. La ruta espeja al backend.
- **Se reutilizó `SafeDeleteModal`** tal cual: ya implementaba la cuenta regresiva de 5 segundos, no
  se reimplementó nada.
- **`PUT` y no `PATCH`** en `updateTemplate`, porque es lo que expone el controlador — a diferencia
  de `/users` y `/allowed-ips`.
- **Banco de pruebas en lugar de wizard.** Como Vista 3+4 no existe, `NodeConfigSandboxPage.vue`
  reproduce lo único que el asistente hará con un configurador: resolverlo por `nodeType` desde el
  registro y leer `isConfigValid`. Sin él, `TemplateMapperConfig.vue` compilaría y tiparía pero no se
  podría ver funcionando hasta PROT-12.

### Verificación

```
Backend
  npm test          19 suites, 239 pruebas (antes 217; +22)
  npx tsc --noEmit  13 errores, todos preexistentes en allowed-ips.service.spec.ts
  npm run lint      1 warning, preexistente en main.ts
  npm run build     OK

Frontend
  npm run typecheck  vue-tsc --noEmit, limpio
  npm run lint       limpio
  npm run build      OK — TemplateMapperConfig sale en su propio chunk
```

Las 22 pruebas nuevas del backend: 6 de delegación en la estrategia, 7 de previsualización en
`templates.service.spec.ts` (marcadores autogenerados, override por `samplePayload`, ruta profunda,
escapado, plantilla desactivada, `404`, `400` por HTML que no compila) y 9 del
`template-renderer.service.spec.ts` aislado.

### Checklist de dependencias restantes

- [ ] **Asistente de flujos (Vista 3+4, PROT-12)**: el banco de pruebas es andamiaje. Falta el
      `<q-stepper>` real, `useFlujoDraftStore` como agregador y la topología del pipeline.
- [ ] **Los otros seis configuradores de nodo**: solo `MAPEADOR_PLANTILLA` está en el registro.
      Al completarlos, retirar el `Partial` de `nodeConfigRegistry`.
- [ ] **Sin pruebas en el frontend**: no hay runner instalado (ni vitest ni jest). `isConfigValid` y
      la inserción de chips en el cursor son lógica que merece prueba unitaria.
- [ ] **`samplePayload` real en la vista previa**: hoy siempre se envía vacío y se ven marcadores.
      Podría alimentarse del último `contexto_acumulado` de una ejecución del flujo.
- [ ] **Ocultar entradas del drawer por rol**: `/users` y `/ip-whitelist` se muestran a un EDITOR
      aunque la guarda de ruta los bloquee. No es nuevo de esta entrega, pero se hace más visible al
      añadir rutas con roles distintos.

---

## 2026-09-02 · Editor CodeMirror 6, split view y borrador en Pinia — rama `feat/html-template-mapper`

El diálogo de plantillas entregado esta mañana era un modal de 620px con un `<q-textarea>` plano. Se
podía escribir HTML, pero sin resaltado, sin números de línea y sin ninguna señal de qué era un
marcador y qué era texto: el autor descubría el error cuando el backend devolvía un `400`. Este
refactor separa las tres responsabilidades que el componente concentraba y hace el error **visible
mientras se escribe**.

### CodeMirror manda sobre el cursor, no el store

El encargo especificaba dos caminos de inserción a la vez: `store.insertMarker(ns)`, que empalma
strings sobre un `cursorPosition` guardado en Pinia, y `codeEditorRef.insertTextAtCursor(...)`, que
despacha una transacción sobre el `EditorView`. Ejecutar ambos inserta `{{ns.}}` **dos veces**.

Y no es solo eso: si el store fuese el dueño, cada inserción reemplazaría el documento entero por una
cadena nueva, CodeMirror lo recibiría por prop y el cursor se iría al principio. El punto de control
del propio encargo pedía lo contrario — "inserción atómica sin pérdida de foco".

Gobierna CodeMirror. El chip despacha la transacción; el `update:modelValue` sincroniza el store
después. `insertMarker` sobrevive como red por si el editor aún no ha resuelto su carga diferida, y
`cursorPosition` queda como espejo que alimenta ese fallback. El TSDoc de ambos lo dice, para que
nadie los tome por la ruta principal.

Que la inserción sea **una sola transacción** —texto y selección en el mismo `dispatch`— es lo que
hace que `Ctrl+Z` la deshaga entera en vez de dejar el caret descolocado.

### La guarda contra el bucle de eco

El `v-model` entre un componente Vue y un editor imperativo tiene una trampa clásica:

```
tecla → docChanged → emit → store → prop → watch → dispatch → docChanged → …
```

Sin cortar ese ciclo, cada pulsación reemplaza el documento completo y el cursor salta. El `watch`
compara antes de despachar:

```ts
if (!view || view.state.doc.toString() === value) return;   // el cambio vino de aqui
```

Tres caracteres de comparación que son la diferencia entre un editor usable y uno que se pelea con
quien escribe.

### Un solo `HighlightStyle` para los dos modos

`defaultHighlightStyle` de CodeMirror está pensado para fondo claro y sería ilegible en oscuro, que
es el modo por defecto del proyecto. La salida habitual es mantener dos temas y conmutarlos con un
`Compartment` observando `$q.dark`.

No hizo falta: el tema y el resaltado se construyen sobre custom properties `--pd-*`, que ya conmutan
solas con `body--dark`. Un único `EditorView.theme()` y un único `HighlightStyle` sirven para ambos
modos, sin reconfigurar extensiones ni observar el store de tema.

Los dos colores que el encargo pedía inline (`rgba(91,140,232,.15)` y `.25`) se añadieron antes como
tokens `--pd-accent-soft` y `--pd-accent-selection`: `app.scss` declara que la lista `--pd-*` es
cerrada y que todo color nuevo entra primero como token.

### `:deep()` no es opcional aquí

CodeMirror construye su DOM de forma imperativa, sin el atributo de scope que Vue añade a lo que él
renderiza. Un `.cm-pd-template-marker` en `<style scoped>` normal **no alcanzaría** a esos nodos. El
contenedor sí es un elemento de Vue, así que `:deep()` desde el componente hijo funciona.

### `min-height: 0`, el detalle que decide si el modal funciona

El split view es una cadena de contenedores flex: card → form → row → columna → editor. Un ítem flex
tiene `min-height: auto` por defecto y **se niega a encogerse por debajo de su contenido**, así que
sin `min-height: 0` en cada eslabón el editor empuja el modal más allá del `85vh` en vez de hacer
scroll interno. Es exactamente el desbordamiento que el punto 2 de la verificación manual buscaba.

### `vue-codemirror` no entró

El encargo lo pedía, pero el wrapper obliga igualmente a sacar el `EditorView` del payload de su
evento `@ready` para poder despachar transacciones — y con `no-unsafe-assignment` como *error* en el
lint, ese payload hay que tiparlo a mano. A cambio de dos dependencias (`vue-codemirror` más el
metapaquete `codemirror`, que declara como peer y faltaba en la lista), ahorraba unas 35 líneas de
`onMounted`/`onBeforeUnmount`. Se montó el `EditorView` directamente.

La lista de paquetes sí se corrigió por lo contrario: faltaban tres. `@codemirror/language` (sin él
el HTML se parsea pero **no se colorea**), `@codemirror/commands` (sin él no hay deshacer/rehacer, lo
que dejaría el editor por debajo de un `<textarea>`) y `@lezer/highlight` para los `tags`.

### Detalles de implementación

- **El `EditorView` no vive en un `ref`.** Envolver una instancia imperativa con estado interno en un
  proxy reactivo de Vue es una fuente conocida de rarezas, y aquí no se necesita reactividad sobre
  ella: es una variable del `setup`.
- **Carga diferida.** El diálogo monta `TemplateCodeEditor` con `defineAsyncComponent`. El build lo
  confirma: `TemplateCodeEditor-DPHlm0aB.js` pesa 451 KB y **no aparece** en el chunk principal
  (167 KB), que es lo que importa porque el diálogo lo importan dos componentes distintos.
- **El regex se alineó con el del backend**, índice `.[0]` incluido. Con el del encargo,
  `{{llm_response.articles.[0].title}}` no habría salido en los chips aunque el backend sí la
  registra en `requiredVariables`: los chips habrían mentido.
- **`detectedVariables` detecta la forma, no la validez.** `{{contacto.telefono}}` se resalta y se
  lista, y aun así el backend lo rechaza. Duplicar aquí la lista blanca crearía una segunda autoridad
  sobre qué namespaces existen; hay una sola, y está en el backend.
- **`exactOptionalPropertyTypes` en `initDraft`**: la entidad trae `description: string | null` y el
  borrador la quiere `string | undefined`. No se puede asignar `undefined`: hay que **omitir la
  clave**, con el mismo spread condicional que ya usaba `onSubmit`. Hay un test que lo fija
  (`'description' in draft === false`), porque es el tipo de cosa que un refactor rompe en silencio.
- **`.pd-btn-secondary` unificó cinco duplicados.** No existía; cinco diálogos repetían una
  `.pd-btn-cancel` local idéntica. Se creó como utilidad global, se añadió a la tabla §2 de las
  reglas y se migraron los cinco.
- **Un solo borrador por aplicación.** `activeDraft` es un singleton: dos `TemplateEditorDialog`
  montados a la vez compartirían buffer. No es un problema real porque los `<q-dialog>` son modales y
  solo uno está abierto, e `initDraft` se llama al abrir — pero queda escrito en el TSDoc para que
  nadie construya encima la suposición contraria.

### Primer runner de pruebas del frontend

Hasta ahora no había ninguno. El refactor movía a Pinia lógica pura que antes no existía —el regex de
detección y la aritmética del offset del caret— y eso pedía red. Vitest 4 (declara `vite ^8.0.0`;
instalado 8.2.2), con `vitest.config.ts` propio porque Vitest no lee los alias de `quasar.config.ts`.

Los helpers se importan explícitamente en vez de activar `globals: true`: eso exigiría añadir
`vitest/globals` a los `types` de `.quasar/tsconfig.json`, que es un archivo **generado** por
`quasar prepare` y se perdería en el siguiente `postinstall`.

`src/stores/templates.store.spec.ts`, 19 casos sin DOM ni red (`vi.mock` sobre el servicio evita
cargar `@boot/axios`): `initDraft` con `description: null`, los cuatro casos de `isDraftValid`, siete
de `detectedVariables` (dedupe, rutas profundas, índice, namespace suelto, recálculo tras cambio) y
cuatro de `insertMarker` (posición, offset del caret, cursor desfasado y acotado).

### Verificación

```
npm run typecheck   vue-tsc --noEmit, limpio
npm run lint:check  limpio (exit 0)
npm test            1 archivo, 19 pruebas
npm run build       OK — CodeMirror aislado en su propio chunk, ausente del index
```

### Checklist de dependencias restantes

- [x] **Sin pruebas en el frontend** — resuelto parcialmente: Vitest instalado y `templates.store.ts`
      cubierto. Faltan las de componente (`@vue/test-utils` + `happy-dom` cuando haga falta).
- [ ] **`TemplateCodeEditor` sin pruebas**: la guarda del bucle de eco y el offset de
      `insertTextAtCursor` solo se verifican a mano. Necesitan entorno DOM.
- [ ] **Autocompletado de campos tras el punto**: al insertar `{{parsed_email.}}` el editor podría
      ofrecer los campos conocidos del namespace, pero el backend no expone hoy ese catálogo.
- [ ] **Resaltar en rojo los namespaces fuera de la lista blanca**: el decorador valida la forma. Con
      `TEMPLATE_NAMESPACES` ya en el frontend, distinguir válido de inválido dentro del editor es
      barato y adelantaría el `400` al momento de teclear.
- [ ] **Asistente de flujos (PROT-12)** y los otros seis configuradores de nodo, sin cambios.

---

## 2026-09-03 · Blindaje XSS, filtro de tablas y contrato de namespaces — rama `feat/html-template-mapper`

Tres carencias con el mismo patrón de fondo: **el sistema no avisa hasta que ya es tarde**. Las
tablas no se podían filtrar, el markup de una plantilla llegaba crudo a Drupal, y el nodo mapeador se
declaraba válido con un contrato que se sabía roto.

### Las dos barreras XSS cubren cosas distintas

Ya existían dos protecciones y ninguna cubría el hueco real:

- El **escapado `{{ }}` de Handlebars** protege de los *valores* del contexto — la respuesta del nodo
  de IA, por ejemplo. No toca el HTML que el editor escribió en la plantilla.
- El **`<iframe sandbox>`** de la vista previa protege al *operador de Proto-Do*. Al lector del
  artículo publicado en Drupal no lo protege nadie: ahí no hay iframe.

El hueco era el cuerpo de la plantilla. Un `<script>`, un `onerror=` o un `href="javascript:"`
escritos ahí se compilaban tal cual. `sanitize-html` llevaba instalado desde el principio, sin usar.

### Lo que el enunciado daba por hecho y no era cierto

`disallowedTagsMode: 'discard'` supuestamente elimina "la etiqueta y su contenido" para `script`,
`style` e `iframe`. Ejecutando la configuración propuesta antes de escribirla:

```
script -> "<p>ok</p>"                    purgado con su contenido
iframe -> "contenido interno<p>ok</p>"   la etiqueta se fue, el TEXTO se quedó
```

`discard` solo borra el contenido de las etiquetas listadas en `nonTextTags`, y `iframe` no está en
esa lista. Sin corregirlo, el texto interno de un `<iframe>` acabaría suelto en el artículo.

#### Y el detalle que casi abre un agujero

Declarar `nonTextTags` **sustituye** la lista por defecto, no la amplía. Escribir `['iframe']` a
secas habría eliminado `script`, `style`, `textarea`, `option` y `xmp` de la protección. El propio
código de la librería avisa sobre el último:

> `xmp` is included because htmlparser2 treats it as a raw-text element, so markup inside is parsed
> as text on input but would otherwise be re-emitted unescaped, allowing XSS bypass.

La configuración declara los seis. El comentario en el código explica por qué no se puede acortar.

### Detectar al guardar: dos pasadas del mismo parser

Sanear en silencio deja al autor sin enterarse. Todo el gestor hace lo contrario —los namespaces se
rechazan al guardar con un 400 que cita la variable—, así que el saneado debía comportarse igual.

El problema: `sanitize-html` no informa de lo que elimina, y comparar su salida contra el HTML crudo
daría falsos positivos constantes, porque el parser normaliza aunque no filtre (`<br>` → `<br />`,
comillas, orden de atributos). La comparación válida es entre **dos pasadas del mismo parser**, una
con lista blanca y otra sin ella: lo que difiera lo quitó el filtro, no el formateo.

Y una trampa que solo apareció al probarlo: la primera versión **rechazaba un `<a target="_blank">`
legítimo**. La pasada estricta le *añade* `rel="noopener noreferrer"` vía `transformTags` y la
permisiva no, así que las salidas diferían por una **adición**. La sonda aplica ahora la misma
transformación; el `forceSafeLinkRel` está extraído a una constante precisamente para que no puedan
divergir.

### Una aserción que medía lo que no era

La prueba de que el escapado y el saneado se suman en vez de anularse empezó siendo
`expect(markup).not.toContain('onerror=')`. Falló, y por una razón instructiva: Handlebars escapa el
`=` como `&#x3D;`, pero `sanitize-html` lo re-serializa como `=` al normalizar entidades. El texto
literal `onerror=` **sí** aparece en la salida.

Y es inofensivo: está dentro de un nodo de texto, con el `<` como `&lt;`, así que el navegador nunca
construye la etiqueta. La aserción correcta es sobre la salida completa, no sobre una subcadena. Es
un buen recordatorio de que en seguridad la prueba tiene que medir la propiedad real —"no se forma un
elemento"— y no un proxy textual de ella.

### Jest no podía cargar sanitize-html

Añadir el import rompió las cuatro suites que lo alcanzaban:

```
node_modules/sanitize-html/node_modules/htmlparser2/dist/index.js:1
import { Parser } from "./Parser.js";
SyntaxError: Cannot use import statement outside a module
```

`htmlparser2@12` es ESM puro y **no publica build CJS**. Node 22+ lo requiere sin problema —de ahí
que la app funcione— pero el pipeline CommonJS de Jest no. La salida es dejar que ts-jest transforme
esa cadena, y el repo ya tenía el precedente con `@scure`/`@noble`.

El primer intento no funcionó: el lookahead `/node_modules/(?!htmlparser2/…)` se evalúa justo tras el
**primer** `/node_modules/`, y `htmlparser2` vive en el anidado de `sanitize-html`. Hacía falta el
prefijo `.*`, que es justo por lo que la excepción existente estaba escrita así.

### Contrato de namespaces: el fallo se adelanta a la configuración

`isConfigValid` gana una tercera condición: `missingRequiredVariables.length === 0`. Si la plantilla
interpola `{{scraped_web.headline}}` y ningún nodo previo escribe `scraped_web`, antes se podía
avanzar y el fallo aparecía en ejecución, como un `GRAVE` con `missingFields` y el flujo `PAUSADO`.

Se valida la **raíz** de la ruta, no la ruta entera: lo que un nodo previo produce es el namespace
completo, así que `llm_response.articles.0.title` se satisface con que alguien escriba
`llm_response`. El banner nombra namespaces y no rutas por la misma razón — lo que hay que añadir al
flujo es un nodo, no un campo.

`availableUpstreamNamespaces` es un mock y el TSDoc lo dice: la fuente real son los `outputNamespace`
de los nodos anteriores, que el asistente inyectará. El banco de pruebas lo suple con checkboxes, que
es la única forma hoy de ver `isConfigValid` conmutar en vivo.

### Detalles de implementación

- **`ip-whitelist/IpWhitelistManager.vue` no existe.** El componente es
  `allowed-ips/AllowedIpsManager.vue`; solo la *página* se llama `IpWhitelistPage.vue`.
- **`color="grey-5"` no entró.** El proyecto está 100 % limpio de `grey-N` y `frontend-quasar.md` §2
  lo prohíbe; el icono toma el color de `--pd-text-secondary` desde `.pd-search-input`.
- **El ref del filtro se tipa `string | null`.** El botón `clearable` de QInput escribe `null`, y
  QTable declara su prop `filter` como `any`: el compilador no habría delatado la mentira.
- **Los botones de crear no se movieron** al slot de la tabla: los tres gestores conservan su
  anatomía y el CTA su prominencia. Solo el buscador va en `#top-right`.
- **`allowedTags` se amplió** con `figure`, `figcaption`, `code`, `pre`, `caption`, `tfoot`, `sub`,
  `sup`, `small` y `time`. Todas semánticas y sin capacidad de ejecución; una imagen con pie de foto
  es markup normal en una noticia y con la lista original se habría perdido.

### Verificación

```
Backend
  npm test          19 suites, 260 pruebas (antes 239; +21)
  npx tsc --noEmit  13 errores, todos preexistentes en allowed-ips.service.spec.ts
  npm run lint      1 warning, preexistente en main.ts
  npm run build     OK

Frontend
  npm run typecheck  limpio
  npm run lint:check limpio
  npm test           2 archivos, 30 pruebas (antes 19; +11)
  npm run build      OK
```

### Checklist de dependencias restantes

- [ ] **Plantillas anteriores a este cambio** pueden contener markup no publicable: se sanea al
      compilar, pero solo se rechaza al volver a guardarlas. Una consulta que las liste ayudaría.
- [ ] **`allowedStyles` sin restringir**: el atributo `style` pasa con cualquier valor. Los vectores
      clásicos (`expression()`, `url(javascript:)`) los bloquean los navegadores modernos, pero
      acotar las propiedades permitidas cerraría el asunto del todo.
- [ ] **El filtro es cliente**: con miles de filas habrá que pasar a paginación de servidor
      (`@request` de QTable). Hoy las tres tablas caben en memoria de sobra.
- [ ] **`availableUpstreamNamespaces` sigue siendo un mock** hasta que exista el asistente (PROT-12).
- [ ] **`loadPreview` y `previewResult` del store del nodo son código muerto**: nadie los consume,
      porque `TemplateMapperConfig` pasa `selectedTemplate` directo al diálogo de vista previa.

---

## 2026-09-03 · Diagnóstico visual del marcado rechazado — rama `feat/html-template-mapper`

Desde el cambio anterior, guardar una plantilla con `<script>` devolvía un 400 y no persistía nada.
El autor se enteraba, pero no sabía **dónde**: un `$q.notify` con un párrafo genérico y un editor sin
marcar. En una plantilla de ochenta líneas eso es una búsqueda a ojo.

Ahora el backend dice qué construcción sobra y el editor la subraya en rojo, con marcador en el
gutter y tooltip, limpiándose sola al corregir.

### El caso de aceptación era, literalmente, el que no funcionaba

La receta prescribía `cheerio.load(html, null, false)` y, como comprobación manual, escribir
`<body><p>Hola</p></body>` y confirmar el subrayado. Ejecutando lo primero antes de escribir nada:

```
cheerio.load('<body> <p>Hola</p> </body>', null, false)  ->  p
cheerio.load('<p>ok</p><script>x</script>', null, true)  ->  html head body p script
```

Con `isDocument: false`, parse5 parsea en **modo fragmento** y descarta `<body>`, `<html>` y `<head>`
por ser inválidos en ese contexto: el recorrido nunca los ve, y la infracción se vuelve
indetectable. Con `isDocument: true` ocurre lo contrario — parse5 **sintetiza** los tres en cualquier
entrada, así que el 100 % de las plantillas quedarían marcadas. Ninguno de los dos modos sirve.

La salida es cambiar de parser a htmlparser2, con la opción pública `{ xml: { xmlMode: false } }`.
Como **objeto** y no `xml: true`: basta con que sea truthy para elegir htmlparser2, pero `true`
activa además el modo XML, que es sensible a mayúsculas y dejaría `<BODY>` como `BODY` — fuera de la
lista blanca, y con el target del subrayado en mayúsculas.

El beneficio de segundo orden acabó pesando más que el arreglo: htmlparser2 es el parser que ya usa
`sanitize-html`. Auditor y saneador ven ahora **un único DOM**. Con parse5 verían dos, y el auditor
podría aprobar algo que el saneador recorta, o al revés.

### La detección ya existía; lo que faltaba era la localización

Fácil de confundir: el 400 por `<body>` no es nuevo. La sonda de dos pasadas del cambio anterior ya
lo rechazaba, junto con `<section>` y `srcset`.

Eso descartó la idea de sustituir la sonda por la auditoría. Las reglas propuestas —etiqueta, `on*`,
protocolo— **no cubren `srcset`** ni ningún otro atributo fuera de la lista blanca, así que cambiar
una por otra habría sido una regresión de cobertura disfrazada de mejora. La sonda se queda como
**puerta** (compara el saneador entero, es exhaustiva por construcción) y la auditoría entra como
**localizador** que solo enriquece la excepción.

### Una segunda lista blanca es una lista blanca que va a divergir

La receta pedía declarar una constante `ALLOWED_TAGS` nueva. `TEMPLATE_SANITIZER_CONFIG.allowedTags`
ya estaba en el mismo archivo. Con dos listas, añadir `section` al saneador dejaría al auditor
marcándolo para siempre y el autor recibiría un 400 por algo que en realidad se publica sin problema.

La auditoría deriva sus tres conjuntos de la config del saneador. Contrastar ambas sobre dieciséis
casos —hay una prueba que lo hace, la 6.12— confirmó que coinciden, incluidos los que las reglas
originales dejaban fuera.

### El servicio puro sigue sin lanzar

La receta situaba el `throw new BadRequestException` dentro de `TemplateRendererService`. Ese
servicio devuelve uniones discriminadas precisamente para que cada consumidor construya su respuesta,
y uno de ellos es `TemplateMapperStrategy`, que no habla HTTP: acoplarlo al transporte lo habría
roto.

`auditPublishableMarkup` devuelve `TemplateViolation[]` y no lanza. Quien lanza sigue siendo
`TemplatesService.assertPublishableMarkup`, que ya existía y ya estaba invocado desde `create` y
`update` — **cero puntos de llamada nuevos**.

### El `target` tiene dos formas, y hay que decir cuál es cuál

Al ampliar el alcance a las variables aparecieron tres emisores más, y sus targets no se parecen a
los del markup. `invalidVariable` guarda `bad_ns.titulo`: sin llaves y con la ruta ya normalizada.
Buscar eso en el documento fallaría cuando el autor escribiese `{{ bad_ns.titulo }}` con espacios, o
`{{ llm_response.articles.[0].title }}`.

De ahí la invariante que documenta el propio tipo:

- `tag`, `attribute`, `protocol` → identificador **normalizado en minúsculas**; el editor lo busca
  con un patrón estructural insensible a mayúsculas.
- `variable` → subcadena **verbatim** del documento; búsqueda literal.

El emisor de las variables pasa el match completo del regex, que hasta ahora se descartaba como
`_match`.

### Por qué el matcher no es un `indexOf`

Es la pieza cuyo fallo sería silencioso: subrayar de menos o de más no rompe nada visible. Un
`indexOf(target)` casa `<p` dentro de `<pre>`, `onerror=` dentro de `data-onerror=`, y la palabra
«body» de un párrafo con la etiqueta. Cada tipo lleva su frontera —lookahead para las etiquetas,
lookbehind para los atributos— y el target pasa siempre por un escapador: `{{{` sin escapar es un
cuantificador inválido.

Por eso vive en `src/utils/violation-matcher.ts` y no dentro del SFC. Vitest corre en entorno `node`,
sin DOM, así que dentro del componente no habría forma de probarlo; fuera, son catorce pruebas contra
un documento con señuelos deliberados para cada falso positivo.

Los diagnósticos se limpian solos en el `updateListener` que ya existía. No hay bucle porque
`setDiagnostics` despacha efectos de estado, no cambios de documento.

### Dos cosas que se ajustaron sobre la marcha

- **`expect.stringContaining` devuelve `any`** y dispara `no-unsafe-assignment`, que en este proyecto
  es error y no aviso. Los mensajes se afirman por separado con `toContain`.
- Una aserción propia estaba mal, no el código: en `<BODY><IMG ONERROR=…></BODY>` esperaba solo la
  infracción de `body`. La guarda que salta los atributos de una etiqueta prohibida cubre los
  atributos **del propio elemento**, no los de su descendencia — y debe ser así, porque `discard`
  elimina el `<body>` pero conserva sus hijos: ese `onerror` llegaría al artículo publicado.

### Verificación

```
Backend
  npm test           19 suites, 275 pruebas (antes 260; +15)
  npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npm run lint       solo el warning preexistente de main.ts
  npm run build      OK

Frontend
  npm run typecheck  limpio
  npm run lint:check limpio
  npm test           3 archivos, 44 pruebas (antes 30; +14)
  npm run build      OK
```

`cheerio` no necesitó tocar `transformIgnorePatterns`: es dual y su build CJS resuelve
`htmlparser2@10` de raíz, no la copia `@12` ESM-only anidada bajo `sanitize-html` que rompió la suite
en el cambio anterior.

### Checklist de dependencias restantes

- [ ] **Las infracciones no se acumulan**: `create` valida variables antes que markup, así que una
      plantilla con las dos cosas mal reporta solo la primera. Es el *fail-fast* declarado, pero
      obliga a dos rondas de guardado.
- [ ] **El resaltado no sobrevive a una edición**: cualquier tecla limpia los diagnósticos, porque
      las posiciones se calcularon sobre el documento enviado. Mapearlas a través de los `ChangeSet`
      de CodeMirror permitiría conservarlas mientras el autor corrige.
- [ ] **La vista previa no informa de infracciones**: `previewTemplate` compila y sanea, pero no
      audita. Una plantilla guardada antes de estos cambios se ve recortada sin explicación.

---

## 2026-09-03 · Límite de sesiones activas y retirada de la purga muerta (MOD-01) — rama `feat/auth-token-cleanup`

El encargo listaba tres defectos del ciclo de vida de los refresh tokens. **Dos no existían**, el
tercero sí, y la forma en que el encargo proponía resolverlo habría abierto un fallo peor que el
que cerraba.

### Dos de los tres defectos ya estaban resueltos

| Defecto del encargo | Realidad |
|---|---|
| «La purga solo evalúa `isRevoked`, dejando huérfanos los caducados» | `pruneDeadTokens` ya usaba un `where` en array, que en TypeORM es un **OR**: revocado **o** caducado. Ambos criterios, desde la entrada de poda transaccional del 27-08 |
| «Múltiples peticiones del mismo `deviceId` generan filas redundantes» | `issue()` ya revocaba `{userId, deviceId, isRevoked: false}` **antes** de insertar, dentro de la transacción. `id_dispositivo` existe de punta a punta desde la migración `004` |
| «Máximo de 5 dispositivos activos» | **Cierto, no existía.** El único trabajo real |

Fácil de confundir con lo segundo: en el archivo ya había un `RETAINED_DEAD_TOKENS = 5`. Es otra
cosa por completo — cuántos tokens *muertos* se conservan como ventana de detección de reuso, no
cuántas sesiones *vivas* se permiten. Las dos constantes valen 5 y no tienen relación; el docblock
de la nueva lo dice de forma explícita porque el próximo que lo lea va a asumir lo contrario.

Añadí pruebas para los dos defectos inexistentes. No por ceremonia: el encargo los daba por rotos,
así que conviene que quede escrito que funcionan y que no puedan romperse en silencio.

### Revocar las sesiones sobrantes habría sido el fallo

El encargo ofrecía «revocar **o** eliminar los más antiguos» como si fuesen intercambiables. No lo
son, por cómo está construido `rotate()`:

```
El dispositivo expulsado presenta su token en /auth/refresh
   │
   ├── si se REVOCÓ   → la fila sigue ahí, con isRevoked = true
   │                    → rotate() lo lee como REUTILIZACIÓN
   │                    → revokeAllForUser() TUMBA LAS OTRAS 5 SESIONES
   │                    → y deja una alerta de robo FALSA en el log
   │
   └── si se ELIMINÓ  → no hay fila → 401 corriente, mensaje opaco de siempre
```

Cada expulsión rutinaria por cupo se habría convertido en una falsa alarma de robo que echa al
usuario de todos sus equipos. El límite **borra**.

Es la contrapartida exacta de una decisión anterior: los tokens muertos se conservan porque son la
ventana de detección, pero una sesión **viva** expulsada por cupo no debe dejar rastro revocado.
Ese es el motivo de que no se reutilizara `revokeAllForUser` ni nada parecido.

### Por qué el `skip` va después del `save`

`enforceSessionLimit` corre dentro de la transacción que `issue()` ya abría, después del `save`.
El token recién insertado es el más reciente, así que ordenando por `createdAt DESC` nunca cae en
la cola del `skip` y no puede expulsarse a sí mismo — el mismo razonamiento que ya justificaba el
orden insertar → podar.

Se ordena por `createdAt DESC, id DESC`. El desempate no es adorno: dos tokens emitidos en el mismo
instante comparten `createdAt`, y sin él, cuál de los dos cae del lado del corte lo decidiría el
plan de ejecución de PostgreSQL.

### El fallback de la vigencia no cubría lo que parecía

`?? DEFAULT_EXPIRATION_DAYS` solo atrapa la variable ausente, y del `.env` siempre llega una cadena:

| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | Antes | Ahora |
|---|---|---|
| ausente | 7 días ✓ | 7 días |
| `` (vacía) | `Number('') === 0` → **el token nace caducado y el login queda roto** | 7 días |
| `abc` | `NaN` → fecha inválida | 7 días |
| `-3` / `0` | expiración en el pasado | 7 días |

El primero es el que asusta: la sesión no se abriría nunca y no habría un solo error en el log que
lo explicara. Ahora se valida el número resultante, no la mera presencia de la variable.

Se conservó el nombre `REFRESH_TOKEN_EXPIRES_IN_DAYS` en vez del `REFRESH_TOKEN_EXPIRES_IN` que
pedía el encargo: lleva la unidad en el nombre, ya está en `.env` y `.env.example`, y el corto
quedaría ambiguo junto a `JWT_EXPIRES_IN=1h`, que la lleva en el valor.

### `purgeExpired()` retirada

Código muerto: cero llamadas en todo `backend/src`, ni siquiera en tests. Y además incompleta —solo
miraba `expiresAt`, sin retención—, así que engancharla a un `@Cron` habría borrado la ventana de
detección de reuso de todos los usuarios. Un método muerto que encima es una trampa para el
siguiente que lo encuentre no merece conservarse; la ruta viva ya purga en cada emisión.

### El arnés de pruebas tuvo que aprender a distinguir dos consultas

`issue()` lanza ahora **dos** `find` en la misma transacción, y el doble devolvía `[]` para
cualquiera. Se discriminan por la forma del `where` —objeto para el cupo, array para el OR de la
poda— y no por el orden de llamada: indexar por posición ataría las pruebas al orden interno de
`issue()`, que es un detalle de implementación y ya cambió una vez en esta misma tarea.

### Verificación

```
Backend
  npm test           19 suites, 289 pruebas (antes 275; +14)
  npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npm run lint       solo el warning preexistente de main.ts
  npm run build      OK
```

Sin migración y sin tocar `.env`: no hay columna nueva y el nombre de la variable se mantiene.
La migración `004` ya dejó dicho que `idx_refresh_tokens_id_usuario` cubre este filtro.

### Checklist de dependencias restantes

- [ ] **El cupo no se aplica al renovar sin emitir.** `enforceSessionLimit` vive en `issue()`, así
      que un usuario con 6 sesiones abiertas de antes no baja a 5 hasta que alguna emita. En la
      práctica renovar pasa por `issue()`, pero una cuenta inactiva conserva el exceso.
- [ ] **`MAX_ACTIVE_SESSIONS` no es configurable por entorno.** Está fijo a 5, como pedía el
      encargo. Si alguna vez hay que ajustarlo por despliegue, la variable no existe.
- [ ] **Sigue sin haber barrido periódico.** `@nestjs/schedule` está instalado y `ScheduleModule`
      nunca se importa. Si se añade, el barrido debe respetar la retención **por usuario**: uno
      global destruiría la ventana de detección de reuso.
- [ ] **`rotate()` e `issue()` no comparten transacción** (pendiente preexistente): si la emisión
      fallara tras la revocación, el usuario queda sin sesión y debe reentrar por OTP.

---

## 2026-09-04 · Habilitador de despacho manual (Camino B) y namespace `_assets` — rama `feat/html-template-mapper`

Primera ejecución del pipeline **completo** disparada por HTTP: `POST /api/workflows/:id/run-test`
recorre `FsmEngineService` → `StatePayloadContext` → `TemplateMapperStrategy` →
`TemplateRendererService` sin depender del listener IMAP.

### Estados de la FSM ejercitados

| Transición | Cómo se provocó | Resultado verificado |
|---|---|---|
| `INACTIVO → EN_PROCESO → EXITOSO` | Despacho con `initialPayload` completo | 200, `activeCursor: null`, markup compilado |
| `INACTIVO → EN_PROCESO → PAUSADO` | Nodo `MAPEADOR_PLANTILLA` sin variable requerida | 200 con `finalState: PAUSADO` y el cursor culpable |
| Rechazo previo al alta | Fila `EN_PROCESO` preexistente del mismo flujo | **409** `ConflictException` sin crear fila |
| Rechazo previo a la validación | UUID sin fila en `flujos` | **404** `NotFoundException` |

### El plan pedía `id_flujo: 'wf-test-template-e2e'` y eso no puede existir

`flujos.id_flujo` es `UUID PRIMARY KEY` (`init.sql:83`) y el endpoint valida el parámetro con
`ParseUUIDPipe`. Un identificador legible se habría rechazado con un 400 **antes de llegar al
servicio**, o habría reventado en el `INSERT`. El seed usa una constante UUID v4 escrita a mano
(`11111111-2222-4333-8444-555555555555`) y no un UUID aleatorio: fijarla permite dejar el `curl` en la
documentación sin releer la base tras cada siembra. El seed la imprime ya sustituida.

### `createExecution` no existía

El plan lo daba por implementado. `FsmEngineService` solo tenía `executeWorkflow`, que **espera una
fila ya creada**; las pruebas anteriores la sembraban a mano desde el fixture del runner. Se añadió
con la guarda de cupo dentro, para que el 409 se decida en un solo sitio.

También hubo que reconciliar nombres: el plan hablaba de `workflowId` y `fsmExecutionRepository`, pero
la entidad expone `flowId` (columna `id_flujo`) y el motor inyecta `fsmExecutionRepo`. Se respetó lo
que ya había: renombrar la columna habría arrastrado a `logs_nodo` y `alertas_error`, que le apuntan
con clave foránea.

### Por qué el cupo configurable no relaja nada

`MAX_CONCURRENT_EXECUTIONS_PER_FLOW=1` coincide con lo que ya impone `idx_flujo_activo`, el índice
único **parcial** de PROT-08. La guarda de aplicación no es la barrera —hay una ventana entre su
`count` y el `UPDATE` a `EN_PROCESO`— sino el **diagnóstico**: convierte un 500 por violación de
unicidad en un 409 que dice qué flujo y qué cupo. Subir la variable no levanta el límite real; solo
devuelve el fallo feo. Queda anotado en el checklist.

### `_assets` cupo en la gramática existente sin tocarla

`TEMPLATE_VARIABLE_PATTERN` ya aceptaba `[a-zA-Z0-9_]+` como raíz del namespace, así que
`{{_assets.base_url}}` se parsea sin modificar el validador. Solo hubo que añadir `_assets` a
`ALLOWED_NAMESPACES` — y a su réplica del frontend (`TEMPLATE_NAMESPACES`), que alimenta los chips
Poka-Yoke del editor. Dejarla desincronizada habría hecho que el backend aceptara una variable que el
autor no puede seleccionar, que es exactamente el fallo que esa réplica existe para evitar.

Se fusiona **al final** del spread, no al principio: un nodo que escribiera en `_assets` podría
redirigir todas las imágenes del artículo a un dominio ajeno. Hay prueba dedicada (7.7).

Y se inyecta **antes** del pre-chequeo de variables. Con el orden inverso, `_assets.base_url` figura
en `requiredVariables` pero no en el contexto crudo, y el nodo fallaría siempre con un `missingFields`
que el operador no podría corregir de ninguna manera.

### La normalización de barras se limitó a las claves de ruta

El plan decía «si un campo `image_path` (o ruta relativa) inicia con `/`, recortarlo». Interpretarlo
como «toda cadena del contexto» habría corrompido datos: un `clean_body` que arranque con `/` o un
`source_url` relativo perderían su primer carácter, y eso es un fallo silencioso mucho peor que la
doble barra visible que se pretende evitar.

La regla es determinista y está documentada en el código: `ASSET_PATH_KEY_PATTERN = /(?:^|_)path$/`,
que cubre `image_path`, `path`, `file_path`, `thumbnail_path`. El recorrido es de un solo nivel; bajar
recursivamente obligaría a clonar en profundidad todo el contexto en cada render para respetar la
inmutabilidad del `StatePayloadContext`, y las rutas de asset que el pipeline produce viven en la raíz
del namespace de su nodo.

De paso se recorta la barra **final** del prefijo (`ASSETS_BASE_URL=…/uploads///`), que es el error de
`.env` complementario y no cuesta nada cubrir.

### `ConfigService` en el renderer obligó a tocar cuatro suites

`TemplateRendererService` se instanciaba con `new TemplateRendererService()` en cuatro sitios
(`nodes.module.spec`, `template-mapper.strategy.spec`, `templates.service.spec` y su propio spec).
En vez de repetir el doble cuatro veces se añadió `test/factories/template-renderer.factory.ts`, con
el `ConfigService` **real** sembrado por `internalConfig` y no un objeto casteado: así la prueba
verifica también que la clave que el servicio pide (`ASSETS_BASE_URL`) es la que existe de verdad.

Anotado en el propio archivo: `ConfigService.get()` da prioridad a `process.env` sobre el objeto
interno, así que exportar `ASSETS_BASE_URL` en el shell haría que estas pruebas leyeran ese valor.

Con la factoría hizo falta un alias: `@test/*` en `tsconfig.json`, `package.json` (jest) y
`test/jest-e2e.json`. Sin él, importarla desde `src/modules/**` exigía `../../../../test/…`, que
`code-conventions.md` §6 prohíbe.

### Una prueba ajena se rompió, y estaba bien que se rompiera

`templates.service.spec.ts` 8.1 transcribía la lista de namespaces dentro del mensaje esperado.
Añadir `_assets` la tumbó. Se cambió por una plantilla derivada de `ALLOWED_NAMESPACES.join(', ')`:
esa prueba verifica el **localizador de infracciones**, no el contenido de la lista blanca, y no debe
volver a caerse cada vez que se añada un namespace.

### El seed dejó de exportar sus constantes

Al verificar contra PostgreSQL se importó `TEST_FLOW_ID` desde el seed… y el seed **se ejecutó**:
el archivo llama a `main()` en el nivel superior. Exportar constantes desde un módulo autoejecutable
es una trampa para el siguiente que las necesite, así que pasaron a locales. Lo que haya que
compartir irá a un `*.fixture.ts` aparte, como ya hace `dummy-pipeline.fixture.ts` frente a
`run-dummy-e2e.ts`.

### `HttpStatus.OK` y no el 201 por defecto de `@Post`

La petición es síncrona y el cuerpo devuelve el **resultado**, no la fila creada. Un flujo `PAUSADO`
tampoco es un error HTTP: es un 200 con `finalState` y `activeCursor`, que es lo que necesita CU-09
para el reintento manual.

### Verificación

```
Backend
  npm run build              OK
  npm test                   20 suites, 307 pruebas (antes 289; +18)
  npx tsc --noEmit           solo los 13 errores preexistentes de allowed-ips.service.spec.ts
  npx eslint (ficheros tocados)  limpio
  npm run seed:fsm-runner    OK, idempotente en la segunda pasada

Frontend
  npm run typecheck          OK
  npm test                   3 ficheros, 44 pruebas

E2E contra PostgreSQL (5433)
  finalState                 EXITOSO
  activeCursor               null
  namespaces                 parsed_email, rendered_html
  markup                     <img src="http://localhost:3000/static/uploads/2026/09/laboratorio.jpg" …>
  doble barra                ausente
  fila EN_PROCESO previa     409 ConflictException
  UUID inexistente           404 NotFoundException
```

El `image_path` de entrada llevaba barra inicial (`/2026/09/laboratorio.jpg`): la URL de salida es la
prueba de que la normalización actúa.

### Checklist de dependencias restantes

- [x] ~~**`ASSETS_BASE_URL` apunta al puerto 3000 y la API escucha en el 5000.**~~ Falsa alarma: el
      `PORT=5000` que vi era el de `backend/.env.example`; el `backend/.env` real declara `PORT=3000`.
      No había discrepancia.
- [x] ~~**No existe la ruta `/static/uploads`.**~~ Resuelto el 2026-09-04 con `ServeStaticModule`
      (ver la entrada siguiente).
- [ ] **La carrera del cupo devuelve 500, no 409.** Dos despachos verdaderamente simultáneos pueden
      pasar los dos el `count`; el segundo choca contra `idx_flujo_activo` en el `UPDATE` a
      `EN_PROCESO`, que ocurre **fuera** del `try` de `executeWorkflow` y sube como `QueryFailedError`.
      Traducirla exigiría atrapar la violación de unicidad de PostgreSQL (`23505`) y reemitirla como
      `ConflictException`.
- [ ] **El despacho manual ignora `flujos.activo` a propósito** (probar antes de habilitar). Cuando
      exista el disparador automático, es él quien debe respetarla.
- [ ] **Sin cola.** La petición bloquea el hilo HTTP hasta que el motor termina.
      `architecture-patterns.md` §5 pide BullMQ para las ejecuciones pesadas; aquí el pipeline es de
      un solo nodo y el bloqueo es aceptable para una herramienta de verificación, no para producción.
- [ ] **Sin `NotificationGateway`.** El frontend no recibe `node_started` / `flow_finished`: no hay
      WebSocket todavía, así que el resultado solo llega en la respuesta HTTP.
- [ ] **Sin prueba e2e automatizada del endpoint.** La verificación de arriba se hizo con un script
      desechable contra la base real; `test/` no tiene un `workflows.e2e-spec.ts` que la repita en CI.

---

## 2026-09-04 · Entrega de archivos estáticos (`ServeStaticModule`) — rama `feat/html-template-mapper`

Cierra el pendiente que dejó el Camino B: `{{_assets.base_url}}` componía una URL correcta que no
resolvía a ningún archivo. Ahora `backend/static/uploads/` se sirve en `/static/uploads`.

### La versión 12 de `@nestjs/serve-static` no vale aquí

`npm install @nestjs/serve-static` falló con `ERESOLVE`: la 12.0.0 exige `@nestjs/common@^12` y el
proyecto va en Nest 11.2.3. **No** se resolvió con `--force` ni `--legacy-peer-deps`, que habrían
dejado en el árbol un paquete construido contra una API distinta para que reventara en runtime. Se
instaló la línea correspondiente a Nest 11: `@nestjs/serve-static@^5.0.5`
(peer `@nestjs/common@^11.0.2`, `express@^5.0.1`; el proyecto tiene Express 5.2.1).

Las dos vulnerabilidades que reporta `npm audit` (`fast-uri` alta, `qs` moderada) son **preexistentes**
y transitivas de `ajv` y `express`; no las introduce este paquete y no se tocaron aquí.

### Por qué `process.cwd()` y no `__dirname`

`app.module.ts` se ejecuta desde `src/` en desarrollo y desde `dist/` en producción: una ruta relativa
al módulo apuntaría a dos sitios distintos. El directorio de trabajo es `backend/` en ambos casos.

Y por eso `static/` vive **fuera de `src/`**: `nest build` compila `src/` hacia `dist/` y lo limpia en
cada build, así que un binario ahí dentro se perdería. Tampoco en la raíz del monorepo: la entrega de
archivos es infraestructura del backend.

### `serveRoot` no lleva el prefijo `/api`

`ServeStaticModule` registra sus rutas con `httpAdapter.useStaticAssets()`, es decir, a nivel de
Express y **fuera del router de Nest**, así que `setGlobalPrefix('api')` no las alcanza. Es el mismo
motivo por el que Swagger vive en `/api/docs` y no en `/api/api/docs`.

### ⚠️ Ese mismo hecho abre un agujero en el perímetro

Comprobado contra el servidor en marcha, no deducido:

| Petición con `X-Forwarded-For: 203.0.113.10` (fuera de rango) | Código |
|---|---|
| `GET /api/templates` (ruta Nest, guard global) | **403** |
| `GET /api/docs` (Swagger, protegido a mano en `main.ts`) | **403** |
| `GET /static/uploads/2026/09/laboratorio.jpg` | **200** |

`IpWhitelistGuard` es un `APP_GUARD` del router de Nest y no ve estas rutas — exactamente el caso que
`main.ts` ya documenta para Swagger y resuelve montando `RedLocalMiddleware` a mano.
`security-and-scope.md` §1 exige que toda ruta protegida pase por él. **No se aplicó por decisión
propia** porque cambia quién puede leer las imágenes: si el CMS de destino las descarga desde fuera
del rango corporativo, cerrarlo rompería la publicación. Queda en el checklist para decidir.

### Endurecimiento aplicado y verificado

`index: false` y `redirect: false`. Con el servidor en marcha:

| Petición | Resultado |
|---|---|
| `…/2026/09/laboratorio.jpg` | **200**, `Content-Type: image/jpeg`, 160 bytes |
| `…/2026/09/` (directorio) | 404 — sin listado ni `index.html` implícito |
| `…/no-existe.jpg` | 404 |
| `…/..%2f..%2f.env` | 404 |
| `…/../../.env` (`curl --path-as-is`) | 404 |
| `…/.gitkeep` | 404 — `dotfiles: 'ignore'` por defecto |

### Cadena completa, extremo a extremo

```
runWorkflowTest → EXITOSO
  src interpolado : http://localhost:3000/static/uploads/2026/09/laboratorio.jpg
  GET a esa URL   : 200  image/jpeg  160 bytes
```

El `image_path` de entrada seguía llevando barra inicial. La imagen de prueba (JPEG 1×1) se dejó en
su sitio a propósito: hace que el fixture del Camino B produzca una URL que resuelve de verdad. Está
cubierta por `.gitignore`, así que no se versiona.

### Verificación

```
npm run build      OK
npm test           20 suites, 307 pruebas (sin regresiones)
npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
npm run lint       solo el warning preexistente de main.ts:59
git check-ignore   backend/static/uploads/foto.jpg → ignorado; .gitkeep → versionado
```

### Checklist de dependencias restantes

- [ ] **`/static/uploads` está fuera del perímetro de red** (evidencia arriba). Si estas imágenes solo
      deben verse desde la red corporativa, basta replicar el patrón de Swagger en `main.ts`:
      `app.use('/static/uploads', redLocalMiddleware.use.bind(redLocalMiddleware));`
- [ ] **No hay endpoint de subida.** El directorio se puebla a mano; queda fuera del MVP igual que la
      edición gráfica (`security-and-scope.md` §3). Cuando exista, necesitará validar tipo MIME real
      —no la extensión—, tamaño máximo y un nombre de archivo saneado.
- [ ] **Sin volumen en `docker-compose.yml`.** `backend/static/uploads/` vive en el sistema de
      archivos del host; si el backend se contenedoriza, hay que mapearlo o las imágenes se pierden
      en cada recreación.
- [ ] **Sin caché.** `Cache-Control: public, max-age=0`: se revalida en cada petición. Para
      producción convendría un `maxAge` real, ya que las rutas incluyen año y mes.

---

## 2026-09-04 · Perímetro sobre `/static/uploads` y traducción del conflicto 23505 — rama `feat/html-template-mapper`

Cierra los dos huecos que quedaron anotados en las dos entradas anteriores.

### 1. El perímetro ya cubre los estáticos

`main.ts` renombra `SWAGGER_PERIMETER_PATHS` a `PERIMETER_PATHS` y le suma `/static/uploads`.
Las dos familias comparten causa: ni `SwaggerModule` ni `ServeStaticModule` registran en el
router de Nest, sino en el adaptador de Express, así que el `IpWhitelistGuard` —un `APP_GUARD`
del router— nunca las alcanza. Comprobado contra el servidor en marcha:

| Petición con `X-Forwarded-For: 203.0.113.10` | Antes | Ahora |
|---|---|---|
| `/static/uploads/2026/09/laboratorio.jpg` | 200 | **403** |
| `/api/docs` | 403 | 403 |
| Mismo estático desde localhost | 200 | 200 |

El orden de registro funciona sin trucos: `app.use()` corre en `bootstrap()`, y
`ServeStaticModule` no monta lo suyo hasta `app.init()` —o sea, dentro del `listen()` de más
abajo—, así que el middleware perimetral entra antes en la pila de Express.

### 2. La carrera del mutex ya devuelve 409, no 500

`createExecution` cuenta las ejecuciones `EN_PROCESO` antes de insertar, pero entre ese `count`
y el `UPDATE` a `EN_PROCESO` hay una ventana. Dos despachos simultáneos la pasan los dos, y el
segundo choca contra `idx_flujo_activo`. Eso subía como `QueryFailedError` crudo.

**Detección más estricta que la del encargo.** No basta con `driverError.code === '23505'`:

```
instanceof QueryFailedError  &&  driverError.code === '23505'
&& (driverError.constraint === undefined || driverError.constraint === 'idx_flujo_activo')
```

El nombre de la restricción **estrecha cuando viene, pero no se exige**. Las dos rigideces
alternativas fallan en direcciones opuestas: aceptar cualquier 23505 disfrazaría de 409 el bug
de otra unicidad (fallo silencioso), y exigir siempre el nombre devolvería 500 en una carrera
legítima si el driver no lo informa (`pg` solo asigna `code` y `constraint` cuando el servidor
los envía). El helper se llama `isActiveFlowMutexViolation` y no `isUniqueViolation` a
propósito: el predicado no es «cualquier unicidad», y el nombre genérico invitaría a
reutilizarlo mal en otro servicio.

Se verificó en `node_modules/typeorm@1.1.0` que `QueryFailedError<T extends Error = Error>`
expone `driverError` y que su constructor copia las props del driver también a la raíz — de ahí
que el `instanceof` vaya primero y la lectura sea por `driverError`, que es el camino tipado.

**Solo se envuelve la primera escritura.** El índice es *parcial* (`WHERE estado = 'EN_PROCESO'`):
una vez la fila ya está dentro, ella misma es la única entrada del índice para su `id_flujo`, y
ninguna rival puede entrar mientras tanto. Los `saveCheckpoint` del bucle no pueden violarlo. El
`try` es local y **no** el externo, conservando la intención ya documentada ahí: perder la
carrera no es un fallo del flujo y no debe marcar `FALLIDO`.

### 3. `saveCheckpoint` mutaba la entidad antes de escribir

Hacía `Object.assign(execution, patch)` y *luego* el `UPDATE`. Si la escritura fallaba, la
entidad en memoria anunciaba `EN_PROCESO` sobre una fila que seguía `INACTIVO`. Era inocuo
mientras solo pasaba en el camino catastrófico; con el 409 esa mentira pasaba a estar en un
desenlace **esperado**. Invertido el orden.

No es un detalle cosmético y la prueba lo demuestra: con el orden antiguo,
`NO deberia marcar FALLIDO al perder la carrera por el mutex` falla con
`Expected: "INACTIVO" / Received: "EN_PROCESO"`.

### Verificación

Seis pruebas nuevas en `fsm-engine.service.spec.ts` (bloque `mutex de ejecucion
idx_flujo_activo`), construyendo el `QueryFailedError` **real** de TypeORM y no un objeto de
forma parecida: la guarda arranca con un `instanceof` y un doble suelto la dejaría sin
ejercitar. Cubren el 23505 con y sin `constraint`, el 23505 de otra restricción, un
`40001` y un `Error` ajeno a TypeORM.

```
npm run build      OK
npm test           20 suites, 313 pruebas (antes 307; +6)
npx tsc --noEmit   solo los 13 errores preexistentes de allowed-ips.service.spec.ts
npm run lint       solo el warning preexistente de main.ts

Carrera real contra PostgreSQL (script desechable):
  createExecution sin rivales      -> ejecucion INACTIVO creada
  se inserta una rival EN_PROCESO  -> reproduce la ventana del count
  executeWorkflow                  -> ConflictException, httpStatus 409
  estado de la fila                -> INACTIVO (no se marco FALLIDO)
```

### Checklist de dependencias restantes

- [x] ~~`/static/uploads` está fuera del perímetro de red.~~ Resuelto aquí.
- [x] ~~La carrera del cupo devuelve 500, no 409.~~ Resuelto aquí.
- [ ] **La guarda de `createExecution` sigue sin ser atómica**, y así se queda: la barrera real
      es el índice único parcial, que funciona incluso con varios procesos. Lo que hay ahora son
      dos capas de *diagnóstico* sobre esa barrera, no dos barreras.
- [ ] **Sin prueba e2e automatizada de la carrera.** La verificación de arriba es un script
      desechable; reproducirla en CI exige dos conexiones concurrentes reales.

---

## 2026-09-07 · Nodo de ingesta `TRIGGER_IMAP` y sondeo periódico — rama `feat/trigger-imap`

Primera estrategia **productora** del motor: hasta ahora todas las piezas reales consumían un contexto
que alguien había sembrado por HTTP. `DummyInputStrategy` ocupaba el hueco de `NodeType.TRIGGER_IMAP`
devolviendo sus propios `params`, y su TSDoc anticipaba el relevo: *"el dia que exista la estrategia
IMAP de verdad ocupara exactamente este hueco"*. Ese día es hoy.

### Estado de la FSM implementado

```
flujos.activo=true + IMAP_POLLING_ENABLED=true
        │
        ▼
[intervalo imap-poll:<flowId>]  cada pollIntervalMs
        │
        ├─ STATUS unseen=0 ──────────────────────────► fin del ciclo (nada que hacer)
        │
        └─ STATUS unseen>0
                 │
                 ▼
        createExecution ─── 409 ──► aviso, el correo sigue UNSEEN, próximo ciclo
                 │
                 ▼ INACTIVO → EN_PROCESO
        ImapTriggerStrategy.execute()
                 ├─ config inválida ────────────► success:false GRAVE → PAUSADO
                 ├─ passwordEnvKey sin valor ───► success:false GRAVE → PAUSADO
                 ├─ red / auth / timeout ───────► success:false GRAVE → PAUSADO (reintentable)
                 ├─ buzón vacío ────────────────► success:true {status:NO_MESSAGES_FOUND}
                 └─ correo UNSEEN ──────────────► success:true {6 claves} + \Seen
                                                        │
                                                        ▼
                                     setNamespace(node.outputNamespace, data)
```

### El "por qué" de cuatro decisiones

**1. `validate()` y no `validateOrReject()`.** El enunciado inicial pedía la segunda. No es un detalle
de estilo: `validateOrReject` lanza, y `FsmEngineService.runNode` captura toda excepción y la normaliza
a nivel `URGENTE`. Como `canRetry` solo reintenta los `GRAVE`, un `host` mal escrito habría quedado
**permanentemente irrecuperable** en lugar de PAUSADO y corregible vía CU-09. Se valida con `validate()`
y se traducen los errores a `NodeResult` GRAVE con `missingFields`, igual que hace el mapeador de
plantillas con su plantilla ausente.

**2. La contraseña por referencia, y el patrón que la acota.** El modelo híbrido (`passwordEnvKey` en
`params`, secreto en `.env`) resuelve el problema obvio: no dejar la clave del buzón en la columna JSONB
ni mandarla al editor de flujos. Pero abre uno menos obvio, y es el hallazgo que más cambió el código:
`params` lo edita un rol EDITOR, así que con la clave libre un editor podía escribir
`host: imap.atacante.com` + `passwordEnvKey: JWT_SECRET` y el backend habría entregado el secreto de
firma de tokens, en claro, a un servidor ajeno, como si fuera una contraseña IMAP. De ahí el
`@Matches(/^IMAP_[A-Z0-9_]*PASSWORD$/)`: acota lo que el nodo puede llegar a leer del entorno. La
prueba 3.4 lo blinda comprobando que el rechazo ocurre **antes** de tocar `ConfigService`.

**3. Un solo lector del buzón.** El sondeo podría leer el correo y pasarlo al motor como
`initialPayload`, ahorrando una reconexión. Se descartó: el sondeo tendría que marcar `\Seen` al leer, y
entonces cualquier fallo posterior (un 409 de concurrencia, el proceso muriendo entre la lectura y el
arranque) dejaría el correo consumido **sin nada en el buzón que indique que hay que reprocesarlo**. Y
si no lo marcase, el ciclo siguiente lo publicaría por segunda vez. No hay tercera opción. Con el
sondeo limitado a `STATUS` —que no abre el buzón ni toca banderas— el correo permanece `UNSEEN` hasta
que lo consume la estrategia, así que un ciclo perdido no pierde nada. Efecto secundario deseable: la
misma estrategia sirve para el disparo manual del Camino B sin cambios.

**4. `SchedulerRegistry`, no `@Cron`.** `pollIntervalMs` es un parámetro por nodo, y un decorador se
evalúa una vez en tiempo de clase: no admite un periodo distinto por flujo. Tres trampas que el código
tuvo que cubrir explícitamente:
- `addInterval` **lanza** si el nombre ya está tomado ⇒ se borra antes de re-registrar.
- `addInterval` **no** envuelve el callback en try/catch ⇒ `pollInbox` no puede rechazar nunca, o una
  promesa sin manejar termina el proceso en Node ≥ 18.
- `main.ts` no llamaba a `enableShutdownHooks()` ⇒ `onModuleDestroy` no corría con SIGTERM y los
  intervalos habrían sobrevivido a cada recarga de `--watch`, sondeando el mismo buzón con varias
  generaciones del proceso. Agujero preexistente que esta rama es la primera en convertir en problema
  real; se añade la línea que faltaba.

### Poka-Yoke: por qué el sondeo nace apagado

`IMAP_POLLING_ENABLED=false` por defecto, y el código exige el literal `'true'` en lugar de
`!== 'false'`. El motivo no es la prudencia genérica: la estrategia marca `\Seen`. Un backend arrancado
en el portátil de un desarrollador apuntando al buzón corporativo **consumiría los correos de
producción**, y el entorno que sí debía procesarlos no volvería a verlos. El fallo por omisión tiene que
ser "no sondea". Con `flujos.activo` son dos interruptores en serie, uno global y otro por flujo.

### Verificación

```
npm test          → 22 suites, 360 pruebas en verde (46 nuevas)
tsc --noEmit      → limpio sobre tsconfig.build.json
eslint            → limpio
```

Cobertura nueva: 25 pruebas de la estrategia (extracción, cascada `html → textAsHtml → text`, buzón
vacío por `[]` y por `false`, resolución del secreto, exfiltración rechazada, `\Seen` posterior al
parseo, cierre en `finally` sin enmascarar el error real, inmutabilidad del contexto) y 21 del sondeo
(programación por flujo, filtros de elegibilidad, tick solapado, 409 tolerado, resiliencia del callback).

### Checklist de dependencias restantes

- [x] ~~`NodeType.TRIGGER_IMAP` sin estrategia real.~~ Resuelto aquí.
- [x] ~~`main.ts` sin `enableShutdownHooks()`.~~ Resuelto aquí.
- [x] ~~`nodo_trigger` no está en `ALLOWED_NAMESPACES`.~~ Resuelto en el commit siguiente: el default
      pasa a `raw_email`, que ya estaba en la lista blanca, y `nodo_trigger` se retira del código.
- [ ] **El disparo es en proceso, no encolado.** `architecture-patterns.md` §5 pide BullMQ para la
      ingesta Cron/IMAP. Bloquea el temporizador, nunca el hilo HTTP, y el despliegue todavía no tiene
      Redis. El salto consiste en sustituir el cuerpo de `dispatchFlow`, único punto que conoce el motor.
- [ ] **`host` sin lista blanca.** El patrón de `passwordEnvKey` acota qué secreto puede leerse, pero un
      EDITOR sigue pudiendo apuntar el nodo a un servidor IMAP arbitrario y ver ahí la contraseña del
      buzón corporativo. Restringir el dominio contra una lista en `.env`.
- [ ] **`@nestjs/schedule` es intra-proceso.** Con N réplicas del backend habría N sondeadores sobre el
      mismo buzón. Seguro con el despliegue monoinstancia actual; el día que se replique, el mutex
      `idx_flujo_activo` evita ejecuciones duplicadas pero no las conexiones IMAP redundantes.
- [ ] **Sin `PARSER_PRE_IA`.** Es el consumidor natural de este payload: `text` viaja sin sanear a
      propósito, y el escudo pre-IA es quien debe limpiarlo antes de gastar tokens.

---

## 2026-09-07 · Normalización a `raw_email`, retirada de `raw_html` y comprobación del asistente — rama `feat/trigger-imap`

Tres correcciones sobre el nodo de ingesta, más el endpoint que faltaba para que el asistente pueda
validar credenciales antes de guardar un flujo.

### 1. `raw_email` como namespace canónico

El default del DTO era `nodo_trigger`, un nombre que **no está en `ALLOWED_NAMESPACES`**: una plantilla
que interpolase `{{nodo_trigger.subject}}` habría sido rechazada por el gestor con un 400, aunque el
nodo hubiese escrito el dato correctamente en el contexto. Pasa a `raw_email`, que ya estaba reservado
en esa lista para el correo crudo desde PROT-11.1. Cero cambios en el gestor de plantillas.

`nodo_trigger` se retira del código por completo. Donde aparecía como **`nodeId`** —una clave de
topología, concepto distinto de un namespace— pasa a `trigger_imap`, que describe el tipo funcional del
nodo en lugar de su papel en el grafo. Que el mismo string sirviera para dos conceptos es precisamente
lo que hacía fácil confundirlos:

```
nodeId: 'trigger_imap'        ← clave del nodo en el grafo
outputNamespace: 'raw_email'  ← donde escribe en el StatePayloadContext
```

Se corrige también el ejemplo de Swagger de `PipelineNodeConfigDto.outputNamespace`, que enseñaba el
nombre equivocado y habría propagado el error a cada flujo creado desde la documentación.

### 2. `raw_html` fuera del payload

El nodo pasa de seis claves a cinco: `message_id`, `from`, `subject`, `text`, `date`. Desaparece
`raw_html` y con él la cascada `html → textAsHtml → text`.

El motivo es de reparto de responsabilidades: el HTML de un correo arrastra estilos en línea, imágenes
incrustadas como `data:` URI y etiquetas del cliente remitente, y **nadie aguas abajo lo necesita**.
`PARSER_PRE_IA` trabaja sobre texto plano justamente para no gastar tokens en marcado, y el HTML final
lo aporta la plantilla del gestor, no el correo de origen. Propagarlo solo engordaba el checkpoint
JSONB con datos que ningún nodo iba a consumir.

**Consecuencia que hay que conocer al configurar un flujo:** un correo que llegue únicamente en HTML,
sin parte `text/plain`, deja `text` vacío. Derivar texto del marcado sería sanitizar, y eso es
competencia del escudo pre-IA: `security-and-scope.md` §3 mantiene este nodo sin transformaciones. La
prueba 1.4 fija ese comportamiento para que nadie lo tome por un descuido.

### 3. `POST /api/wizard/check-imap`

Permite validar las credenciales antes de guardar el `pipeline_schema`, en lugar de descubrir el fallo
la primera vez que el sondeo dispare el flujo.

Comprueba **conexión y buzón** (`connect` + `status`), no solo el login: autenticar correctamente
contra un `mailbox` que no existe es un falso positivo que el operador debe ver en el asistente. Un
fallo devuelve 200 con `success: false` y severidad `GRAVE`, no un 4xx — el diagnóstico del servidor de
correo es parte de la respuesta que la interfaz tiene que mostrar, y un código de error obligaría al
cliente a distinguir "las credenciales son malas" de "la llamada al backend se rompió". La respuesta
**no** lleva `stackTrace`: revelaría rutas del servidor sin aportar nada a quien rellena un formulario.

Dos detalles que no son de gusto:

- **`ValidationPipe` local con `forbidNonWhitelisted`.** El pipe global de `main.ts` solo lleva
  `{ whitelist: true, transform: true }`, que *elimina en silencio* las propiedades desconocidas. Aquí
  hace falta que las **rechace**: un cliente que envíe `password` en el cuerpo debe recibir un 400, no
  un 200 tras haberse descartado el campo sin avisar. Es la misma opción que aplica la estrategia a los
  `params` del nodo, así que asistente y ejecución usan idéntico criterio.
- **El endpoint es un oráculo de conectividad.** Acepta `host` y `user` arbitrarios, así que sin el
  patrón `IMAP_*PASSWORD` de `passwordEnvKey` cualquiera con rol EDITOR podría pedir al backend que
  enviase `JWT_SECRET` a un servidor propio y confirmar el acierto leyendo el `success`. Las tres
  barreras —perímetro de red, JWT+RBAC y el patrón del DTO— son las que hacen publicable este endpoint.

### 4. `createImapClient`: una sola definición de las opciones endurecidas

Con el wizard, las rutas que hablan IMAP pasaban a ser tres, cada una repitiendo `logger: false`,
`emitLogs: false`, `disableAutoIdle`, los timeouts y el oyente de `error`. Son decisiones de seguridad
—sin `logger: false`, `imapflow` vuelca la conversación IMAP con las cabeceras de autenticación al
stdout del contenedor— y no pueden divergir entre consumidores. Se extraen a una función pura en
`services/imap-client.factory.ts`.

El oyente de `error` es un **parámetro obligatorio** de la firma, no opcional: `ImapFlow` es un
`EventEmitter` y un evento `error` sin oyente derriba el proceso de Node. Exigirlo en el tipo convierte
ese olvido en un error de compilación en lugar de una caída en producción.

Se mantiene como función y no como provider inyectable a propósito: así `WizardModule` la consume por
importación directa sin tener que importar `NodesModule`, que arrastraría el sondeo periódico, su
repositorio de `flujos` y `WorkflowsModule` detrás para no usar ninguno de los tres.

### Verificación

```
npm test          → 23 suites, 375 pruebas en verde (+15)
tsc --noEmit      → limpio sobre tsconfig.build.json
eslint            → limpio
```

Nuevas: 2 del namespace por defecto (incluida la que comprueba que el default está en
`ALLOWED_NAMESPACES`, para que ambos no puedan separarse sin que falle la suite) y 13 del
`WizardService`, con tres específicas de no filtración de secretos.

---

## 2026-09-07 · PROT-12.3 · Catálogo de pipelines para el asistente — rama `feat/trigger-imap`

Primera tanda del wizard: el backend que alimenta la Fase 0. El asistente necesita listar los flujos
que puede usar como plantilla, y no existía endpoint alguno — `WorkflowsController` solo tenía
`POST /:id/run-test`.

### Pasos 1-4 completados

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/pipeline-summary-response.dto.ts` | creado |
| `backend/src/modules/workflows/workflows.service.ts` | `findSelectablePipelines()` + `buildOrderedTopology()` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Get()` añadido |
| `backend/src/modules/workflows/workflows.service.spec.ts` | +9 pruebas (bloques 4, 5 y 6) |

Verificación: **384 pruebas en verde** (23 suites, +9), `tsc -p tsconfig.build.json` limpio, `eslint src`
sin errores (queda el warning preexistente de `bootstrap()` en `main.ts:78`).

### El «por qué» de tres decisiones

**1. `params` no viaja.** La proyección es deliberadamente parcial. En un nodo `TRIGGER_IMAP`, `params`
contiene `host`, `user` y `passwordEnvKey`; en un `DESTINO_HTTP`, la URL interna del CMS. Devolver el
esquema entero convertiría un endpoint de *listado* en una fuga de configuración de infraestructura
hacia el navegador, y el selector del asistente no necesita ninguno de esos datos para pintar una
tarjeta. La prueba 6.1 lo blinda serializando la respuesta y comprobando que no aparecen ni el host ni
la clave de entorno.

**2. El orden sale del grafo, no del mapa.** `schema.nodes` está indexado por `nodeId` y sus claves
conservan el orden de escritura del JSON, que no tiene por qué coincidir con el camino de ejecución.
`buildOrderedTopology` recorre desde `entrypoint` siguiendo `nextStep`. La prueba 5.1 usa un esquema
con las claves **en orden inverso** al de ejecución: si la proyección usara `Object.values`, devolvería
exactamente esa secuencia invertida y el stepper se pintaría al revés.

**3. El `Set` de visitados no es redundante.** `validatePipelineTopology` ya garantiza que el camino
activo es acíclico (garantía 5), así que sobre un esquema validado nunca hace falta. Cubre la fila
escrita por SQL directo, que se salta esa validación: sin él, un `nextStep` circular colgaría la
petición HTTP en un bucle infinito. Un puntero huérfano trunca el recorrido y registra un `warn` en
lugar de lanzar — es un esquema roto, pero el catálogo debe seguir respondiendo para que el operador
pueda verlo y corregirlo (pruebas 5.3 y 5.4).

Detalle de TypeScript que obligó a una anotación explícita: `cursor` se reasigna desde `node.nextStep`
y `node` se lee de `schema.nodes[cursor]`, así que sin anotar `node: PipelineNodeConfig | undefined` el
compilador entra en inferencia circular y falla con TS7022.

### Próximo paso exacto

**Paso 5:** extender `frontend/src/types/pipeline.ts` con `PipelineStep`, `PipelineSummary` y
`WizardStep` (este último enriquecido con `name`, derivado de `NODE_TYPE_LABELS[nodeType]`, que ya
existe en ese archivo). El enum `NodeType` y `OUTPUT_NAMESPACE_PATTERN` ya están ahí.

---

## 2026-09-07 · PROT-12.4 · Servicios, tipos y store del nodo `TRIGGER_IMAP` — rama `feat/trigger-imap`

Segunda tanda: la mitad no visual del paso 1 del asistente. Réplica de la tríada de §3.1 que el nodo
mapeador ya estableció, para un segundo tipo de nodo.

### Pasos 5-8 completados

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | +`PipelineStep`, `PipelineSummary`, `WizardStep`, `toWizardStep`, `CheckImapPayload`, `CheckImapResult` |
| `frontend/src/services/pipelines.service.ts` | creado |
| `frontend/src/services/nodes/trigger-imap.service.ts` | creado |
| `frontend/src/stores/nodes/trigger-imap.store.ts` | creado |
| `frontend/src/stores/nodes/trigger-imap.store.spec.ts` | creado (18 pruebas) |

Verificación: **72 pruebas en verde** (5 archivos, +18), `vue-tsc --noEmit` limpio, lint limpio.

### El «por qué» de tres decisiones

**1. Toda mutación pasa por `patchConfig`.** No es azúcar sintáctico: es lo que garantiza que no exista
ninguna vía de modificar la configuración sin invalidar `connectionVerified`. Si la vista escribiera en
`config` directamente, el store afirmaría que la conexión está probada para unos valores que ya no son
los del formulario. La prueba 4.2 recorre los seis campos de conexión uno a uno.

**2. `isConfigValid` exige conexión verificada, no solo campos válidos.** Unas credenciales con formato
correcto pero equivocadas no fallarían hasta que el sondeo disparase el flujo en producción, con el
flujo quedando PAUSADO y un `GRAVE` en la trazabilidad. Obligar a pulsar «Probar Conexión» traslada ese
descubrimiento al momento de configurar, que es el propósito del paso. La prueba 3.4 fija que campos
completos **sin probar** no bastan.

**3. `name` del paso no viaja por la red.** `NODE_TYPE_LABELS` ya vive en `types/pipeline.ts`, así que
mandar la etiqueta desde el backend duplicaría en dos idiomas la misma tabla de traducción, con el
riesgo de que divergieran. Lo deriva `toWizardStep`.

`PASSWORD_ENV_KEY_PATTERN` y `MIN_POLL_INTERVAL_MS` se replican del DTO backend. La copia no es
redundante: sin ellas el formulario dejaría enviar valores que el backend rechaza con un 400, y el
operador vería un error de servidor donde debería haber visto una regla de campo. La prueba 2.4 cubre
cinco claves de entorno ilegítimas, `JWT_SECRET` incluida.

Nota: `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno a esta
rama). Se revirtió para no mezclarlo; volverá a aparecer en cualquier `npm run lint` futuro.

### Próximo paso exacto

**Paso 9:** crear `frontend/src/components/nodes/TriggerImapConfig.vue` (prop única `nodeId`, cero
HTTP, maquetación calcada de `UserDialog.vue`: `.pd-label` + `.pd-required`, inputs `outlined dense`,
`passwordEnvKey` con `.pd-mono`, botón `.pd-btn-primary` con `icon-right="north_east"` y
`:loading="store.isLoading"`) y añadir su entrada a `node-config-registry.ts`.

---

## 2026-09-07 · PROT-12.4 · Componente del trigger, registro de stores y agregador — rama `feat/trigger-imap`

Tercera tanda: la UI del nodo y el agregador del asistente. Con esto el paso 1 del wizard está
completo salvo el anfitrión que lo monta.

### Pasos 9-12 completados

| Archivo | Estado |
|---|---|
| `frontend/src/components/nodes/TriggerImapConfig.vue` | creado |
| `frontend/src/components/nodes/node-config-registry.ts` | +entrada `TRIGGER_IMAP` |
| `frontend/src/components/nodes/node-store-registry.ts` | creado |
| `frontend/src/stores/flujo-draft.store.ts` | creado |
| `frontend/src/stores/flujo-draft.store.spec.ts` | creado (21 pruebas) |

Verificación: **93 pruebas en verde** (6 archivos, +21), `vue-tsc --noEmit` limpio, `eslint src` limpio.

### El «por qué» de tres decisiones

**1. `node-store-registry.ts` es hermano del de componentes, no un duplicado.** El registro de
componentes resuelve *qué* pintar; este resuelve *a quién preguntar* si lo pintado es válido. Hacían
falta los dos: el anfitrión monta el configurador por `nodeType`, pero también tiene que leer el
`isConfigValid` del nodo activo para habilitar el botón Siguiente, y sin este mapa tendría que importar
cada store por su nombre y encadenar condicionales por tipo — exactamente lo que §3.1 prohíbe. Cierra
el TODO que `NodeConfigSandboxPage.vue` dejaba escrito.

El contrato `NodeConfigStore` es deliberadamente estrecho (solo `isConfigValid`): tiparlo así impide que
el anfitrión acabe inspeccionando la `config` interna de un nodo concreto.

**2. El componente no escribe en `config` directamente.** Todos los `q-input` usan `:model-value` +
`@update:model-value` contra `store.patchConfig(...)` en lugar de `v-model`. Con `v-model` sobre
`store.config.host`, Pinia permitiría la mutación pero se saltaría la invalidación de
`connectionVerified`, y el paso quedaría declarándose válido con unas credenciales que ya no son las
probadas. Es el mismo motivo por el que el store canaliza todo por `patchConfig`.

**3. La guarda de avance vive en el store, no solo en el `:disable`.** `goToNextStep()` comprueba
`isActiveStepValid` antes de mover el cursor. El estado del borrador no debe depender de que la vista se
acuerde de deshabilitar un botón; la prueba 4.1 lo fija llamando a la acción directamente.

Un paso cuyo `nodeType` aún no tiene store registrado devuelve `isActiveStepValid: false` (prueba 3.3,
sobre `PARSER_PRE_IA`): sin configurador no hay forma de declararlo válido, y dejar avanzar sería
ensamblar un `pipeline_schema` con un nodo sin configurar.

`upstreamNamespaces(stepIndex)` es la fuente real de lo que `template-mapper.store.ts` tiene hoy como
lista fija marcada PROVISIONAL. Excluye el paso indicado a propósito: un nodo no puede leer su propia
salida (prueba 5.3).

### Próximo paso exacto

**Paso 13:** crear `frontend/src/components/wizard/PipelineSelector.vue` (tarjetas con `--pd-gradient`,
`.pd-h2`, `.pd-subtitle`) y `frontend/src/pages/WizardPage.vue` (Fase 0 vs Fase 1..N con
`<q-stepper vertical animated>` montando `<component :is="nodeConfigRegistry[step.nodeType]" :node-id="step.nodeId" />`,
sin `v-if` por tipo, botón Siguiente con `:disable="!draftStore.isActiveStepValid"`), y registrar la
ruta en `src/router/routes.ts` más el breadcrumb y el `<q-item>` del drawer en `MainLayout.vue`.

---

## 2026-09-08 · PROT-12.3/12.4 · Anfitrión del asistente y cierre de la tanda — rama `feat/trigger-imap`

Cuarta y última tanda: el anfitrión que monta los configuradores. Con esto el asistente recorre de
punta a punta la topología que dicta el pipeline elegido.

### Pasos 13-14 completados

| Archivo | Estado |
|---|---|
| `frontend/src/components/wizard/PipelineSelector.vue` | creado (Fase 0) |
| `frontend/src/pages/WizardPage.vue` | creado (Fase 1..N) |
| `frontend/src/router/routes.ts` | +ruta `flujos/nuevo` |
| `frontend/src/layouts/MainLayout.vue` | +breadcrumb y `<q-item>` del drawer |

Verificación final de ambos lados:

```
Backend   → 384 pruebas · tsc limpio · eslint 0 errores
Frontend  →  93 pruebas · vue-tsc limpio · eslint limpio · quasar build OK
```

El `quasar build` se ejecutó a propósito además del `typecheck`: `vue-tsc` no compila los templates de
los SFC con la misma profundidad que el build real, así que es lo único que garantiza que el `<q-stepper>`
dinámico y el `<component :is>` no tengan errores de plantilla.

### El «por qué» de dos decisiones

**1. Un solo punto de resolución, cero condicionales por tipo.** `resolveStepComponent(step)` es la
única vía por la que `WizardPage` decide qué montar, y no hay ni un `v-if="step.nodeType === ..."` en la
plantilla. Añadir un tipo de nodo es añadir una entrada a cada registro; el anfitrión no se toca. Es
literalmente lo que §3.1 pide y el motivo de que los registros existan.

**2. Un tipo sin configurador avisa, no rompe.** `nodeConfigRegistry` es `Partial` a propósito, así que
un paso `PARSER_PRE_IA` (hoy sin interfaz) renderiza un panel `.pd-card--accent .pd-accent-grave` con
`role="alert"` explicando qué falta, y el botón Siguiente queda deshabilitado porque
`isActiveStepValid` devuelve `false` para un tipo sin store registrado. La alternativa —dejar el paso en
blanco— habría parecido un fallo de carga.

El selector cubre también el catálogo vacío con un estado explícito: sin él, un backend sin flujos
configurados dejaría la vista en blanco y se leería como un error de red.

### Pendientes anotados

- **`upstreamNamespaces` aún no está conectado al mapeador.** El draft store ya lo expone, pero
  `template-mapper.store.ts` sigue usando su lista fija marcada PROVISIONAL. Enlazarlos es una llamada a
  `setAvailableUpstreamNamespaces(draftStore.upstreamNamespaces(index))` desde el anfitrión, y toca un
  componente de otra tanda; queda para la siguiente.
- **El asistente todavía no ensambla ni guarda el `pipeline_schema`.** Recorre y valida los pasos, pero
  falta el `POST` final que persista el flujo con la `config` de cada store de nodo. Es el cierre natural
  de PROT-12.
- **Solo dos de los siete nodos tienen configurador** (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`). Cuando
  estén los siete, el `Partial` de ambos registros debe caer para que el compilador exija exhaustividad.
- `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno). Se revierte
  en cada tanda para no mezclarlo.

---

## 2026-09-08 · PROT-12 · Persistencia del flujo (`POST /api/workflows`) — rama `feat/trigger-imap`

Primera mitad del cierre de PROT-12: el endpoint que faltaba para que el asistente pueda guardar lo
que ensambla.

### Pasos 1-5 completados

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/create-workflow.dto.ts` | creado |
| `backend/src/modules/workflows/workflows.service.ts` | `createWorkflow()` + `toPipelineSummary()` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Post()` añadido |
| `backend/src/modules/nodes/services/imap-polling.service.ts` | reconciliación periódica |
| `backend/src/modules/workflows/workflows.service.spec.ts` | +8 pruebas (bloques 7 y 8) |
| `backend/src/modules/nodes/services/imap-polling.service.spec.ts` | +6 pruebas (bloque 4) |

Verificación: **398 pruebas en verde** (23 suites, +14), `tsc` limpio, `eslint src` sin errores.

### Desviación justificada: cómo se registra el sondeo de un flujo nuevo

El enunciado pedía que `createWorkflow` registrase el intervalo invocando `ImapPollingService`. **No se
ha hecho así, y no por comodidad:** `NodesModule` ya importa `WorkflowsModule` (el sondeo necesita
`runAutomaticWorkflow` para despachar lo que detecta), así que inyectar `ImapPollingService` en
`WorkflowsService` crearía un ciclo `workflows ⇄ nodes`. Resolverlo exigiría `forwardRef` en ambos
módulos, o instalar `@nestjs/event-emitter`, que no está en el proyecto.

En su lugar se implementó **reconciliación periódica**: un intervalo `imap-reconcile` (60 s por
defecto, ajustable con `IMAP_RECONCILE_INTERVAL_MS`) que rearma la tabla de intervalos contra `flujos`.
Es estrictamente más robusto que una notificación puntual del alta, porque cubre tres casos que esa no
vería:

- el `pipeline_schema` de un flujo **editado** después de guardarse (host, buzón o periodo nuevos),
- un `activo` cambiado por SQL directo o desde otra vía,
- un flujo **borrado** o desactivado, que debe dejar de sondearse (prueba 4.4).

Coste: latencia de un ciclo hasta que el flujo nuevo entra en sondeo. Aceptable, sobre todo porque un
flujo **nace inactivo** y no sería elegible de todos modos hasta que alguien lo active.

El callback lleva `.catch()` explícito: corre dentro de un `setInterval` y una promesa rechazada sin
manejar termina el proceso en Node ≥ 18 (prueba 4.5).

### El «por qué» de tres decisiones más

**1. El flujo nace INACTIVO.** `flujos.activo` gobierna los disparadores automáticos, y la estrategia
IMAP marca los correos con `\Seen`. Un flujo que se activase solo al crearse empezaría a **consumir el
buzón corporativo** sin que nadie hubiera revisado su configuración, y esos correos no volverían a
verse. `active` es opcional en el DTO con default `false`; activarlo es un acto deliberado posterior.

**2. `pipelineSchema` se declara como objeto y NO con `@ValidateNested()`.** `validateSchema()` ya hace
las dos capas —forma y tipos con `PipelineSchemaDto`, integridad del grafo con
`validatePipelineTopology`— y devuelve `BadRequestException` con la lista exacta de campos inválidos.
Anidar el DTO duplicaría la primera capa y produciría **dos formatos de error distintos** para el mismo
fallo según cuál saltara antes: el del `ValidationPipe` global o el del validador. La prueba 7.1 fija
que la validación ocurre antes de tocar la base de datos, y la 7.2 que se persiste el esquema **ya
validado** y no el crudo del cuerpo (guardar el crudo dejaría en la BD propiedades que `whitelist`
descarta).

**3. `toPipelineSummary` se comparte entre el alta y el listado.** Si divergieran, el cliente tendría
que tratar el flujo que acaba de crear distinto de los que lee del catálogo. Como efecto secundario, el
alta hereda gratis la exclusión de `params` (prueba 8.2).

### Próximo paso exacto

**Paso 6:** crear `frontend/src/services/workflows.service.ts` con `createWorkflow(payload)` contra
`POST /workflows`, tipando el payload como `CreateWorkflowPayload` en `types/pipeline.ts`.

---

## 2026-09-08 · PROT-12 · Ensamblado del esquema y conexión de `upstreamNamespaces` — rama `feat/trigger-imap`

Segunda mitad del cierre: el agregador ya sabe recolectar la configuración de cada nodo y persistir el
flujo, y los nodos ya conocen su contrato aguas arriba de verdad.

### Pasos 6-9 completados

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | +`CreateWorkflowPayload`, `AssembledPipelineNode`, `AssembledPipelineSchema` |
| `frontend/src/services/workflows.service.ts` | creado |
| `frontend/src/components/nodes/node-store-registry.ts` | contrato ampliado |
| `frontend/src/stores/nodes/trigger-imap.store.ts` | +`toNodeParams()` |
| `frontend/src/stores/nodes/template-mapper.store.ts` | +`toNodeParams()` |
| `frontend/src/stores/flujo-draft.store.ts` | +`assembleAndSaveWorkflow`, `assemblePipelineSchema`, `syncUpstreamNamespaces`, `invalidSteps`, `canSave` |
| `frontend/src/stores/flujo-draft.store.spec.ts` | +15 pruebas (bloques 7, 8 y 9) |

Verificación: **108 pruebas en verde** (6 archivos, +15), `vue-tsc` limpio, `eslint` limpio.

### El «por qué» de cuatro decisiones

**1. `toNodeParams()` en lugar de leer `config`.** El agregador podría haber copiado `store.config` tal
cual, pero eso le obligaría a conocer la forma interna de cada nodo — lo que §3.1 prohíbe. Con este
método el nodo **decide qué publica**, y hay un caso donde `config` y `params` no coinciden: el mapeador
guarda `outputNamespace` en su config para la interfaz, pero en el esquema ese valor es propiedad del
**nodo**, no de sus `params`. Publicarlo en ambos sitios crearía dos fuentes de verdad dentro del mismo
JSON, y nada garantizaría que coincidieran (pruebas 8.1 y 8.2).

Beneficio colateral de tipado: una `interface` no es asignable a `Record<string, unknown>` en
TypeScript por no tener index signature implícita, así que exponer `config` directamente habría exigido
convertir las interfaces de configuración a type aliases o meter un cast.

**2. `setAvailableUpstreamNamespaces` es opcional en el contrato.** No todo nodo depende del contexto:
un disparador es el primero del grafo y no tiene nada aguas arriba que declarar. El anfitrión comprueba
su existencia con `?.()` antes de llamarlo (prueba 7.2).

**3. La sincronización ocurre al elegir el pipeline, no al llegar al paso.** `selectPipeline` llama a
`syncUpstreamNamespaces()` de inmediato: si se esperara a que el usuario llegase al paso del mapeador,
su primera validación se haría contra una lista vacía y avisaría de variables ausentes que sí existen.
Y se recalcula sobre **todos** los pasos al cambiar de pipeline, porque arrastrar la lista anterior le
haría creer a un nodo que `raw_email` existe en un flujo donde nadie lo produce (prueba 7.3).

Esto cierra el pendiente que arrastraba `template-mapper.store.ts`: su `DEFAULT_UPSTREAM_NAMESPACES`
estaba marcado PROVISIONAL y validaba contra namespaces inventados. Ahora un flujo que arranca en
`TRIGGER_IMAP` expone `raw_email` de verdad, y el mapeador puede afirmar que `{{raw_email.subject}}` es
resoluble y que `{{scraped_web.headline}}` no lo es en ese flujo concreto (prueba 7.1).

**4. `invalidSteps` pregunta a TODOS los pasos, no solo al activo.** El asistente permite retroceder,
así que sin esta comprobación se podría guardar un flujo tras haber vaciado un paso anterior ya
visitado. El error nombra los pasos que faltan en lugar de decir «hay errores» (pruebas 9.1 y 9.2).

`onErrorStep` queda en `null` en todos los nodos: el asistente aún no ofrece configurar caminos de
recuperación, y un puntero inventado sería peor que su ausencia — con `null`, el motor detiene la
ejecución en el nodo que falla, que es el comportamiento correcto por defecto (prueba 8.4).

### Próximo paso exacto

**Paso 10:** añadir el paso terminal de «Revisión y Guardado» a `frontend/src/pages/WizardPage.vue`:
campo `name` (requerido) y `description`, resumen de la topología configurada, botón «Crear Flujo»
(`.pd-btn-primary`, `icon-right="north_east"`, `:loading="draftStore.isLoading"`,
`:disable="!draftStore.canSave"`), `$q.notify` de éxito y redirección al catálogo.

---

## 2026-09-08 · PROT-12 · Paso terminal de revisión y cierre — rama `feat/trigger-imap`

Última tanda: el asistente ya guarda. Con esto los tres pendientes que arrastraba PROT-12 quedan
cerrados.

### Pasos 10-11 completados

| Archivo | Estado |
|---|---|
| `frontend/src/pages/WizardPage.vue` | +paso terminal de revisión y guardado |

Verificación final:

```
Backend   → 398 pruebas · tsc limpio · eslint 0 errores
Frontend  → 108 pruebas · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de tres decisiones

**1. El nombre se pide AL FINAL, no al principio.** Un asistente que abre pidiendo un nombre obliga a
bautizar algo que todavía no se ha configurado, y el operador acaba escribiendo un placeholder que
nunca corrige. Al pedirlo en la revisión, ya sabe qué hace el flujo que está nombrando.

**2. El paso de revisión NO es un nodo del grafo.** Su índice se deriva de `pipelineTopology.length`, y
por eso `goToNextStep()` no lo alcanza: esa acción está pensada para moverse entre nodos y su guarda
incluye `isLastStep`. El último nodo lleva un botón «Revisar y guardar» que salta al paso terminal con
`onGoToReview`, y el terminal usa `canSave` en lugar de `isActiveStepValid` porque no tiene store de
nodo que consultar. Derivar el índice en vez de fijar una constante mantiene el paso final realmente al
final por muchos nodos que traiga el pipeline.

**3. El aviso de «se creará inactivo» es explícito.** El flujo nace inactivo por decisión de seguridad
(la estrategia marca `\Seen` y consumiría el buzón), pero eso solo es una buena decisión si el operador
lo sabe **antes** de pulsar. Un flujo que se guarda y no se dispara nunca, sin explicación, se lee como
un fallo. El mensaje se repite en la notificación de éxito.

El borrador se limpia antes de navegar: si el operador vuelve al asistente, debe empezar de cero y no
sobre los restos del flujo anterior.

### Estado de los pendientes de PROT-12

- [x] ~~`upstreamNamespaces` sin conectar al mapeador.~~ Resuelto: `syncUpstreamNamespaces()` lo propaga
      al elegir el pipeline, y `template-mapper.store.ts` ya no valida contra su lista PROVISIONAL.
- [x] ~~El asistente no ensambla ni guarda el `pipeline_schema`.~~ Resuelto: `assembleAndSaveWorkflow`
      + `POST /api/workflows`.
- [ ] **Solo 2 de los 7 nodos tienen configurador** (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`). Un pipeline
      que incluya cualquiera de los otros cinco no se puede completar: el paso avisa y bloquea el
      avance. Cuando estén los siete, el `Partial` de ambos registros debe caer para que el compilador
      exija exhaustividad.
- [ ] **Sin endpoint para activar un flujo.** Nace inactivo por diseño, pero hoy la única vía de
      habilitarlo es SQL directo. Falta un `PATCH /api/workflows/:id` con la activación, que además es
      donde debería vivir la revalidación del esquema antes de exponerlo a los disparadores.
- [ ] **El disparo sigue siendo en proceso, no encolado** (`architecture-patterns.md` §5 pide BullMQ).
- [ ] **`host` sin lista blanca** en el nodo IMAP: el patrón de `passwordEnvKey` acota qué secreto se
      puede leer, pero un EDITOR sigue pudiendo apuntar el nodo a un servidor arbitrario.
- [ ] `npm run lint` reformatea `src/utils/violation-matcher.spec.ts` (prettier, archivo ajeno).

---

## 2026-09-08 · Correcciones arquitectónicas post-PROT-12 — rama `feat/trigger-imap`

### Paso 0 completado — inyección de `ConfigService` en el sondeo IMAP

| Archivo | Estado |
|---|---|
| `backend/src/modules/nodes/services/imap-polling.service.ts` | `import type` → import de valor |

```
Backend → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
```

**El «por qué».** `ImapPollingService` importaba `ConfigService` con `import type`. Con
`emitDecoratorMetadata` activo, un `import type` desaparece por completo en la transpilación y el
`design:paramtypes` que Nest lee para resolver el constructor queda en `Object`: **el módulo no
arrancaría en un despliegue real**, con un `Nest can't resolve dependencies`. Las 398 pruebas no lo
detectan porque instancian el servicio a mano pasándole un doble, que es precisamente el punto ciego de
la prueba unitaria frente a un fallo de contenedor.

Se auditaron los otros siete `import type { ConfigService }` del repositorio: todos están en archivos
`*.spec.ts`, donde el símbolo solo se usa como tipo del doble y el `import type` es correcto. Este era
el único archivo de producción con el patrón.

Se descartó añadir `ConfigModule` a los `imports` de `NodesModule`: `app.module.ts` ya lo declara con
`forRoot({ isGlobal: true })`, así que la entrada sería redundante y sugeriría falsamente que el módulo
necesita importarlo para que la inyección funcione — cuando el problema era exclusivamente el import.

**Próximo paso:** objetivo 1 — mover `frontend/src/components/nodes/node-store-registry.ts` a
`frontend/src/stores/nodes/node-store-registry.ts` y actualizar su único consumidor
(`flujo-draft.store.ts:4`).

### Pasos 1-2 completados — capa del registro de stores y depuración del `.env.example`

| Archivo | Estado |
|---|---|
| `frontend/src/components/nodes/node-store-registry.ts` | movido a `frontend/src/stores/nodes/` |
| `frontend/src/stores/flujo-draft.store.ts` | import actualizado a `@stores/nodes/node-store-registry` |
| `backend/.env.example` | sección 4 reducida a `IMAP_UNUWARE_PASSWORD` |

```
Frontend → 108 pruebas · 6 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

**1. El registro de stores no pertenecía a `components/`.** No importa ni resuelve un solo `.vue`
—solo stores— y su único consumidor es otro store, el agregador del borrador. §3.1 fija la ruta del
registro de COMPONENTES (`components/nodes/node-config-registry.ts`), que sí resuelve componentes y se
queda donde está; para su hermano de stores la capa la manda lo que resuelve, no con quién comparte
nombre. Un solo consumidor a actualizar y ninguna spec importaba la ruta antigua.

**2. Del entorno solo sale el secreto.** `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER` e `IMAP_SECURE` eran
residuo del modelo anterior a las credenciales híbridas: se comprobó que **ninguna línea de `src/` las
lee** (las únicas claves IMAP que el código resuelve son `IMAP_POLLING_ENABLED` e
`IMAP_RECONCILE_INTERVAL_MS`, de la sección 8). Mantenerlas en la plantilla enseñaba un modelo de
configuración que el código ya no implementa, y era una invitación a que alguien las rellenase esperando
que surtieran efecto. Host, puerto, usuario, buzón y periodo son configuración POR FLUJO y viven en el
`params` jsonb del nodo; dos flujos pueden vigilar dos buzones distintos en el mismo despliegue.

`IMAP_PASSWORD` se renombra a `IMAP_UNUWARE_PASSWORD` para que la plantilla muestre el patrón real
(`IMAP_*PASSWORD`) con un nombre de buzón concreto en vez de un genérico que se lee como «la» clave
IMAP del sistema. El bloque `SMTP_*` se conserva íntegro: lo consume `EmailService` para los OTP y sí es
configuración del servidor.

⚠️ **Acción manual pendiente del desarrollador:** renombrar `IMAP_PASSWORD` → `IMAP_UNUWARE_PASSWORD`
en el `backend/.env` real y usar ese nombre en el campo `passwordEnvKey` del asistente. Editar `.env`
exige reiniciar Nest.

Nota de formato: `npm run lint` (prettier) reflowó a 100 columnas seis archivos creados en la tanda
anterior de esta misma rama. Se conservan los reformateos —son los que el formateador del proyecto
impone— a diferencia de `src/utils/violation-matcher.spec.ts`, que es ajeno a la rama y se revierte en
cada ronda.

**Próximo paso:** objetivo 3a — envolver el setup de `trigger-imap.store.ts` y `template-mapper.store.ts`
en una factoría `defineStore(\`<id>:${nodeId}\`)` memoizada, y cambiar `NodeStoreHook` a
`(nodeId: string) => NodeConfigStore` con `resetConfig` obligatorio en el contrato.

### Pasos 3a-3d completados — aislamiento de la configuración por `nodeId`

| Archivo | Estado |
|---|---|
| `frontend/src/stores/nodes/trigger-imap.store.ts` | factoría `defineStore` por `nodeId` |
| `frontend/src/stores/nodes/template-mapper.store.ts` | factoría `defineStore` por `nodeId` |
| `frontend/src/stores/nodes/node-store-registry.ts` | `NodeStoreHook` recibe `nodeId`; `resetConfig` obligatorio |
| `frontend/src/stores/flujo-draft.store.ts` | `nodeId` propagado + `resetNodeStores()` |
| `frontend/src/components/nodes/TriggerImapConfig.vue` | store resuelto con `props.nodeId` |
| `frontend/src/components/nodes/TemplateMapperConfig.vue` | store resuelto con `props.nodeId` |
| `frontend/src/pages/nodes/NodeConfigSandboxPage.vue` | `SANDBOX_NODE_ID` compartido por componente y store |
| `frontend/src/stores/nodes/trigger-imap.store.spec.ts` | 15 llamadas con `NODE_ID` |
| `frontend/src/stores/nodes/template-mapper.store.spec.ts` | 3 llamadas con `NODE_ID` |
| `frontend/src/stores/flujo-draft.store.spec.ts` | topología con constantes + bloque 10 (5 pruebas) |

```
Backend   → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
Frontend  → 113 pruebas · 6 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de cuatro decisiones

**1. La premisa reportada no era el defecto.** Se pedía corregir una acción de guardado que sobrescribía
el diccionario `nodes` del pipeline. Esa acción no existe: `assemblePipelineSchema` construye un
diccionario **local y nuevo** en cada llamada, lo puebla por llave (`nodes[step.nodeId] = …`)
recorriendo la topología completa, y `nextStep` ya apuntaba al `nodeId` siguiente del arreglo —
invariante que la prueba **8.3** fijaba ya en verde. La solución prescrita *era* la implementación.

Lo que sí producía el síntoma («el nodo anterior desaparece») eran dos defectos adyacentes, y son los
que se corrigen. La prueba **10.3** queda como candado de la invariante que se creía rota: verifica que
los N nodos de la topología sobreviven al ensamblado y que la cadena está completa de punta a punta.

**2. La identidad del estado de un nodo es su `nodeId`, no su `nodeType`.** `resolveNodeStore` resolvía
un singleton de Pinia por tipo, así que un pipeline con dos disparadores IMAP contra buzones distintos
compartía **una sola instancia**: configurar el segundo borraba los `params` del primero, y el esquema
ensamblado salía con la misma configuración duplicada en ambos nodos. La topología canónica de Notiweb
no repite tipos, de modo que el defecto estaba latente esperando el primer flujo que lo hiciera.

Se eligió **instancia por nodo** (`defineStore(\`<prefijo>:${nodeId}\`)` con la definición memoizada)
frente a un `Record<nodeId, Config>` dentro de un store único. Con la instancia por nodo el cuerpo del
setup no cambia una línea y el contrato del anfitrión sigue siendo un `boolean` plano; con el
diccionario habría que rekeyar `isConfigValid`, `isLoading` y `connectionVerified`, y cada `computed`
pasaría a ser una función que devuelve un `computed` por nodo. El estado que se corrige no debía
complicar la lectura de lo que ya funcionaba.

Se memoiza la **definición** y no la instancia: de la instancia ya se encarga Pinia, que cachea por id.
Lo que hay que evitar es reconstruir la definición en cada render, que descarta la identidad
referencial del hook. Coste declarado: dos nodos mapeadores en el mismo flujo piden el catálogo de
plantillas una vez cada uno.

Contrapartida del HMR: con ids dinámicos no hay una definición única que declarar al cargar el módulo,
así que `acceptHMRUpdate` se arma sobre cada definición nueva. Vite conserva un solo callback
self-accept por módulo, de modo que hot-recarga el último nodo creado —en la práctica el que se está
configurando— y los demás exigen recarga completa.

**3. La instancia del store sobrevive a la topología que la creó.** Vive en la instancia de Pinia, no
en el borrador, así que `resetDraft()` vaciando `pipelineTopology` no limpiaba nada: crear un flujo y
volver al asistente arrancaba con los `params` del anterior ya cargados y `canSave` en `true` sin que
el operador hubiera tocado un campo — el escenario exacto en el que un guardado accidental publica la
configuración equivocada. `resetNodeStores()` recorre la topología **antes** de vaciarla (una vez vacía
ya no hay a quién preguntar) y se invoca también en `selectPipeline`, porque cambiar de pipeline
abandona una topología cuyos stores no deben sobrevivirle.

**4. `resetConfig` pasa a ser obligatorio en `NodeConfigStore`.** Es lo que necesita la limpieza
anterior, y exigirlo por tipo obliga a cualquier store de nodo futuro a implementarlo en vez de dejar
una fuga silenciosa. `setAvailableUpstreamNamespaces` sigue opcional: un disparador es el primero del
grafo y no tiene nada aguas arriba que declarar. Al cambiar la firma de `NodeStoreHook`, el compilador
enumeró los 20 puntos de llamada afectados — el tipo hizo de lista de tareas.

Nota de método: las cuatro pruebas de aislamiento (10.1, 10.2, 10.4 y 10.5) se comprobaron contra la
implementación anterior antes de dar el paso por cerrado. Las cuatro fallan sin su corrección; 10.3
pasa en ambas, que es precisamente su papel de candado.

**Próximo paso:** ninguno pendiente de esta tanda. Los pendientes abiertos del proyecto siguen siendo
los cinco listados al cierre de PROT-12, con el `PATCH /api/workflows/:id` de activación como el de
mayor prioridad: la vía de creación termina hoy en un flujo que nadie puede habilitar desde la interfaz.

---

## 2026-09-08 · Estandarización de `refresh_tokens` → `tokens_sesion` — rama `feat/trigger-imap`

| Archivo | Estado |
|---|---|
| `init.sql` | tabla, PK e índice renombrados + nota sobre las constraints |
| `db/migrations/009-tokens-sesion.sql` | creado |
| `db/migrations/001-refresh-tokens.sql` | nota de obsolescencia (solo cabecera) |
| `db/migrations/004-device-id-refresh-tokens.sql` | nota de obsolescencia (solo cabecera) |
| `backend/src/modules/auth/entities/refresh-token.entity.ts` | `@Entity`, PK e `@Index` |
| `backend/src/modules/auth/services/refresh-token.service.ts` | comentario |
| `backend/src/modules/auth/interfaces/jwt-payload.interface.ts` | TSDoc |
| `PLAN.md` | §2.6, línea 145 y §14 |

```
Backend → 398 pruebas · 23 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. El renombrado toca seis objetos, no dos.** `ALTER TABLE … RENAME TO` en PostgreSQL **no arrastra
los índices ni las constraints**: se quedan con el nombre autogenerado a partir del nombre viejo de la
tabla. Como `init.sql` no las declara explícitamente, PostgreSQL las deriva allí del nombre nuevo, de
modo que un clonado nuevo obtiene `tokens_sesion_pkey`, `tokens_sesion_hash_token_key` y
`tokens_sesion_id_usuario_fkey` mientras una base migrada conservaría los tres `refresh_tokens_*`.
Renombrar solo tabla y columna habría dejado las dos rutas de creación divergentes — exactamente la
deriva que este repositorio evita manteniendo el DDL duplicado a propósito en `init.sql` y en
`db/migrations/`. La 009 renombra tabla, columna PK, índice y las tres constraints.

El nombre del índice además importa desde el código: la entidad lo declara con
`@Index('idx_tokens_sesion_id_usuario')`.

**2. El código se queda en inglés, y no es un renombrado a medias.** Las columnas de esta tabla ya
seguían la convención castellana (`id_usuario`, `expiracion`, `revocado`, `fecha_creacion`); lo que
quedaba fuera era el nombre de la tabla y de su PK, la última excepción del esquema. La clase
`RefreshToken` **ya cumplía** `code-conventions.md` §1, igual que `User`/`usuarios` y `Workflow`/`flujos`:
esquema en castellano, identificadores de código en inglés, puente en `@Entity()` / `@Column({ name })`.
Renombrar la clase, los archivos o el `RefreshTokenService` habría roto la norma en vez de aplicarla, y
habría dejado esta entidad como la única asimétrica de las nueve.

Por el mismo motivo no se toca el contrato HTTP (`POST /auth/refresh`, `POST /auth/logout`, campo
`refreshToken`): además de ser identificadores de código, cambiarlos invalidaría las sesiones ya
guardadas en `localStorage` y obligaría a un cambio coordinado en cinco archivos del frontend para una
ganancia nula. **Cero cambios en el frontend.** Queda anotado en el TSDoc de la entidad para que el
próximo lector no interprete la asimetría como un descuido.

**3. No se generó una migración de TypeORM porque el proyecto no tiene ese mecanismo.** No hay
directorio `migrations/`, ni `DataSource` de CLI, ni scripts `migration:*`, y `app.module.ts` fija
`synchronize: false` — que debe seguir así. El patrón vigente son archivos `.sql` idempotentes en
`db/migrations/` que aplica el desarrollador, y la 009 lo sigue. Montar el CLI habría dejado una tabla
`migrations` que no conoce ninguna de las ocho migraciones ya aplicadas: un registro de estado que
miente desde el primer día.

Idempotencia: `ALTER TABLE IF EXISTS … RENAME TO` y `ALTER INDEX IF EXISTS` lo son por sí mismos, pero
`RENAME COLUMN` y `RENAME CONSTRAINT` **no admiten `IF EXISTS`** para su objeto y abortarían al
reejecutarse. Por eso esos cuatro van dentro de un bloque `DO $$ … END $$;` con guardas contra
`information_schema` y `pg_constraint`.

**4. Las migraciones 001 y 004 se conservan intactas, solo con una nota.** Son un registro histórico
ordenado y reescribirlas falsearía lo que se ejecutó; sobre una base antigua el orden correcto sigue
siendo 001 → 004 → 009. La nota es necesaria porque la 001 es `CREATE TABLE IF NOT EXISTS
refresh_tokens`: replayarla sobre una base posterior a la 009 no ve `tokens_sesion` y crearía **en
silencio** una segunda tabla vacía con el nombre viejo.

### Lo que las pruebas NO demuestran

Las 398 pruebas pasan, pero **habrían pasado igual con el nombre de tabla equivocado**: las specs de
autenticación mockean el repositorio de TypeORM, así que ejercitan la lógica y no el mapeo
objeto-relacional. Ninguna referencia nombres de tabla, columna o índice (verificado por grep), y por eso
no hubo ni una spec que adaptar. La única verificación real del renombrado es aplicar la 009 y ejecutar
un login.

Nada se ha ejecutado contra PostgreSQL: la infraestructura de base de datos la administra el
desarrollador, y el servidor MCP `postgres-protodo` estaba caído en esta sesión (`CONNECTION_CLOSED`).

### Pendiente inmediato

- [ ] **Aplicar `db/migrations/009-tokens-sesion.sql`.** El repositorio queda en un estado que lo
      **exige antes de volver a arrancar el backend**: la entidad ya apunta a `tokens_sesion`, así que
      hasta aplicarla cualquier login o renovación falla con
      `relation "tokens_sesion" does not exist`. Mismo aviso que llevaba la 004 en su día.

      ```bash
      sudo docker exec -i protodo_postgres psql -U unuware007 -d 'DB_PRO-TODO' \
        < db/migrations/009-tokens-sesion.sql
      ```

      Los dos `SELECT` finales deben mostrar `id_token_sesion` en primera posición y los cinco
      índices/constraints con prefijo `tokens_sesion` / `idx_tokens_sesion`. Reejecutarla una segunda
      vez debe terminar sin error.

---

## 2026-09-08 · Plantillas de flujo: separación blueprint / instancia — rama `feat/trigger-imap`

### Paso 1 completado — esquema, entidades y helper de topología

| Archivo | Estado |
|---|---|
| `db/migrations/010-plantillas-flujo.sql` | creado |
| `init.sql` | tabla `plantillas_flujo` + `flujos.id_plantilla_origen` + índice |
| `backend/src/modules/workflow-templates/entities/workflow-template.entity.ts` | creado |
| `backend/src/modules/workflows/entities/workflow.entity.ts` | `templateId` + `@ManyToOne` |
| `backend/src/core/fsm/utils/pipeline-topology.util.ts` | creado (extraído del servicio) |
| `backend/src/core/fsm/utils/pipeline-topology.util.spec.ts` | creado, 7 pruebas |
| `backend/src/modules/workflows/workflows.service.ts` | consume el helper |

```
Backend → 405 pruebas (antes 398) · 24 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. Blueprint e instancia eran la misma fila.** La Fase 0 del asistente listaba flujos ya instanciados
con esquema (`findSelectablePipelines()`) y clonaba su topología. Consecuencias: editar el flujo del que
otros partieron cambiaba la plantilla de facto, y no había manera de tener un maestro que no se pudiera
disparar. `plantillas_flujo` es el catálogo de topologías base y no se ejecuta nunca: no tiene autor,
ni estado, ni ejecuciones.

**2. `flujos.id_plantilla_origen` es trazabilidad, no dependencia.** El flujo conserva su propia copia
del grafo en `configuracion_pipeline`, así que editar la plantilla después **no** altera los flujos que
ya salieron de ella. Esa independencia es el sentido de separar las dos cosas: si el flujo leyese el
grafo del maestro, retocar un blueprint cambiaría el comportamiento de flujos en producción.

Nullable por dos motivos distintos: los flujos anteriores a la 010 no vienen de ningún maestro, y el
asistente debe poder crear uno desde cero. Un `NOT NULL` habría obligado a inventar una plantilla para
las filas históricas. Sin lado inverso `@OneToMany`: nadie navega plantilla → flujos y declararlo
cerraría un ciclo de imports entre las dos entidades.

**3. La columna JSONB se llama `configuracion_pipeline`, no `pipeline_schema`.** Es una desviación
deliberada del enunciado: sería la única columna con nombre inglés del esquema, y compartir el nombre
con `flujos` es lo que hace legible el clonado. Aquí sí es `NOT NULL`, a diferencia de `flujos`: un
flujo sin esquema es un borrador legítimo del asistente, pero una plantilla sin topología no es una
plantilla. También `nombre VARCHAR(100)` y no 120 como `plantillas_html`: el nombre del blueprint se
propone como nombre del flujo, y `flujos.nombre` es `VARCHAR(100)` — con 120 un nombre válido de
plantilla no cabría en su instancia.

**4. `buildOrderedTopology` sale del servicio.** Era un método `private` de `WorkflowsService`, y las
plantillas necesitan exactamente el mismo recorrido `entrypoint → nextStep` para exponer su topología al
selector. Duplicarlo dejaría dos lecturas del mismo grafo divergiendo en silencio. Vive ahora en
`@core/fsm/utils/` como función pura con un callback `onTruncated` opcional: el aviso del puntero
huérfano queda en manos del llamante, que es quien sabe si el esquema roto es de un flujo o de una
plantilla. Su tipo de retorno se declara en el propio util y no se importa de `@modules/workflows`,
porque `@core` no puede depender de un módulo funcional sin invertir las capas.

Las 7 pruebas nuevas cubren lo que antes solo se probaba de forma indirecta: el orden real frente al de
las claves del mapa (el fixture declara los nodos en orden inverso al de ejecución), el corte
anticiclos, el truncado ante un puntero huérfano y el callback de aviso.

**Próximo paso:** paso 2 — `backend/src/modules/workflow-templates/` con sus DTOs, servicio (con
`PipelineValidatorService` y `assertNameAvailable`), controlador (`@Roles(ADMIN)` en las escrituras vía
`getAllAndOverride`), módulo, registro en `AppModule` y `workflow-templates.service.spec.ts`.

### Paso 2 completado — módulo `WorkflowTemplates`

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflow-templates/dto/create-workflow-template.dto.ts` | creado |
| `backend/src/modules/workflow-templates/dto/update-workflow-template.dto.ts` | creado |
| `backend/src/modules/workflow-templates/dto/workflow-template-response.dto.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.service.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.controller.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.module.ts` | creado |
| `backend/src/modules/workflow-templates/workflow-templates.service.spec.ts` | creado, 24 pruebas |
| `backend/src/app.module.ts` | registra `WorkflowTemplatesModule` |
| `backend/src/modules/workflows/workflows.service.spec.ts` | fixture con `templateId`/`template` en null |

```
Backend → 429 pruebas (antes 405) · 25 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. Lectura para EDITOR, escritura solo para ADMIN.** Es la diferencia con `TemplatesController`, que
admite ambos roles en todo. El selector de la Fase 0 del asistente lo usa un EDITOR, así que el `GET`
tiene que estar abierto; pero redefinir el maestro del que parten todos los flujos es más poderoso que
editar un flujo suelto —cambiar la topología base decide qué nodos existen en cada flujo que alguien
cree después. Los `@Roles(UserRole.ADMIN)` de método ganan al de clase porque `RolesGuard` resuelve con
`getAllAndOverride`; los guards siguen declarados a nivel de clase para que un endpoint futuro no nazca
desprotegido.

**2. Dos DTO de respuesta, no uno.** El listado (`WorkflowTemplateResponseDto`) proyecta la topología y
**omite** `pipelineSchema`, por el mismo criterio que `PipelineSummaryResponseDto`: los `params` de un
TRIGGER_IMAP llevan `host`, `user` y `passwordEnvKey`. Devolverlos en el listado expondría la
configuración de cada nodo de cada plantilla en la petición que el asistente hace en cada arranque. El
detalle (`WorkflowTemplateDetailResponseDto`) sí lo incluye, porque es el objeto que el editor
administrativo edita. La prueba 1.4 fija esa frontera serializando la respuesta y buscando
`passwordEnvKey`.

Reutiliza `PipelineStepDto` de `@modules/workflows` en lugar de declarar su propio paso: es la misma
proyección, y así el frontend usa un único tipo para pintar el stepper venga de una plantilla o de un
flujo.

**3. La validación del grafo es la razón de ser del servicio, no el CRUD.** Una plantilla es el punto de
partida de N flujos, así que un `nextStep` roto aquí se propaga a cada instancia que alguien cree. Se
reutiliza `PipelineValidatorService` —el mismo que valida el esquema de un flujo— para que ambos caminos
exijan exactamente lo mismo; replicarlo abriría la puerta a una plantilla que el catálogo acepta y el
motor rechaza. En `update` se revalida siempre que el grafo viaje.

El nombre se comprueba **antes** del grafo (prueba 3.4 verifica que `validateSchema` no llega a
llamarse): es la validación más barata y la que el usuario corrige más a menudo.

**4. `assertInstantiable` y no un simple `findOne`.** Lo consume `WorkflowsService` en el paso 3 para
comprobar el `templateId` recibido. Una plantilla retirada devuelve 400: permitir instanciarla vaciaría
de sentido el borrado lógico, que existe justo para que deje de usarse. Y el borrado es lógico porque
los flujos instanciados apuntan a la fila con `id_plantilla_origen`.

Nota de método: `update` comprueba `!== undefined` en cada campo y no la veracidad del valor. Es lo que
permite que `{ active: false }` inactive de verdad y que una descripción vacía se guarde vacía; con un
`if (updateDto.active)` ambos casos se ignorarían en silencio. La prueba 4.4 lo fija.

Hallazgo colateral: `npx tsc -p tsconfig.json` (el que incluye las specs) arrastra **26 errores
preexistentes** en `imap-polling.service.spec.ts` y `allowed-ips.service.spec.ts` —varianza de las
firmas de los mocks de TypeORM y un `delete` sobre propiedad `readonly`—, ajenos a esta entrega. La
puerta del proyecto es `tsconfig.build.json`, que excluye specs, y `ts-jest` transpila sin comprobar
tipos (`isolatedModules`). De los 4 errores que aparecían en `workflows.service.spec.ts`, **1 lo
introdujo esta entrega** (el fixture `buildWorkflow` dejó de satisfacer `Workflow` al ganar dos
columnas) y quedó corregido; los otros 3 son de la misma familia preexistente.

**Próximo paso:** paso 3 — `templateId` en `CreateWorkflowDto`, `WorkflowsService.createWorkflow`
validando con `assertInstantiable`, `updateWorkflow` + `UpdateWorkflowDto`, `PATCH /api/workflows/:id`
con la revalidación al activar, y ampliación de `workflows.service.spec.ts`.

### Paso 3 completado — instanciación desde plantilla y habilitación de flujos

| Archivo | Estado |
|---|---|
| `backend/src/modules/workflows/dto/create-workflow.dto.ts` | `templateId?` (`@IsUUID`) |
| `backend/src/modules/workflows/dto/update-workflow.dto.ts` | creado |
| `backend/src/modules/workflows/dto/pipeline-summary-response.dto.ts` | expone `templateId` |
| `backend/src/modules/workflows/workflows.service.ts` | `templateId` en el alta + `updateWorkflow` + `assertActivatable` |
| `backend/src/modules/workflows/workflows.controller.ts` | `@Patch(':id')` |
| `backend/src/modules/workflows/workflows.module.ts` | importa `WorkflowTemplatesModule` |
| `backend/src/modules/workflows/workflows.service.spec.ts` | bloques 9-11, 14 pruebas nuevas |

```
Backend → 443 pruebas (antes 429) · 25 suites · tsc limpio · eslint 0 errores
```

### El «por qué» de cuatro decisiones

**1. El grafo se COPIA en el flujo, no se referencia.** `flujos.configuracion_pipeline` sigue llevando
su propio esquema, e `id_plantilla_origen` es solo trazabilidad de la procedencia. Si el flujo leyese el
grafo del maestro, retocar un blueprint cambiaría el comportamiento de flujos ya en producción — un
cambio a distancia y sin aviso. La independencia es el sentido de separar blueprint e instancia, y la
prueba 9.1 fija que se persiste el vínculo sin que el esquema deje de ser propio.

**2. `UpdateWorkflowDto` no es un `PartialType(CreateWorkflowDto)`.** Ese DTO incluye `templateId`, y el
maestro del que nació un flujo es un hecho histórico: dejar reescribirlo permitiría falsear la
procedencia después de crearlo, que es justo lo que la columna existe para registrar. Se declara a mano
con los cuatro campos editables.

**3. Activar y desactivar no son simétricos.** `assertActivatable` solo se invoca al poner `active:
true`, y hace dos cosas: rechaza un flujo sin `pipeline_schema` (un borrador legítimo del asistente,
pero activarlo dejaría al sondeo disparando ejecuciones que fallan en el primer paso) y **revalida** el
esquema existente, porque la fila pudo escribirse por SQL directo o quedar obsoleta si el contrato del
grafo cambió. Habilitar un flujo lo expone al sondeo IMAP, que lo recoge en su reconciliación de 60 s
sin volver a preguntar nada: este es el último punto de control.

Desactivar, en cambio, no valida nada (pruebas 11.4 y 11.5). Retirar un flujo de los disparadores es la
vía de emergencia para pararlo, y hacerla fallar por un esquema roto sería exactamente lo contrario de
lo que hace falta en ese momento.

**4. Sin `@Delete` en el controlador.** Retirar un flujo es `PATCH { "active": false }`. Un borrado
físico dejaría las ejecuciones ya trazadas apuntando a un flujo inexistente, y la trazabilidad es el
motivo de que `ejecuciones_flujo` exista.

Con esto queda cerrado el pendiente que arrastraba PROT-12: **ya hay endpoint para activar un flujo**.
Nacía inactivo por diseño y hasta ahora la única vía de habilitarlo era SQL directo.

La comprobación de la plantilla va **antes** de validar el grafo (prueba 9.3 verifica que
`validateSchema` no llega a llamarse): es una consulta barata y un `templateId` equivocado invalida la
petición entera. `assertInstantiable` rechaza además las plantillas retiradas, porque permitir
instanciarlas vaciaría de sentido el borrado lógico.

**Próximo paso:** paso 4 — frontend completo: tipos, `workflow-templates.service.ts`, absorber
`pipelines.service.ts` en `workflows.service.ts`, tres stores (`workflow-templates`, `workflows` y el
refactor de `flujo-draft` con clonado inmutable), las vistas `/flujos` y `/plantillas-flujo`, router,
`MainLayout` y las pruebas de Vitest.

### Paso 4 completado — frontend: catálogo de flujos, CRUD de plantillas y asistente repuntado

| Archivo | Estado |
|---|---|
| `frontend/src/types/pipeline.ts` | `WorkflowTemplateSummary`/`Detail`, payloads y `templateId` |
| `frontend/src/services/workflow-templates.service.ts` | creado |
| `frontend/src/services/workflows.service.ts` | absorbe `fetchWorkflows` + `updateWorkflow` |
| `frontend/src/services/pipelines.service.ts` | **eliminado** |
| `frontend/src/stores/workflow-templates.store.ts` | creado |
| `frontend/src/stores/workflows.store.ts` | creado |
| `frontend/src/stores/flujo-draft.store.ts` | parte de plantillas, con clonado inmutable |
| `frontend/src/components/workflows/WorkflowsManager.vue` · `WorkflowDialog.vue` | creados |
| `frontend/src/components/workflow-templates/WorkflowTemplatesManager.vue` · `WorkflowTemplateDialog.vue` | creados |
| `frontend/src/pages/workflows/WorkflowsPage.vue` · `workflow-templates/WorkflowTemplatesPage.vue` | creados |
| `frontend/src/components/wizard/PipelineSelector.vue` | recibe `templates`, estado vacío con salida |
| `frontend/src/pages/WizardPage.vue` | Fase 0 desde plantillas; tras guardar va a `/flujos` |
| `frontend/src/router/routes.ts` · `layouts/MainLayout.vue` | dos rutas, drawer y migas |
| `frontend/src/stores/flujo-draft.store.spec.ts` | adaptada + bloques 11-12 |
| `frontend/src/stores/workflow-templates.store.spec.ts` · `workflows.store.spec.ts` | creadas |

```
Backend   → 443 pruebas · 25 suites · tsc limpio · eslint 0 errores
Frontend  → 149 pruebas (antes 113) · 8 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de cinco decisiones

**1. `pipelines.service.ts` se elimina, no se deja como alias.** Apuntaba a la MISMA ruta `/workflows`
que `workflows.service.ts`. `frontend-architecture.md` §1 fija un servicio por dominio, y tener dos fue
literalmente la grieta por la que el asistente acabó leyendo flujos instanciados donde debía leer
plantillas maestras: el nombre `fetchSelectablePipelines` sonaba a catálogo de blueprints y devolvía
instancias. Conservar el archivo habría dejado el mismo malentendido a mano del siguiente.

**2. El clonado inmutable se hace campo a campo, no con `structuredClone`.** Fue el intento inicial y
**falla en ejecución**: los elementos de `availableTemplates` vienen envueltos en el Proxy reactivo de
Vue, y `structuredClone` lanza `DataCloneError` sobre un Proxy. Lo detectaron las 37 pruebas del
borrador al ponerse rojas de golpe. La copia explícita (`{ nodeId, nodeType, outputNamespace }`) es
además mejor que el clon genérico: el literal obliga al compilador a exigir aquí cualquier campo que
`PipelineStep` gane en el futuro, en vez de copiarlo por referencia sin avisar.

Las pruebas 11.1-11.3 fijan las tres consecuencias: objetos distintos con los mismos valores, mutar el
borrador no toca el catálogo, y reelegir la misma plantilla arranca de ella intacta y no del recorte
anterior.

**3. La prueba 9.5 cambia de sentido, no se borra.** Antes verificaba que el flujo creado se añadía al
catálogo del asistente. Ahora verifica lo contrario: que **no** se añade, porque ese catálogo son
plantillas y colar ahí una instancia la ofrecería como blueprint — exactamente el error que esta entrega
corrige. El flujo se devuelve al llamante, que navega a `/flujos`.

**4. `/plantillas-flujo` no lleva `requiresAdmin`, aunque las escrituras del backend sí sean de ADMIN.**
Un EDITOR necesita consultar el catálogo para saber de qué puede partir; el 403 en el alta y la edición
lo impone el servidor, que es la autoridad. Bloquear la ruta entera le ocultaría información que sí
puede ver, y duplicaría en el router una regla que ya vive en el controlador.

**5. Activar va por interruptor; desactivar pasa por el temporizador de 5 s.** Habilitar un flujo no
destruye nada y el backend ya lo rechaza si el esquema no es íntegro, así que el `QToggle` basta.
Desactivar corta la ingesta de un flujo en marcha, y eso es una acción crítica: `SafeDeleteModal` con su
cuenta atrás (`frontend-quasar.md` §4). El store escribe siempre la **respuesta del servidor** y no un
parche optimista: activar puede fallar con un 400, y pintar el interruptor en verde antes de saberlo
mentiría sobre el estado real del flujo (prueba 3.3 de `workflows.store.spec.ts`).

El editor de plantillas valida el JSON en el cliente solo en cuanto a FORMA (que parsee y sea un
objeto). La coherencia del grafo la decide `PipelineValidatorService`, que es la única autoridad sobre la
topología; comprobar la sintaxis aquí solo evita gastar una petición en un 400 seguro.

### Pendientes

- [ ] **Aplicar `db/migrations/009-tokens-sesion.sql` y `010-plantillas-flujo.sql`.** Las ejecuta el
      usuario. Hasta la 009 el login falla; hasta la 010 falla cualquier consulta de flujos o
      plantillas. Nada se ha ejecutado contra PostgreSQL.
- [ ] **Sembrar la primera plantilla de flujo.** Hasta que exista una, el asistente muestra su estado
      vacío con el enlace a `/plantillas-flujo`. La topología de Notiweb de 7 nodos está en
      `pipeline-validator.service.spec.ts:15`.
- [ ] Solo 2 de los 7 tipos de nodo tienen configurador (`TRIGGER_IMAP`, `MAPEADOR_PLANTILLA`), así que
      una plantilla que incluya cualquiera de los otros cinco no se puede completar en el asistente.
- [ ] El disparo sigue siendo en proceso, no encolado (`architecture-patterns.md` §5 pide BullMQ).
- [ ] `host` sin lista blanca en el nodo IMAP.
- [ ] 26 errores de tipo preexistentes en dos specs bajo `tsconfig.json` (varianza de mocks de TypeORM);
      la puerta del proyecto es `tsconfig.build.json`, que excluye specs.

---

## 2026-09-08 · Poka-Yoke de la conmutación de estado en los catálogos (CU-10) — rama `feat/trigger-imap`

| Archivo | Estado |
|---|---|
| `frontend/src/components/workflows/WorkflowsManager.vue` | badge informativo + botonera excluyente |
| `frontend/src/components/workflow-templates/WorkflowTemplatesManager.vue` | idem |
| `frontend/src/components/workflow-templates/WorkflowTemplateDialog.vue` | `q-toggle` retirado |
| `frontend/src/css/app.scss` | `.pd-badge--inactive` sobre `--pd-surface-muted` |
| `frontend/src/stores/workflow-templates.store.spec.ts` | pruebas 3.7 y 3.8 |

```
Frontend → 151 pruebas (antes 149) · 8 archivos · vue-tsc limpio · eslint limpio · quasar build OK
```

### El «por qué» de cuatro decisiones

**1. El `q-toggle` no era solo redundante: era un agujero en CU-10.** Convivía con el botón «block» de
la botonera, así que había dos controles para la misma mutación —pero solo uno de ellos pasaba por
`SafeDeleteModal`. El interruptor desactivaba un flujo en marcha con un clic, sin cuenta atrás y sin
posibilidad de arrepentirse. La regla §4 exige el temporizador para «toda petición de borrado o
desactivación», y el camino corto la incumplía. Ahora la columna de estado solo **informa** y toda la
conmutación vive en la botonera, en un control por fila y excluyente: o se ofrece activar, o retirar.

**2. `applyActiveState` es privado a las dos acciones.** Ningún control de la tabla lo invoca
directamente: activar entra por `onActivate` y desactivar SOLO por `confirmDeactivation`. Eso convierte
la regla en una invariante del componente y no en una convención que el siguiente `q-toggle` pueda
saltarse por descuido — que es exactamente lo que acababa de pasar.

**3. Asimetría deliberada entre activar y desactivar.** Activar no destruye nada, es reversible en un
clic y su único riesgo real —un grafo roto expuesto a los disparadores— lo cubre el backend, que
revalida el esquema antes de habilitar. Interponer un diálogo ahí solo añadiría friccion a la acción
que el operador ejecuta a diario. Desactivar, en cambio, corta la ingesta: un correo que llegue mientras
el flujo está retirado no se recupera, queda en el buzón sin procesar hasta que alguien lo note. De ahí
que el botón lleve `.pd-btn-danger` y el tooltip diga explícitamente «Requiere confirmacion de 5
segundos»: la friccion se anuncia antes de pulsar, no se descubre después.

**4. El editor de plantillas también perdió su interruptor.** Era una **tercera** vía de conmutar
`active`, y la más silenciosa: guardar el formulario con el toggle apagado retiraba la plantilla sin
confirmación de ningún tipo. Se sustituye por un badge de solo lectura que remite al catálogo. El
borrador conserva el estado que traía (`initDraft` lo toma de la plantilla), así que guardar no lo
altera nunca; las plantillas nuevas nacen activas, con el mismo criterio que el backend, y publicar una
plantilla es inocuo porque no dispara nada por sí misma.

### Lo que las pruebas cubren y lo que no

Vitest corre con `environment: 'node'` y sin `@vue/test-utils`, así que **la asimetría de la botonera no
es testeable**: es lógica de plantilla y exigiría montar el componente en un DOM. Lo que sí se fija son
las dos premisas de store sobre las que descansa el rediseño: la 3.7 verifica que `saveDraft` conserva
el `active` existente al editar —el contrato que permite quitar el toggle del diálogo sin que guardar
cambie el estado— y la 3.8 que un alta nace publicada. La sincronización reactiva tras la confirmación
ya estaba cubierta (4.1 y 4.3 en plantillas, 3.2 y 3.3 en flujos): el store escribe la respuesta del
backend y no un parche optimista, de modo que el badge se repinta con lo que de verdad quedó guardado y
un 400 deja la fila intacta.

### Efecto colateral declarado

`.pd-badge--inactive` es una clase compartida, así que el cambio a `--pd-surface-muted` también afecta a
los badges «Inactiva» de `/templates` y `/users`. Se ha hecho a propósito en lugar de crear un modificador
nuevo: es un solo estado semántico, y que «Inactivo» se viera de dos formas distintas según la vista
sería el defecto real. Los tokens de deshabilitado que usaba antes sugerían un control bloqueado, lectura
que dejó de tener sentido en cuanto el estado pasó de control a indicador.
