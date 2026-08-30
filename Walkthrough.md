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
