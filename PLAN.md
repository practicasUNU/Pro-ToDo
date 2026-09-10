# PLAN · Definición Arquitectónica Proto-Do

Contratos de interfaces, DTOs e inyección de dependencias. Se actualiza antes de programar cada módulo.

---

## 1. Seguridad: perímetro de red (PROT-05) y RBAC (PROT-04.2)

Rama: `feat/Middleware-IP`.

### 1.1 Contratos

```typescript
// @common/utils/client-ip.util.ts — PROT-05.1 (helper puro, sin estado ni I/O)
export const extractClientIp: (req: Request) => string | null;

// @common/services/ip-access.service.ts — PROT-05.2 + PROT-05.3
export class IpAccessService {
  /** Fail-closed: lanza ForbiddenException si el origen no está autorizado. */
  public assertRequestAllowed(req: Request): void;
}

// @modules/auth/interfaces/jwt-payload.interface.ts
export interface JwtPayload {          // lo que viaja firmado en el token
  sub: string;                         // id_usuario (RFC 7519)
  email: string;
  role: UserRole;
}

export interface AuthenticatedUser {   // lo que JwtStrategy publica en req.user
  id: string;
  email: string;
  role: UserRole;
}

export interface RequestWithUser {     // lectura tipada de req.user en guards
  user?: AuthenticatedUser;
}
```

Metadata y constantes compartidas en `@common/constants/security.constants.ts`:
`IS_PUBLIC_IP_KEY`, `ROLES_KEY`, `ACCESS_DENIED_MESSAGE`, `ALLOWED_IP_RANGES_ENV`.

### 1.2 Diagrama de inyección de dependencias

```
ConfigModule (global)
      │
      ▼
CommonModule (@Global)
      ├── IpAccessService ──────────┐  (política única: parseo de CIDR + fail-closed + log)
      │                             │
      ├── IpWhitelistGuard ◄────────┤  registrado como APP_GUARD en AppModule
      │     └── Reflector           │  exime lo marcado con @PublicIp()
      │                             │
      └── RedLocalMiddleware ◄──────┘  resuelto en main.ts, montado sobre las rutas
                                       de Swagger (fuera del router de Nest)

AuthModule
      ├── PassportModule + JwtModule.registerAsync(JWT_SECRET, JWT_EXPIRES_IN)
      ├── JwtStrategy ──► valida firma/expiración y publica AuthenticatedUser en req.user
      └── JwtAuthGuard (AuthGuard('jwt'))  ─┐
                                            ├─► @UseGuards(JwtAuthGuard, RolesGuard)
CommonModule.RolesGuard ────────────────────┘    + @Roles(UserRole.ADMIN) en UsersController
      └── Reflector (lee ROLES_KEY)
```

### 1.3 Orden de evaluación garantizado

```
Petición
   │
   ├─ 1. RedLocalMiddleware  ── solo /api/docs, /api/docs-json, /api/docs-yaml
   │
   ├─ 2. IpWhitelistGuard (APP_GUARD)   ── 403 si la IP está fuera de los CIDR
   │        └── @PublicIp() ⇒ paso directo (GET /api/health)
   │
   ├─ 3. JwtAuthGuard        ── 401 si el token falta, expiró o la firma no valida
   │
   ├─ 4. RolesGuard          ── 403 si el rol no está en @Roles(...)
   │
   ├─ 5. ValidationPipe      ── 400 si el DTO o el UUID no validan
   │
   └─ 6. UsersController → UsersService → repositorio TypeORM
```

Los guards globales (`APP_GUARD`) se evalúan **antes** que los de controlador: la IP se rechaza
sin haber procesado credenciales, cumpliendo el *rechazo temprano* de `security-and-scope.md` §1.

### 1.4 Namespaces y variables de entorno

| Variable | Uso | Política si falta |
|---|---|---|
| `ALLOWED_IP_RANGES` | Rangos CIDR corporativos / VPN separados por comas | **Fail-closed**: 403 a toda petición |
| `JWT_SECRET` | Verificación de firma del token | El proceso no arranca (guarda en `JwtStrategy`) |
| `JWT_EXPIRES_IN` | Vigencia al firmar (PROT-04.1) | Cae a `8h` |

### 1.5 Entregado en PROT-04.1 / PROT-06.4

La emisión de tokens que esta sección dejaba pendiente ya está implementada. Ver §2.

---

## 2. Autenticación OTP y ciclo de sesión (PROT-04.1 / PROT-06.4)

Rama: `feat/auth-otp`.

### 2.1 Endpoints

Todos dentro del perímetro (`IpWhitelistGuard` global) — **ninguno** lleva `@PublicIp()`:
iniciar sesión también exige estar en la red corporativa.

| Método y ruta | Código | Cuerpo | Respuesta |
|---|---|---|---|
| `POST /api/auth/otp/generate` | `202` | `RequestOtpDto` | `{ message, expiresInSeconds }` — **nunca** el código |
| `POST /api/auth/otp/validate` | `200` | `VerifyOtpDto` | `AuthTokenResponse` |
| `POST /api/auth/refresh` | `200` | `RefreshTokenDto` | `AuthTokenResponse` con el par rotado |
| `POST /api/auth/logout` | `204` | `RefreshTokenDto` | vacío (idempotente) |

Límite de tasa con `@nestjs/throttler`: **3 peticiones/60 s por IP** en las rutas de OTP
(fuerza bruta y saturación de buzones), elevado a **10/60 s** en `refresh` y `logout`
mediante `@Throttle`, porque renovar sesión no comparte ese riesgo y varias pestañas
abiertas agotarían el presupuesto estricto.

### 2.2 Contratos

```typescript
// @modules/auth/services/otp-config.service.ts — único punto que conoce otplib v13.
// Opera sobre un secreto que recibe como argumento: no conoce usuarios ni BD.
export class OtpConfigService {
  public generateSecret(): string;                       // base32, 160 bits
  public async generateCode(secret: string): Promise<string>;
  public async verifyCode(secret: string, code: string): Promise<boolean>;
  public getExpirationSeconds(): number;
}

// @modules/users/users.service.ts — custodia del secreto (PROT-04.1)
export class UsersService {
  /** Único camino por el que `otpSecret` sale del repositorio (`addSelect`). */
  public async findByEmailWithOtpSecret(email: string): Promise<User | null>;
  /** Inscripción perezosa, con UPDATE condicional a `otpSecret IS NULL`. */
  public async ensureOtpSecret(userId: string, secret: string): Promise<string>;
}

// @modules/auth/services/refresh-token.service.ts — único punto que conoce `tokens_sesion`
export class RefreshTokenService {
  /**
   * Devuelve el token EN CLARO; en la tabla solo queda su SHA-256.
   * En una sola transaccion: revoca la sesion previa de ESE dispositivo,
   * inserta, aplica el cupo de sesiones y poda los tokens muertos.
   */
  public async issue(user: User, deviceId: string): Promise<string>;
  /** Canjea y revoca en el mismo acto. Lanza 401 en todo caso de fallo. */
  public async rotate(rawToken: string): Promise<RotatedSession>;
  public async revoke(rawToken: string): Promise<void>;
  public async revokeAllForUser(userId: string): Promise<void>;
}

/** El dispositivo lo transporta la cadena de tokens; el cliente no lo reenvia. */
export interface RotatedSession {
  user: User;
  deviceId: string;
}

// @modules/auth/interfaces/jwt-payload.interface.ts
export interface AuthTokenResponse {
  accessToken: string;   // JWT autocontenido, 1 h
  refreshToken: string;  // cadena opaca base64url, 7 días, revocable
  user: AuthenticatedUser;
}

export interface OtpRequestResponse {
  message: string;
  expiresInSeconds: number;
}
```

Secreto TOTP **aleatorio y persistido por cuenta** en `usuarios.secreto_otp` (migración 003).
La inscripción es perezosa: se genera en la primera solicitud de código, sin migrar datos.
`otpSecret` lleva `select: false` en la entidad y `@Exclude()` de `class-transformer`, así que
no se carga salvo petición explícita y jamás se serializa en una respuesta.

El CRUD responde con `UserResponseDto`, que lleva `@Exclude()` **de clase**: solo sale lo
marcado con `@Expose()` (`id`, `email`, `role`, `isActive`). Un campo nuevo en la entidad no
se filtra hasta que alguien lo exponga a propósito. `UsersController` y `AuthController`
aplican `ClassSerializerInterceptor`.

### 2.3 Diagrama de inyección de dependencias

```
ConfigModule (global)          CommonModule (@Global)
      │                              └── EmailService (nodemailer, único punto SMTP)
      ▼                                        │
AuthModule                                     │
      ├── TypeOrmModule.forFeature([RefreshToken])
      ├── JwtModule.registerAsync(JWT_SECRET, JWT_EXPIRES_IN=1h)
      │
      ├── AuthService ──┬── UsersService        (busca la cuenta por correo)
      │                 ├── OtpConfigService    (genera / verifica el código)
      │                 ├── EmailService ◄──────┘ (único canal del código)
      │                 ├── JwtService          (firma el access token)
      │                 └── RefreshTokenService (emite / rota / revoca)
      │
      └── AuthController  ── @UseGuards(ThrottlerGuard) a nivel de clase
```

### 2.4 Máquina de estados del refresh token

```
        issue()                    rotate()
  ─────────────────►  VIGENTE  ──────────────►  REVOCADO ──┐
                         │  │                       │      │
       expiracion ◄──────┘  └──── revoke()          │      │ pruneDeadTokens()
       vencida                    (logout)          │      │ (conserva los 5
                         │                          │      │  mas recientes)
                         │                          ▼      ▼
                         │    rotate() de nuevo ⇒ REUTILIZACIÓN   BORRADO
                         │    ⇒ revokeAllForUser() + 401
                         │
                         └── 6.ª sesion viva ⇒ enforceSessionLimit() ⇒ BORRADO
                             (NO pasa por REVOCADO: ver abajo)
```

**La expulsion por cupo borra la fila; no la revoca.** Una fila revocada sigue existiendo, y
cuando el dispositivo expulsado presentase su token, `rotate()` lo encontraria con
`isRevoked: true` y tomaria el camino de REUTILIZACIÓN: `revokeAllForUser()` derribaria las
otras cinco sesiones y quedaria una alerta de robo falsa en el log. Al borrarla, ese intento
cae en la rama de «token inexistente» y termina en el 401 corriente.

Es la contrapartida de la retencion: los tokens **muertos** se conservan (son la ventana de
deteccion de reuso), pero una sesion **viva** expulsada por cupo no debe dejar rastro revocado.

### 2.5 Variables de entorno

| Variable | Uso | Política si falta |
|---|---|---|
| `OTP_EXPIRATION_MINUTES` | Vigencia del código y valor de `expiresInSeconds` | Cae a `5` |
| `JWT_EXPIRES_IN` | Vigencia del access token (**`1h`**) | Cae a `8h` |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | Vigencia del refresh token | Cae a `7` si falta **o no es un numero positivo** |
| `OTP_THROTTLE_TTL_MS` / `OTP_THROTTLE_LIMIT` | Ventana y cupo del límite de tasa | Caen a `60000` / `3` |
| `SMTP_*` | Transporte del correo | El envío falla con `500` |

### 2.6 Esquema

Tabla `tokens_sesion` (columnas en español, como el resto de `init.sql`):
`id_token_sesion`, `id_usuario` (FK `ON DELETE CASCADE`), `id_dispositivo UUID NOT NULL`,
`hash_token CHAR(64) UNIQUE`, `expiracion`, `revocado`, `fecha_creacion`.

La entidad se sigue llamando `RefreshToken` y su archivo `refresh-token.entity.ts`: esquema en
castellano, identificadores de código en inglés (`code-conventions.md` §1), igual que
`User`/`usuarios` y `Workflow`/`flujos`. La ruta `POST /auth/refresh` y el campo `refreshToken` del
contrato HTTP tampoco cambian.

TypeORM corre con `synchronize: false`, así que el DDL se aplica a mano:
`db/migrations/001-refresh-tokens.sql` (idempotente) para bases ya creadas,
e `init.sql` para clonados nuevos.

`db/migrations/003-otp-secret.sql` añade `secreto_otp` y retira `codigo_otp` / `expiracion_otp`,
dos columnas de un diseño anterior de códigos persistidos que ningún código leía.

`db/migrations/004-device-id-refresh-tokens.sql` añade `id_dispositivo`, que agrupa los tokens
por origen para que emitir uno nuevo revoque solo la sesión anterior de **ese** dispositivo.
Descarta las filas heredadas (no tienen dispositivo conocido), así que quien tuviera sesión
abierta al aplicarla vuelve a entrar por OTP.

`db/migrations/009-tokens-sesion.sql` renombra la tabla `refresh_tokens` → `tokens_sesion` y su PK
`id_refresh_token` → `id_token_sesion`, la última excepción a la nomenclatura castellana del esquema.
Renombra **seis** objetos y no dos: `ALTER TABLE ... RENAME TO` no arrastra el índice ni las tres
constraints, que conservan el nombre derivado del nombre viejo, mientras `init.sql` las deriva del
nuevo — sin ese paso una base migrada divergiría de un clonado nuevo. Las migraciones 001 y 004
quedan obsoletas a partir de esta y no deben aplicarse después de ella.

`db/migrations/002-bootstrap-admin.sql` rompe el bloqueo circular del RBAC: el CRUD de
usuarios exige `ADMIN` y crear un usuario pasa por ese mismo CRUD, así que sin ningún
`ADMIN` nadie puede crear el primero. Promueve la cuenta activa más antigua **solo si** no
existe ya un `ADMIN` activo; con uno presente no modifica nada.

### 2.7 Capa de sesión en el frontend (Quasar)

```
LoginPage.vue ──► useSessionStore ──► auth.service ──► authApi (SIN interceptores)
                        │
                        ▼
              utils/session-storage.ts  ◄────  boot/axios.ts (interceptores de `api`)
              (módulo HOJA: rompe el ciclo boot ↔ store)

MainLayout.vue ──► useSessionMonitor() ──► SessionExpiryDialog.vue
                        │                  (Mantener sesión ⇒ refreshTokens)
                        └── watch(accessToken) + visibilitychange
```

| Archivo | Responsabilidad |
|---|---|
| `utils/session-storage.ts` | Persistencia en `localStorage` con guarda `try/catch`. Sin dependencias |
| `utils/jwt.ts` | `decodeJwtClaims` / `getMillisecondsUntilExpiry`. **Decodifica, no verifica** |
| `utils/corporate-email.ts` | `isCorporateEmail`, compartida por login y alta de usuario |
| `services/auth.service.ts` | Única capa que conoce las rutas de `AuthController` |
| `stores/session.store.ts` | `accessToken`, `refreshToken`, `user`, `otpVerified`, `isAuthenticated` |
| `composables/useSessionMonitor.ts` | Programa el aviso 60 s antes de `exp`; recalcula al recuperar visibilidad |
| `layouts/AuthLayout.vue` | Layout desnudo de `/login`, sin shell corporativo |

Dos instancias de Axios: `api` con interceptores (petición inyecta `Bearer`, respuesta
purga y redirige ante `401`) y `authApi` **sin ninguno**, para que un 401 del login o del
refresh no dispare el manejador que cerraría la sesión que se intenta abrir o renovar.

`meta: { requiresAuth: true }` se declara en la ruta **padre** de `MainLayout`: toda vista
nueva bajo ese layout nace protegida.

---

## 3. Motor FSM: contratos, contexto, persistencia y bucle (PROT-07 / PROT-08 / PROT-09)

Ramas: `feat/fsm-contracts` (PROT-07), `feat/fsm-payload-context` (PROT-08) y `feat/fsm-engine` (PROT-09).

Primera pieza del motor: el contrato del grafo que el `FsmEngineService` recorrerá. Describe qué
nodo viene después de cuál, dónde escribe cada uno su resultado y cómo se reintenta ante un fallo.
Se persiste en la columna `flujos.configuracion_pipeline` (JSONB).

`INodeStrategy`, `NodeStrategyFactory` y `StatePayloadContext` **siguen pendientes**; su contrato de
referencia vive en `.claude/rules/architecture-patterns.md` §2 y §3.

### 3.1 Contratos

```typescript
// @core/fsm/types/pipeline-schema.types.ts — forma del JSON ya validado
export const MAX_RETRY_ATTEMPTS = 5;
export const OUTPUT_NAMESPACE_PATTERN = /^[a-z0-9_]+$/;   // snake_case: interpolable como {{ns.campo}}
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

// Enum, no union type: @IsEnum() necesita un objeto en runtime.
export enum NodeType {
  TRIGGER_IMAP, PARSER_PRE_IA, EXTRACTOR_WEB, PROCESADOR_IA,
  ESCUDO_POST_IA, MAPEADOR_PLANTILLA, DESTINO_HTTP,
}

export interface PipelineNodeConfig {
  nodeId: string;                      // idéntico a su clave en `nodes`
  nodeType: NodeType;                  // lo resolverá NodeStrategyFactory
  outputNamespace: string;             // único en todo el pipeline
  nextStep: string | null;             // null ⇒ nodo terminal
  onErrorStep: string | null;          // puede apuntar hacia atrás (reintento)
  retryPolicy?: RetryPolicy;           // { maxRetries: 0..5, backoffMs?, backoffFactor? }
  params: Record<string, unknown>;     // cada estrategia valida los suyos
}

export interface PipelineSchema {
  flowId: string; name: string; version: string;   // version en SemVer
  entrypoint: string;                              // clave de `nodes`
  nodes: Record<string, PipelineNodeConfig>;
}

// @core/fsm/validators/pipeline-topology.validator.ts — función pura, sin DI
export interface SchemaIssue { field: string; constraints: string[]; }
export const validatePipelineTopology: (schema: PipelineSchemaDto) => SchemaIssue[];

// @core/fsm/services/pipeline-validator.service.ts — frontera Poka-Yoke
export class PipelineValidatorService {
  /** @throws BadRequestException con `issues: SchemaIssue[]` si algo no encaja. */
  public validateSchema(rawJson: unknown): Promise<PipelineSchemaDto>;
}
```

### 3.2 Diagrama de inyección de dependencias

```
PipelineValidatorService              (@Injectable, sin dependencias inyectadas)
      │
      ├── class-transformer.plainToInstance ──► PipelineSchemaDto      (forma del esquema)
      │                                    └──► PipelineNodeConfigDto  (nodo a nodo, manual)
      │
      ├── class-validator.validate({ whitelist, forbidNonWhitelisted })
      │        └── flattenValidationErrors ──► rutas con punto (`nodes.X.retryPolicy.maxRetries`)
      │
      └── validatePipelineTopology(schema)   (función pura: sin estado, sin I/O, sin Nest)

Aún sin módulo: el servicio se declarará en `FsmModule` cuando exista su primer consumidor
(el CRUD de flujos, que validará antes de escribir en `flujos.configuracion_pipeline`).
```

### 3.3 Reglas de integridad topológica

| # | Regla | `field` del issue |
|---|---|---|
| 1 | `entrypoint` existe en `nodes` | `entrypoint` |
| 2 | La clave del mapa coincide con el `nodeId` del nodo | `nodes.<clave>.nodeId` |
| 3 | Todo `nextStep` / `onErrorStep` no nulo resuelve a un nodo existente | `nodes.<clave>.<puntero>` |
| 4 | Ningún `outputNamespace` se repite entre nodos | `nodes.<clave>.outputNamespace` |
| 5 | El camino activo termina en `nextStep === null` sin revisitar nodos | `nodes.<clave>.nextStep` |

```
entrypoint ──► A ──► B ──► C ──► null        OK (termina en terminal)
                     │
                     └── onErrorStep ──► A   OK (los ciclos de reintento son legítimos)

entrypoint ──► A ──► B ──► C ──► A           ERROR: ciclo infinito en nextStep

nodes: { A, B, C, huerfano_Z }               OK: Z es inalcanzable y se IGNORA
```

Dos decisiones deliberadas: solo se recorre `nextStep` (un `onErrorStep` hacia atrás es el patrón de
reintento, no un defecto) y los nodos inalcanzables no invalidan el esquema (un flujo puede
conservar ramas en construcción).

### 3.4 Namespaces

`outputNamespace` es la clave bajo la que un nodo escribe en el `StatePayloadContext`. Su unicidad es
lo que sostiene la inmutabilidad del contexto: si dos nodos compartieran namespace, el `spread` del
segundo pisaría los datos del primero y el *checkpoint* dejaría de reflejar lo realmente ejecutado.
De ahí que la colisión sea un error de esquema y no una advertencia.

El patrón `^[a-z0-9_]+$` no es estético: la expresión de interpolación de `getInterpolatedValue`
(`architecture-patterns.md` §3) solo reconoce `[a-zA-Z0-9_]`, así que un namespace con guiones o
puntos nunca podría resolverse desde una plantilla `{{nodo.campo}}`.

### 3.5 Esquema

`tipos_nodo.codigo` replica los 7 valores de `NodeType` (migración `005-tipos-nodo-fsm.sql`).
`TRIGGER_CRON` y `DESTINO_ACENS` permanecen en el catálogo pero **no** son declarables en un
`pipeline_schema` hasta que existan sus estrategias y se amplíe el enum.

---

### 3.6 Contexto de ejecución (PROT-08)

```typescript
// @core/fsm/types/fsm.enums.ts
export enum ExecutionState {
  INACTIVO, EN_PROCESO, PAUSADO, EXITOSO, FALLIDO,   // = tipo `enum_estado` de PostgreSQL
}

// @core/fsm/context/state-payload.context.ts — clase PURA, no @Injectable()
export class MissingContextVariableException extends Error {
  readonly variable: string;                        // ej. "ia_result.titulo"
}

export class StatePayloadContext {
  constructor(executionId: string, workflowId: string, initialStep: string);

  setNamespace(namespace: string, data: Record<string, unknown>): void;
  getNamespace(namespace: string): Record<string, unknown> | undefined;
  getAllContext(): Record<string, Record<string, unknown>>;
  getCursor(): string;
  setCursor(nextStep: string): void;
  getInterpolatedValue(template: string): string;   // lanza si la variable falta
  getExecutionId(): string;
  getWorkflowId(): string;
}

// @core/fsm/entities/fsm-execution.entity.ts — mapea `ejecuciones_flujo`
@Entity('ejecuciones_flujo')
@Index('idx_flujo_activo', ['flowId'], { unique: true, where: "estado = 'EN_PROCESO'" })
export class FsmExecution {
  executionId: string;    // id_ejecucion        flowId: string;        // id_flujo
  currentState: ExecutionState;  // estado       activeCursor: string | null;  // paso_actual
  contextPayload: Record<string, Record<string, unknown>>;  // contexto_acumulado (jsonb)
  retryState: Record<string, unknown>;                      // retry_state (jsonb)
  createdAt: Date;        // fecha_inicio        updatedAt: Date;       // fecha_actualizacion
}
```

**No es `@Injectable()`.** `StatePayloadContext` se instancia una vez por ejecución y viaja como
argumento a `INodeStrategy.execute()`. Un provider de Nest sería un singleton compartido entre
ejecuciones concurrentes, justo lo contrario de lo que necesita ser.

**`structuredClone` en ambas direcciones, no *spread*.** El *spread* copia superficialmente: un
`context.getNamespace('ia').meta.titulo = 'otro'` alcanzaría el objeto interno y corrompería un
checkpoint ya dado por bueno. Se clona en profundidad la entrada de `setNamespace`, su salida y la
de `getAllContext`.

**La interpolación falla en vez de callar.** A diferencia de la implementación de referencia de
`architecture-patterns.md` §3 —que devuelve `''`—, una variable ausente o nula lanza
`MissingContextVariableException`. Interpolar en silencio publicaría un artículo con el título
vacío; el fallo aparecería aguas abajo, ya en Drupal, lejos de su causa.

> La gramática de rutas que aquí se describía (`{{nodo.campo}}`, dos segmentos) quedó ampliada en
> PROT-10 a rutas compuestas de cualquier profundidad. Ver **§3.15**.

### 3.7 Máquina de estados de la ejecución

```
                    ┌──────────────────────────────────────────┐
                    │            arranque del backend          │
                    │        (FsmModule.onModuleInit)          │
                    ▼                                          │
  INACTIVO ──► EN_PROCESO ──┬──► EXITOSO                       │
   (fila         (mutex)    │                                  │
   recien          │        └──► PAUSADO ──► EN_PROCESO  (CU-09, reintento)
   creada)         │                 ▲          │
                   └── fallo ────────┘          └──► FALLIDO  (reintentos agotados)
```

`idx_flujo_activo` es un índice único **parcial**: solo aplica mientras `estado = 'EN_PROCESO'`, de
modo que un flujo no puede tener dos ejecuciones vivas a la vez pero sí todo el histórico que haga
falta en estados terminales. La garantía la da PostgreSQL, no un bloqueo en memoria que se perdería
al escalar a varios procesos.

La transición de arranque `EN_PROCESO → PAUSADO` no es cosmética: tras un reinicio, una fila
`EN_PROCESO` afirma algo falso —que hay un bucle atendiéndola— y **seguiría reservando el mutex**,
dejando ese flujo bloqueado para siempre. `FsmModule.onModuleInit` las reconcilia y las deja donde
el protocolo de resiliencia (`architecture-patterns.md` §4) espera encontrarlas.

### 3.8 Diagrama de inyección de dependencias (PROT-08)

```
AppModule
   └── FsmModule  ──implements OnModuleInit──► reconcilia EN_PROCESO → PAUSADO al arrancar
         ├── TypeOrmModule.forFeature([FsmExecution])
         │        └── Repository<FsmExecution>  ──inyectado en la propia clase del modulo
         ├── FsmController          POST /api/fsm/validate-schema   (@PublicIp() TEMPORAL)
         │        └── PipelineValidatorService
         └── exports: PipelineValidatorService   (para el futuro CRUD de flujos)

StatePayloadContext  ──  FUERA del contenedor: `new` por ejecucion, no provider
```

### 3.9 Esquema (PROT-08)

`ejecuciones_flujo` se amplía en `db/migrations/006-fsm-execution-mutex.sql`: `INACTIVO` se añade a
`enum_estado`, aparecen `retry_state` y `fecha_actualizacion`, `contexto_acumulado` pasa a
`NOT NULL DEFAULT '{}'`, el default del estado pasa a `INACTIVO` y se crea `idx_flujo_activo`.

**Requisito de arranque:** hasta aplicar la 006 el backend no levanta — `onModuleInit` lanza un
`UPDATE` y `@UpdateDateColumn` añade `fecha_actualizacion` al `SET`.

---

### 3.10 Contratos polimórficos de nodo (PROT-09)

```typescript
// @core/fsm/types/node-strategy.types.ts
export type NodeErrorSeverity = 'LEVE' | 'GRAVE' | 'URGENTE';   // = enum_nivel_error

export interface NodeErrorDetail {
  level: NodeErrorSeverity;      // gobierna el control de flujo, no solo la traza
  message: string;
  missingFields?: string[];
  stackTrace?: string;
}

export interface NodeResult {
  success: boolean;
  data?: Record<string, unknown>;   // se escribe en el outputNamespace del nodo
  error?: NodeErrorDetail;
}

export interface INodeStrategy {
  readonly nodeType: NodeType;
  execute(context: StatePayloadContext, params: Record<string, unknown>): Promise<NodeResult>;
}

// @core/fsm/exceptions/strategy-not-found.exception.ts
export class StrategyNotFoundException extends Error { readonly nodeType: string; }

// @core/fsm/factories/node-strategy.factory.ts
@Injectable()
export class NodeStrategyFactory {
  registerStrategy(strategy: INodeStrategy): void;
  getStrategy(nodeType: NodeType): INodeStrategy;   // lanza StrategyNotFoundException
}

// @core/fsm/services/fsm-engine.service.ts
export const TRIGGER_NAMESPACE = 'trigger';
export const MAX_TRANSITIONS = 100;

@Injectable()
export class FsmEngineService {
  executeWorkflow(
    executionId: string,
    schema: PipelineSchemaDto,
    initialPayload?: Record<string, unknown>,
  ): Promise<FsmExecution>;      // NotFoundException | ConflictException
}
```

**Un nodo no lanza para señalar un fallo de negocio**: devuelve `success: false` con su
`NodeErrorDetail`. Las excepciones quedan para lo imprevisto, que el motor aísla y normaliza a ese
mismo contrato con nivel `URGENTE`.

### 3.11 Defensa en dos capas contra ciclos

| Capa | Mecanismo | Qué acota | Dónde vive | Al agotarse |
|---|---|---|---|---|
| 1 | `@Max(5)` en `RetryPolicyDto` | Reintentos **intra-nodo**: mismo cursor, sin moverse | `retry_state[nodeId]` (jsonb) | Fallback a `onErrorStep`, o `PAUSADO` |
| 2 | `MAX_TRANSITIONS = 100` | Saltos **entre nodos**: cada cambio de cursor | Variable local del bucle | Log `URGENTE` + `PAUSADO` |

La capa 2 es imprescindible porque §3.3 permite **a propósito** que `onErrorStep` apunte hacia atrás:
`A → falla → B → A` es un esquema topológicamente válido que, sin presupuesto, colgaría el worker.

### 3.12 Bucle de ejecución

```
                        ┌──────────────────────────────────────────┐
                        │  while (activeCursor !== null)           │
                        │  ++transitions > MAX_TRANSITIONS ────────┼──► URGENTE + PAUSADO
                        └────────────────┬─────────────────────────┘
                                         ▼
                        ┌────────────────────────────────────────┐
                        │  BUCLE INTRA-NODO (no mueve el cursor) │
                        │  ┌──────────────────────────────────┐  │
                        │  │ runNode()  ── try/catch interno  │  │
                        │  │   excepción ⇒ NodeResult URGENTE │  │
                        │  └───────────────┬──────────────────┘  │
                        │      fallo GRAVE │ con intentos libres │
                        │      retry_state++ · checkpoint ·      │
                        │      sleep(backoffMs · factor^(n-1)) ──┘  (vuelve arriba)
                        └────────────────┬───────────────────────┘
                                         ▼
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
    success                     onErrorStep !== null            onErrorStep === null
 setNamespace()                  cursor = onErrorStep            checkpoint(PAUSADO)
 cursor = nextStep                checkpoint(EN_PROCESO)          break
 checkpoint(EN_PROCESO)                  │                          │
        │                          TRANSICIÓN                       │
   TRANSICIÓN                                                   (conserva el cursor
        │                                                        del nodo culpable)
        ▼
  cursor === null ──► checkpoint(EXITOSO, null)
```

Nótese la asimetría deliberada: **el bucle interno no incrementa `transitions`**. Anidarlo, en lugar
de reintentar con un `continue` del bucle externo, hace que el presupuesto cuente saltos de grafo
*por construcción*, sin excepciones que recordar.

Cuando el nodo terminal tiene éxito el motor **no** escribe un `EN_PROCESO` con cursor nulo: rompe el
bucle y deja que la finalización persista `EXITOSO` directamente. Un estado intermedio sin
significado, y una ida y vuelta a la base de datos, menos.

### 3.13 Diagrama de inyección de dependencias (PROT-09)

```
AppModule
   └── FsmModule  ──implements OnModuleInit──► reconcilia EN_PROCESO → PAUSADO al arrancar
         ├── TypeOrmModule.forFeature([FsmExecution])
         │        └── Repository<FsmExecution> ──┬── FsmModule (reconciliación)
         │                                       └── FsmEngineService (checkpoints)
         ├── FsmController ──► PipelineValidatorService
         ├── FsmEngineService ──► NodeStrategyFactory ──► Map<NodeType, INodeStrategy>
         │                                                  (vacío hasta PROT-10)
         └── exports: PipelineValidatorService, NodeStrategyFactory, FsmEngineService

StatePayloadContext  ──  FUERA del contenedor: `new` por ejecución, no provider
```

`NodeStrategyFactory` se exporta para que los módulos de nodos de PROT-10 registren sus estrategias
contra **la misma instancia** que consume el motor.

### 3.14 Resiliencia de dos niveles

| Nivel | Qué atrapa | Reacción |
|---|---|---|
| `try` interno (`runNode`) | Excepción no controlada de una estrategia, incluida `StrategyNotFoundException` | Se normaliza a `NodeResult` URGENTE; el flujo sigue su lógica de fallback |
| `try` externo | Fallo catastrófico (la BD deja de responder) | `logger.error`, intento defensivo de `FALLIDO` y **re-lanza** |

La **validación previa** (`findOne`, comprobación de `EN_PROCESO`, marca inicial) queda fuera del
`try` externo a propósito: si marcar `EN_PROCESO` choca contra el mutex `idx_flujo_activo`, la
excepción debe propagarse **sin** marcar `FALLIDO`. No ha fallado el flujo; no le tocaba el turno.

---

### 3.15 Motor de interpolación de plantillas (PROT-10)

```typescript
// @core/fsm/context/state-payload.context.ts — funcion PURA exportada
export const resolvePath: (
  namespaces: Record<string, Record<string, unknown>>,
  rawPath: string,
) => unknown;                    // lanza MissingContextVariableException
```

#### Gramática soportada

```
{{ namespace.prop }}                       un segmento
{{ namespace.prop.sub.sub }}               anidamiento sin limite
{{ namespace.array[0] }}                   indice de arreglo
{{ namespace.array[1].prop }}              propiedad dentro de un arreglo
{{ namespace.array.1.prop }}               notacion equivalente por punto
{{   namespace.prop   }}                   espaciado holgado
{{ namespace }}                            NO casa: se deja literal
```

Identificadores restringidos a `[a-zA-Z0-9_]`, el mismo juego que
`OUTPUT_NAMESPACE_PATTERN` impone a los `outputNamespace`: una ruta que el DTO no permite declarar
tampoco debería poder escribirse en una plantilla.

**Algoritmo** — cero `eval`, cero parser de AST (`security-and-scope.md` §3). Los corchetes se
normalizan a puntos (`urls[0]` → `urls.0`) para recorrer una sola gramática, y la navegación es una
reducción sobre los segmentos con tres cortes por salto: clave bloqueada, nodo intermedio no
navegable, propiedad no propia.

#### Serialización por tipo

| Tipo del valor | Salida | Motivo |
|---|---|---|
| `string` | El valor tal cual | Es texto destinado a la plantilla; sin comillas ni escapes |
| `number` / `boolean` / `bigint` | `String(value)` | `42`, no `"42"`. El `bigint` va aquí porque `JSON.stringify(1n)` lanza |
| objeto / arreglo | `JSON.stringify(value)` | Nunca `[object Object]`: sería corrupción silenciosa en el artículo publicado |
| `null` / `undefined` | — | Lanza `MissingContextVariableException` |

#### Garantías de seguridad

Dos barreras independientes, cada una necesaria para un vector distinto:

| Barrera | Detiene | Vector real |
|---|---|---|
| `BLOCKED_KEYS` (`__proto__`, `constructor`, `prototype`) | Esas claves aunque sean **propias** | `JSON.parse('{"__proto__":{...}}')` las crea como propias; sobreviven a `structuredClone` y al spread de `setNamespace`. Es el camino de la respuesta del nodo de IA |
| `Object.hasOwn` en cada salto | Todo lo **heredado** | `{{ ns.dato.toString }}` devolvería una función, y `JSON.stringify` de una función es `undefined`: la plantilla acabaría con ese literal dentro |

Ninguna es redundante: retirar cualquiera de las dos hace fallar una prueba distinta de la suite.
Además, la excepción cita siempre la ruta **literal** que escribió el autor
(`parsed_email.extracted_urls[99]`), no la forma normalizada interna.


---

## 4. Gestor de plantillas HTML y `MAPEADOR_PLANTILLA` (PROT-11.1 / PROT-11.2)

Cierra el hueco que dejaba PROT-10: la interpolación existía, pero la plantilla viajaba incrustada en
`params.template` del `pipeline_schema`. Ahora vive en `plantillas_html`, reutilizable entre flujos y
auditable, y el nodo solo declara `params.templateId`.

### 4.1 Contratos

```typescript
// @modules/templates/templates.service.ts
export const ALLOWED_NAMESPACES: readonly [
  'raw_email', 'parsed_email', 'scraped_web',
  'llm_response', 'validated_drupal_json', 'rendered_html',
];

export class TemplatesService {
  findAll(onlyActive?: boolean): Promise<HtmlTemplate[]>;
  findOne(id: string): Promise<HtmlTemplate>;               // lanza NotFoundException
  create(dto: CreateTemplateDto, createdById: string): Promise<HtmlTemplate>;
  update(id: string, dto: UpdateTemplateDto): Promise<HtmlTemplate>;
  softDelete(id: string): Promise<HtmlTemplate>;            // activo = false
  // privado: extractAndValidateVariables(html) -> string[]  lanza BadRequestException
}

// @modules/nodes/strategies/template-mapper.strategy.ts
export class TemplateMapperStrategy implements INodeStrategy {
  readonly nodeType = NodeType.MAPEADOR_PLANTILLA;
  constructor(templatesService: TemplatesService);
  execute(context: StatePayloadContext, params: Record<string, unknown>): Promise<NodeResult>;
}
```

`CreateTemplateDto` expone **solo** `name`, `description?` y `htmlContent`. `requiredVariables` es un
campo derivado que recalcula el servicio a partir del propio HTML, y `createdById` sale del JWT: si
cualquiera de los dos entrase por el cuerpo, se podrían declarar variables que la plantilla no usa o
suplantar la autoría.

### 4.2 Endpoints

`/templates`, con `JwtAuthGuard` + `RolesGuard` a nivel de clase y `@Roles(ADMIN, EDITOR)` —
configurar plantillas es operación de flujos, no gestión de cuentas. El perímetro de red lo cubre
`IpWhitelistGuard`, ya registrado como `APP_GUARD` global.

| Verbo | Ruta | Efecto |
|---|---|---|
| `POST` | `/templates` | Valida namespaces y persiste. `400` si alguno no está en la lista blanca |
| `GET` | `/templates` | Lista las activas, ordenadas por `name` (alimenta el `<q-select>` de Vista 4) |
| `GET` | `/templates/:id` | Detalle. `404` si no existe |
| `PUT` | `/templates/:id` | Actualiza; si cambia el HTML, recalcula `requiredVariables` |
| `DELETE` | `/templates/:id` | Borrado **lógico** (`activo = false`) |

### 4.3 Lenguaje de plantilla admitido

Subconjunto deliberado de Handlebars: **solo sustitución determinista de variables**
(`security-and-scope.md` §3). La validación es estática, al guardar, no al renderizar.

```
{{ parsed_email.clean_title }}             OK
{{ llm_response.articles.[0].title }}      OK — indice en literal de segmento
{{ contacto.telefono }}                    400 — namespace fuera de la lista blanca
{{ titulo }}                               400 — namespace suelto, no interpolable
{{{ llm_response.summary }}}               400 — triple-stash: desactiva el escapado de HTML
{{# if ... }} / {{/ if}} / {{> parcial }}   400 — logica y parciales
```

Se valida la **raíz** de la ruta a cualquier profundidad, y todo marcador que el patrón no reconozca
se rechaza. Las rutas se guardan normalizadas (`.[0]` → `.0`), la forma que navega `resolvePath`.

### 4.4 Diagrama de inyección de dependencias

```
AppModule
 ├── TemplatesModule ───────────── TypeOrmModule.forFeature([HtmlTemplate])
 │    ├── TemplatesController ──── TemplatesService
 │    └── exports: TemplatesService
 │                                      │
 └── NodesModule                        │ (inyeccion)
      ├── imports: FsmModule ──────── NodeStrategyFactory  (singleton exportado)
      ├── imports: TemplatesModule ──────┘
      ├── providers: TemplateMapperStrategy
      └── onModuleInit() ──> factory.registerStrategy(templateMapperStrategy)
```

El registro se hace en `NodesModule.onModuleInit()` y **no** dentro de `NodeStrategyFactory`: la
factoría es deliberadamente agnóstica de estrategias concretas (registro explícito, sin
descubrimiento automático), y `FsmModule` exporta la instancia justo para que los módulos de nodos
escriban sobre la misma que consume `FsmEngineService`.

### 4.5 Namespaces: quién escribe el resultado

`TemplateMapperStrategy` **no llama a `setNamespace`**. Devuelve

```typescript
{ success: true, data: { compiled_markup: string, mapped_at: string } }
```

y es `FsmEngineService` quien lo deposita en el `outputNamespace` declarado por el nodo. Escribir
también desde la estrategia duplicaría el payload en dos namespaces (`params.outputNamespace` y
`node.outputNamespace`) y contradiría el contrato de `INodeStrategy`, donde el contexto es de solo
lectura para la estrategia.

### 4.6 Esquema

```sql
-- plantillas_html, tras la migracion 008
id_plantilla         UUID PK DEFAULT uuid_generate_v4()
nombre               VARCHAR(120) NOT NULL   -- idx unico idx_plantillas_html_nombre
descripcion          VARCHAR(255)
contenido_html       TEXT NOT NULL
variables_esperadas  JSONB NOT NULL DEFAULT '[]'::jsonb
id_usuario_creador   UUID NOT NULL REFERENCES usuarios(id_usuario)
activo               BOOLEAN NOT NULL DEFAULT TRUE
fecha_creacion       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
fecha_actualizacion  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### 4.7 Severidad de los fallos del nodo

Todos los fallos son `GRAVE`, nunca `URGENTE`: son errores de configuración corregibles, y solo
`GRAVE` entra en la política de reintentos del motor (`canRetry`).

| Situación | `NodeResult` |
|---|---|
| `templateId` ausente | `GRAVE`, `missingFields: ['templateId']` |
| `templateId` inexistente (`NotFoundException` capturada) | `GRAVE` |
| Plantilla con `activo = false` | `GRAVE` |
| Variables del contexto ausentes | `GRAVE`, `missingFields` con **todas** las rutas que faltan |
| Fallo de compilación de Handlebars | `GRAVE` + `stackTrace` |

---

## 5. Frontend: catálogo de plantillas y tríada modular de nodos (PROT-11 · Quasar)

### 5.1 Regla de arquitectura: tríada por tipo de nodo

Fijada en [.claude/rules/frontend-quasar.md](.claude/rules/frontend-quasar.md) §3.1. Cada tipo de
nodo del pipeline se implementa con tres piezas, y ninguna asume el trabajo de otra:

| Pieza | Ruta | Responsabilidad |
|---|---|---|
| Servicio | `src/services/nodes/<node-name>.service.ts` | Única capa que conoce rutas del backend |
| Store | `src/stores/nodes/<node-name>.store.ts` | Estado, validaciones y derivados. Exporta `use<NodeName>Store` |
| Componente | `src/components/nodes/<NodeName>Config.vue` | UI exclusiva. Cero llamadas HTTP |

**Prohibida la nomenclatura ordinal** (`Step1`, `Paso2`): el orden de un nodo es un dato del
`pipeline_schema`, no una propiedad del componente. Acoplarlos impide reordenar un flujo sin
renombrar archivos, y reutilizar un nodo en dos flujos que lo colocan en posiciones distintas.

### 5.2 Contrato del componente de nodo

```typescript
// Prop obligatoria de todo <NodeName>Config.vue
interface Props { nodeId: string }

// Getter obligatorio de todo store de nodo. Es lo UNICO que el anfitrion
// consulta para decidir si el flujo puede avanzar; nunca inspecciona la
// `config` interna del nodo.
const isConfigValid: ComputedRef<boolean>;
```

### 5.3 Registro y resolución polimórfica

```typescript
// src/components/nodes/node-config-registry.ts
export const nodeConfigRegistry: Partial<Record<NodeType, Component>> = {
  [NodeType.MAPEADOR_PLANTILLA]: defineAsyncComponent(
    () => import('@components/nodes/TemplateMapperConfig.vue'),
  ),
};
```

El anfitrión monta con `<component :is="nodeConfigRegistry[node.nodeType]" />`. Añadir un tipo de
nodo es añadir una entrada; el anfitrión no cambia. `Partial` es deliberado: los tipos aún sin
implementar simplemente no están, y el anfitrión debe contemplar el `undefined`. Cuando existan los
siete, el `Partial` cae y el compilador exigirá cobertura total.

El campo es **`nodeType`** (inglés, camelCase), como en `PipelineNodeConfigDto`. `tipo_nodo` es el
nombre de la columna SQL y no aparece en el JSON del esquema ni en el frontend.

### 5.4 Reparto de estado con `useFlujoDraftStore`

`useFlujoDraftStore` deja de guardar los campos de cada nodo y pasa a **agregador**: posee la
topología del flujo (orden, `nextStep`, `onErrorStep`), el autosave, y ensambla el `pipeline_schema`
leyendo la `config` de cada store de nodo. Duplicar ahí el estado de un nodo crearía dos fuentes de
verdad que se desincronizan en cuanto el usuario retrocede un paso.

### 5.5 Cadena de capas del catálogo

```
TemplatesManager.vue --> useTemplatesStore --> templates.service.ts --> /templates
TemplateMapperConfig.vue --> useTemplateMapperStore --> nodes/template-mapper.service.ts
                                                              |
                                                    delega en templates.service.ts
```

El servicio del nodo **delega** en `templates.service.ts` en vez de reescribir las rutas: el nodo
consume el mismo recurso que el gestor, y duplicar las URLs crearía dos sitios que actualizar. Lo que
aporta ese archivo es el vocabulario del nodo (`fetchSelectableTemplates`, `compilePreview`).

### 5.6 Endpoint de previsualización (`POST /templates/:id/preview`)

```typescript
// TemplateRendererService — un solo motor, dos consumidores
renderStrict(htmlContent: string, requiredVariables: readonly string[],
             namespaces: RenderNamespaces): RenderOutcome;

type RenderOutcome =
  | { markup: string }
  | { missingFields: string[] }
  | { failure: string; stackTrace?: string };
```

Consumido por `TemplateMapperStrategy` (lo traduce a `NodeResult`) y por `TemplatesService.previewTemplate`
(lo traduce a respuesta HTTP). Con dos implementaciones de Handlebars, la vista previa podría
divergir del render real y mentirle al editor sobre lo que se va a publicar.

El backend autogenera marcadores `«namespace.campo»` a partir de `requiredVariables` y fusiona encima
el `samplePayload` del cliente: la vista previa nunca falla por falta de datos, y donde el cliente
aporte valores reales se ven esos.

### 5.7 Poka-Yoke aplicado

| Mecanismo | Dónde | Qué previene |
|---|---|---|
| Chips de namespace | `TemplateEditorDialog.vue` | Teclear un namespace inexistente: se elige de la lista blanca y se inserta en el cursor |
| `<q-select>` cerrado | `TemplateMapperConfig.vue` | Escribir un UUID de plantilla a mano |
| Validación de `outputNamespace` | `useTemplateMapperStore` | Un 400 al guardar el flujo entero por un guion en el namespace |
| `SafeDeleteModal` (5 s) | `TemplatesManager.vue` | Desactivar una plantilla por reflejo |
| `<iframe sandbox>` | `TemplatePreviewDialog.vue` | Ejecutar el `<script>` de una plantilla en el origen de la sesión |

### 5.8 Editor de plantillas: CodeMirror 6 y borrador en Pinia

Refactor de `TemplateEditorDialog.vue` en tres capas con responsabilidades disjuntas:

```
TemplateEditorDialog.vue          orquesta el modal (split view 35/65) y el guardado
  │  ref imperativo                v-model + eventos
  ▼                                     ▼
TemplateCodeEditor.vue            useTemplatesStore (activeDraft)
  aisla toda la API de CodeMirror   buffer, cursor espejo, getters derivados
```

#### Contrato del hijo

```typescript
// TemplateCodeEditor.vue
interface Props { modelValue: string }
emits: { 'update:modelValue': [value: string]; cursorChange: [position: number] }
defineExpose({ insertTextAtCursor: (text: string, cursorOffset?: number) => void })
```

Es lo único que el diálogo conoce del editor. `@codemirror/*` no se importa en ningún otro archivo:
cambiar de motor de edición no toca el diálogo ni el store.

#### Estado del borrador (`templates.store.ts`)

| Miembro | Tipo | Nota |
|---|---|---|
| `activeDraft` | `TemplateDraft` | `{ name, description?, htmlContent }`. **Uno solo por app** |
| `cursorPosition` | `number` | **Espejo** del cursor de CodeMirror, que es quien manda |
| `isDraftValid` | `computed<boolean>` | Nombre y HTML no vacíos; gobierna el botón Guardar |
| `detectedVariables` | `computed<string[]>` | Rutas detectadas, deduplicadas y en orden de aparición |
| `initDraft(template?)` | acción | Omite la clave `description` si la entidad trae `null` |
| `insertMarker(namespace)` | acción | **Solo fallback** si el editor aún no montó |

`detectedVariables` usa el mismo patrón que el backend, índice `.[0]` incluido. Detecta la **forma**,
no la lista blanca: `{{contacto.telefono}}` aparece en los chips y aun así el backend lo rechaza con
un `400` — el gestor de plantillas sigue siendo la única autoridad sobre qué namespaces existen.

#### Quién gobierna el cursor

**CodeMirror.** El chip despacha `insertTextAtCursor('{{ns.}}', -2)` sobre el `EditorView`; la
transacción emite `update:modelValue` y el store se sincroniza solo. Insertar además desde el store
duplicaría el texto, y empalmar strings allí reconstruiría el documento entero y perdería el caret.

Una sola transacción mueve texto y cursor a la vez, así que `Ctrl+Z` deshace la inserción completa.

#### Tema y resaltado

Un único `HighlightStyle` y un `EditorView.theme()` construidos sobre custom properties `--pd-*`. Como
esos tokens conmutan solos con `body--dark`, el editor sigue el tema sin reconfigurar extensiones ni
observar `$q.dark`. Tokens nuevos: `--pd-accent-soft` (chip de marcador) y `--pd-accent-selection`.

#### Pruebas

Primer runner del frontend: **Vitest 4** con `vitest.config.ts` propio (replica los alias de
`quasar.config.ts`, que Vitest no lee). `src/stores/templates.store.spec.ts` cubre 19 casos del
borrador sin entorno DOM ni red, mockeando `@services/templates.service`.

---

## 6. Blindaje XSS y contrato de namespaces

### 6.1 Sanitización del markup compilado

`TemplateRendererService` sanea con `sanitize-html` el resultado **ya interpolado**. Dos barreras
independientes, y ninguna cubre lo que cubre la otra:

| Barrera | Protege de | Alcance |
|---|---|---|
| Escapado `{{ }}` de Handlebars | Los **valores** del contexto (la respuesta del nodo de IA) | Ya existía |
| `TEMPLATE_SANITIZER_CONFIG` | El **HTML de la plantilla**, que escribe un editor y se compila crudo | Nuevo |
| `<iframe sandbox>` en la vista previa | Al **operador** de Proto-Do | Ya existía; no protege al lector del artículo |

Puntos no evidentes de la configuración:

- **`nonTextTags` se declara completo**: `['script','style','textarea','option','xmp','iframe']`.
  Declararlo **sustituye** la lista por defecto de la librería, y su propio código advierte que
  omitir `xmp` reabre un bypass XSS. `iframe` se añade porque `disallowedTagsMode: 'discard'` por sí
  solo quita la etiqueta pero **conserva su texto**.
- **`transformTags.a`** fuerza `rel="noopener noreferrer"` en los `target="_blank"`, contra el
  *tabnabbing*.
- **`allowedTags`** cubre cuerpo de artículo, no estructura de página: `section`, `article`,
  `header`, `footer`, `nav` y `main` quedan fuera a propósito.

### 6.2 Detección al guardar

`TemplatesService.assertPublishableMarkup` rechaza con un `400` la plantilla cuyo markup no
sobreviviría al saneado. No es lo que impide publicar un `<script>` —de eso ya se encarga el render—
sino lo que impide que el autor se entere tarde.

`sanitize-html` no informa de lo que elimina, y comparar contra el HTML crudo daría falsos positivos
porque el parser normaliza igualmente (`<br>` → `<br />`). La comparación válida es entre **dos
pasadas del mismo parser**, una con lista blanca y otra sin ella:

```typescript
inspectPublishableMarkup(html): { sanitized: string; wasFiltered: boolean }
// sanitizeHtml(html, TEMPLATE_SANITIZER_CONFIG) !== sanitizeHtml(html, PUBLISHABLE_MARKUP_PROBE_CONFIG)
```

Ambas configuraciones aplican **el mismo `transformTags`**: sin eso, un `<a target="_blank">`
legítimo se rechazaría, porque la estricta le *añade* el `rel` y la permisiva no — una diferencia por
adición, no por eliminación.

### 6.3 Contrato de namespaces del nodo mapeador

```typescript
// stores/nodes/template-mapper.store.ts
availableUpstreamNamespaces: string[]        // lo que aportan los nodos previos
missingRequiredVariables: computed<string[]> // rutas cuya RAIZ nadie produce
isConfigValid: computed<boolean>             // + templateId + outputNamespace valido
```

Tercera condición de `isConfigValid`: `missingRequiredVariables.length === 0`. Si la plantilla exige
`{{scraped_web.headline}}` y ningún nodo anterior escribe `scraped_web`, la ejecución fallaría con un
`GRAVE` y el flujo quedaría `PAUSADO`. Detectarlo al configurar es la diferencia entre corregirlo
ahora o descubrirlo en producción.

`availableUpstreamNamespaces` es **provisional**: la fuente real son los `outputNamespace` de los
nodos anteriores del `pipeline_schema`, que el asistente (PROT-12) inyectará con
`setAvailableUpstreamNamespaces`. Hasta entonces lo manipula el banco de pruebas con checkboxes.

### 6.4 Filtro de las tablas administrativas

`filter` + slot `#top-right` con `.pd-search-input` en los tres gestores, usando el `filterMethod`
por defecto de QTable. El ref se tipa `string | null` porque el botón `clearable` escribe `null`, y
QTable declara su prop `filter` como `any`: el compilador no delataría la mentira.

---

## 7. Diagnóstico visual de marcado no permitido

### 7.1 Contrato `TemplateViolation`

```typescript
// backend/src/modules/templates/dto/template-violation.dto.ts
export type ViolationType = 'tag' | 'attribute' | 'protocol' | 'variable';

export interface TemplateViolation {
  readonly target: string;   // texto a localizar en el documento
  readonly type: ViolationType;
  readonly message: string;  // listo para el tooltip del editor
}
```

Es un contrato de **salida** —viaja dentro del cuerpo de un `BadRequestException`, nunca entra por
una petición—, de ahí que sea una `interface` sin decoradores, a diferencia de los tres DTOs de
entrada de esa carpeta.

**Invariante de `target`, y de ella depende todo el resaltado:**

| Tipo | Forma de `target` | Ejemplo | Cómo lo busca el editor |
|---|---|---|---|
| `tag`, `attribute`, `protocol` | Identificador normalizado en **minúsculas** | `body`, `onerror`, `javascript:` | Patrón estructural, insensible a mayúsculas |
| `variable` | Subcadena **verbatim** del documento, espacios incluidos | `{{ bad_ns.titulo }}`, `{{{` | Búsqueda literal |

Sin esa distinción el frontend tendría que adivinar cómo localizar cada caso. Por eso el emisor del
tipo `variable` pasa el **match completo del regex** y no `invalidVariable`, que va sin llaves y con
la ruta ya normalizada: sería un texto que no existe en el documento.

Como no hay ningún `ExceptionFilter` en el backend, Nest devuelve el payload objeto tal cual y el
cliente recibe `{ message, violations, … }` en la raíz del cuerpo, sin `statusCode` ni `error`.

### 7.2 La sonda es la puerta; la auditoría, el localizador

`inspectPublishableMarkup` (§6.2) sigue decidiendo **si** se rechaza.
`auditPublishableMarkup(html): TemplateViolation[]` solo añade **dónde**.

Las dos coexisten porque cubren cosas distintas: reducir la puerta a las reglas de la auditoría
—etiqueta, atributo, protocolo— perdería cobertura, ya que la sonda compara el saneador entero y es
exhaustiva por construcción. Si alguna vez la sonda filtrase algo que la auditoría no sabe localizar,
`violations` sale vacío y el 400 se comporta como antes: se rechaza sin subrayar.

La auditoría **deriva de `TEMPLATE_SANITIZER_CONFIG`** (`allowedTags`, `allowedAttributes`,
`allowedSchemes`) en lugar de declarar su propia lista blanca. Con dos listas, añadir `section` al
saneador dejaría al auditor marcándolo para siempre, y el autor recibiría un 400 por algo que en
realidad se publica.

`TemplateRendererService` **sigue sin lanzar**: es un servicio puro que devuelve datos. La
`BadRequestException` la construye `TemplatesService`, que es quien conoce el transporte.

### 7.3 Elección de parser: por qué no vale ninguno de los dos modos de parse5

```typescript
cheerio.load(html, { xml: { xmlMode: false } }, false)  // -> htmlparser2
```

| Configuración | `<body><p>Hola</p></body>` | `<p>ok</p>` |
|---|---|---|
| `load(html, null, false)` — fragmento parse5 | `p` — **`<body>` descartado** | `p` |
| `load(html, null, true)` — documento parse5 | `html head body p` | `html head body p` — **sintetizados** |
| `load(html, { xml: { xmlMode: false } }, false)` | `body p` | `p` |

En modo fragmento parse5 descarta `<body>`, `<html>` y `<head>` por ser inválidos en ese contexto, y
la infracción se vuelve **indetectable**; en modo documento los sintetiza en cualquier entrada y
marcaría el 100 % de las plantillas. htmlparser2 conserva el árbol tal y como se escribió.

`xml` como **objeto** y no `xml: true`: basta con que sea truthy para elegir htmlparser2, pero `true`
activa además el modo XML, que es sensible a mayúsculas y dejaría `<BODY>` como `BODY`, fuera de la
lista blanca.

Beneficio de segundo orden: htmlparser2 es el parser que ya usa `sanitize-html`, así que auditor y
saneador ven **un único DOM** en vez de dos que podrían discrepar.

La guarda de estrechamiento del nodo comprueba `'tagName' in element` y **no**
`element.type === 'tag'`: domhandler etiqueta `<script>` y `<style>` con tipo propio, y esa
comparación dejaría fuera justo las dos etiquetas más peligrosas.

### 7.4 Localización en el editor (`src/utils/violation-matcher.ts`)

Helper puro, fuera del SFC, porque su fallo sería silencioso —subrayar de menos o de más no rompe
nada visible— y desde `src/utils/` sí se puede probar de forma aislada.

Un `indexOf(target)` daría falsos positivos constantes. Cada tipo lleva su frontera:

| Tipo | Patrón | Descarta |
|---|---|---|
| `tag` | `` /<\/?TARGET(?=[\s/>]|$)/gi `` | `<pre>` para el tag `p`; «body» en texto; `&lt;body&gt;` |
| `attribute` | `` /(?<![\w-])TARGET(?=\s*=)/gi `` | `data-onerror=`; el nombre suelto sin `=` |
| `protocol` | `/TARGET/gi` | — |
| `variable` | literal, sensible a mayúsculas | — (es verbatim, §7.1) |

`TARGET` pasa siempre por un escapador de metacaracteres: `{`, `[`, `]` y `.` son sintaxis de
`RegExp`, y un `{{{` sin escapar es un cuantificador inválido.

Se resuelve contra el **texto** y no contra el árbol de sintaxis: el backend devuelve identificadores,
no posiciones, porque el HTML que parseó es el que se envió y no necesariamente el que hay ahora en
pantalla. Los rangos se devuelven ordenados por posición, como exige CodeMirror.

---

## 8. Despacho manual del pipeline (Camino B) y namespace sintético `_assets`

### 8.1 Por qué un endpoint y no un script

El runner `npm run test:fsm:manual` ya ejercitaba el motor, pero desde dentro del proceso: registra
estrategias *dummy* a mano y no pasa por guards, DTOs ni serialización HTTP. El Camino B cierra el
hueco que quedaba entre «el bucle funciona» y «el sistema funciona»: `POST /api/workflows/:id/run-test`
recorre la cadena completa —perímetro de red, JWT, RBAC, `ParseUUIDPipe`, `ValidationPipe`,
`PipelineValidatorService`, `FsmEngineService`, `TemplateMapperStrategy`— sin depender de que llegue
un correo al buzón IMAP. El disparador es lo único que se sustituye; todo lo demás es el camino real.

### 8.2 Namespace sintético `_assets`

| Pieza | Responsabilidad |
|---|---|
| `ASSETS_BASE_URL` (`.env`) | Prefijo absoluto de recursos estáticos |
| `TemplateRendererService.assetsBaseUrl` | Lo resuelve **una vez** en el constructor, sin barra final |
| `renderStrict()` | Fusiona `_assets: { base_url }` sobre los namespaces del contexto |
| `ALLOWED_NAMESPACES` | Lo admite como namespace válido de plantilla |

`_assets` es el único namespace de la lista blanca que **ningún nodo produce**: lo aporta el entorno.
Sin él, una plantilla tendría que incrustar el host (`<img src="http://cms.interno/uploads/…">`) y
migrar de dominio obligaría a reescribir todas las plantillas guardadas.

Tres decisiones que no son de gusto:

1. **Se fusiona al final** (`{ ...sanitized, _assets: {…} }`). Un nodo que escribiera en `_assets`
   podría redirigir todas las imágenes del artículo a un dominio ajeno; así su valor se descarta.
2. **El guion bajo inicial no es cosmético.** `OUTPUT_NAMESPACE_PATTERN` (`/^[a-z0-9_]+$/` con inicio
   alfanumérico en la práctica) describe namespaces de nodo; el prefijo `_` marca a simple vista que
   este no lo es. Y sigue cabiendo en `TEMPLATE_VARIABLE_PATTERN`, que ya aceptaba `[a-zA-Z0-9_]+`
   como raíz: **no hubo que tocar la gramática del gestor**.
3. **Va antes del pre-chequeo de variables.** `{{_assets.base_url}}` figura en `requiredVariables` de
   la plantilla; comprobar las rutas contra el contexto *crudo* lo reportaría siempre como ausente y
   el nodo fallaría con un `missingFields` imposible de corregir.

### 8.3 Normalización temprana de rutas

`{{_assets.base_url}}/{{parsed_email.image_path}}` produce `…/uploads//2026/09/foto.jpg` si el nodo
parseador entrega la ruta con barra inicial. No rompe la petición, pero cambia la URL canónica del
recurso y ensucia la trazabilidad. El recorte **no puede vivir en la plantilla**: el gestor prohíbe
los helpers de Handlebars (`security-and-scope.md` §3), así que no hay dónde escribir la
transformación en el marcado.

Se normaliza en `renderStrict()`, y **solo en los campos cuya clave es una ruta**
(`ASSET_PATH_KEY_PATTERN = /(?:^|_)path$/`: `image_path`, `path`, `file_path`, `thumbnail_path`).
Recortar la barra inicial de *cualquier* cadena corrompería datos legítimos —un `clean_body` que
arranque con `/`, un `source_url` relativo—, que es un fallo silencioso mucho peor que una doble
barra visible. El recorrido es de un nivel: bajar recursivamente obligaría a clonar en profundidad
todo el contexto en cada render, y las rutas de asset que el pipeline produce viven en la raíz del
namespace de su nodo.

### 8.4 Concurrencia (RNF-09): dos capas, una sola verdad

```
FsmEngineService.createExecution()      →  count(EN_PROCESO) ≥ cupo  →  409 ConflictException
        ↓ (fila INACTIVO creada)
FsmEngineService.executeWorkflow()      →  UPDATE estado = 'EN_PROCESO'
        ↓
PostgreSQL: idx_flujo_activo (UNIQUE PARTIAL WHERE estado = 'EN_PROCESO')   ← barrera real
```

La guarda de `createExecution` **no es atómica** y no pretende serlo: entre el `count` y el `UPDATE`
hay una ventana. La barrera real es el índice único parcial, que ya existía desde PROT-08 y funciona
incluso con varios procesos. Lo que aporta la capa de aplicación es el **diagnóstico**: un 409 con
`«el flujo X ya tiene 1/1 ejecución(es) EN_PROCESO»` en vez de un 500 por violación de unicidad.

`MAX_CONCURRENT_EXECUTIONS_PER_FLOW` por defecto vale 1, que es exactamente lo que impone el índice.
Subirlo no levanta el límite: solo cambia un 409 limpio por un fallo de integridad referencial. Está
declarada porque la restricción es de negocio y merece nombre, no para que se toque a la ligera.

Sin bandera de forzado, a propósito: dos bucles sobre el mismo flujo se pisarían el checkpoint y el
segundo publicaría con un contexto a medias.

### 8.5 Entidad `Workflow`: dónde vive el estado

`@Entity('flujos')` mapea la tabla que ya define `init.sql`, con propiedades en inglés y columnas en
español (igual que `User`, `RefreshToken` y `FsmExecution`).

La frontera importante: esta entidad describe la **plantilla del trabajo** —topología y habilitación—,
nunca su ciclo de vida. El `currentState` (`INACTIVO`, `EN_PROCESO`, `PAUSADO`, `EXITOSO`, `FALLIDO`)
vive **exclusivamente** en `FsmExecution`, porque un flujo acumula muchas ejecuciones históricas y
una columna de estado aquí solo podría reflejar una de ellas. `activo` es otra cosa: significa «este
flujo se puede disparar automáticamente», no «se está ejecutando».

`configuracion_pipeline` es *nullable* porque el asistente guarda el flujo antes de terminar de
configurar sus nodos. `WorkflowsService` lo convierte en un **400 y no un 404**: el flujo existe, lo
que falta es completar el asistente.

### 8.6 Reparto de responsabilidades del endpoint

```
WorkflowsController  →  guards + ParseUUIDPipe + DTO           (transporte)
WorkflowsService     →  buscar, validar, crear, ejecutar        (orquestación)
PipelineValidatorService  →  forma, tipos y topología del grafo (Poka-Yoke)
FsmEngineService     →  cupo de concurrencia + recorrido        (motor)
```

`WorkflowsService` no reimplementa nada: su único trabajo propio es traducir el checkpoint final al
DTO de respuesta. **No captura excepciones**: el filtro global de Nest ya traduce `NotFoundException`
a 404, `BadRequestException` a 400 y `ConflictException` a 409, que es literalmente el contrato del
endpoint.

El esquema se **revalida en cada disparo** aunque ya pasara el validador al guardarse: la columna
JSONB se puede haber escrito por SQL directo, y el motor da por hecho un grafo íntegro para
recorrerlo sin defensas en cada paso.

El módulo importa `FsmModule` y **no** `NodesModule`: las estrategias se inscriben solas en la
instancia compartida de `NodeStrategyFactory` cuando `AppModule` levanta `NodesModule`. Acoplarlo a
los nodos obligaría a editar este módulo cada vez que se añada un tipo, que es justo lo que la
factoría evita.

### 8.7 `HttpStatus.OK` y no 201

La petición es **síncrona**: no retorna hasta que el motor alcanza un estado terminal. El recurso que
le interesa al cliente no es la fila creada en `ejecuciones_flujo`, sino el *resultado* del recorrido,
que viaja en el mismo cuerpo. Un flujo que queda `PAUSADO` tampoco es un error HTTP: es un 200 con
`finalState: "PAUSADO"` y el `activeCursor` del nodo culpable, que es lo que permite el reintento
manual de CU-09.

---

## 9. Entrega de archivos estáticos (`ServeStaticModule`)

### 9.1 Dónde vive el directorio, y por qué

```
backend/
├── src/          ← se compila a dist/ y se limpia en cada build
├── dist/
└── static/
    └── uploads/  ← rootPath, resuelto con process.cwd()
```

| Ubicación | Por qué no |
|---|---|
| `backend/src/static/` | `nest build` compila `src/` → `dist/` y lo limpia; los binarios se perderían y ensuciarían el árbol de TypeScript |
| `Pro-ToDo/uploads/` | La entrega de archivos es infraestructura del backend; sacarla rompe el desacoplamiento del monolito modular |
| `backend/static/uploads/` | ✅ Raíz del entorno de ejecución de Node (`process.cwd()`), mapeable como volumen Docker, aislable en `.gitignore` |

`process.cwd()` y **no** `__dirname`: el módulo se ejecuta desde `src/` en desarrollo y desde `dist/`
en producción, así que una ruta relativa al archivo apuntaría a dos sitios distintos.

### 9.2 El prefijo HTTP no pasa por `setGlobalPrefix`

`ServeStaticModule` registra sus rutas con `httpAdapter.useStaticAssets()`, a nivel de Express y
**fuera del router de Nest**. Consecuencias, ambas verificadas contra el servidor en marcha:

1. `serveRoot: '/static/uploads'` responde en esa ruta literal, sin el `/api` global. Es el mismo
   motivo por el que Swagger vive en `/api/docs` y no en `/api/api/docs`.
2. **El `IpWhitelistGuard` global no las alcanza.** Una petición con `X-Forwarded-For` fuera del rango
   corporativo recibe 403 en `/api/templates` y en `/api/docs`, pero **200** en `/static/uploads/…`.
   `main.ts` ya documenta y resuelve este mismo caso para Swagger montando `RedLocalMiddleware` a
   mano; aquí queda **sin aplicar y anotado**, porque cerrar el perímetro cambia quién puede
   descargar las imágenes de un artículo publicado y esa es una decisión de despliegue, no técnica.

### 9.3 Contrato con `ASSETS_BASE_URL`

```
ASSETS_BASE_URL = http://localhost:3000/static/uploads
                  └── host:PORT ──┘└── serveRoot ────┘
```

Las dos mitades tienen dueños distintos y ninguna vive en las plantillas guardadas: el host y el
puerto salen de `.env`, la cola del `serveRoot` de `AppModule`. Mover los estáticos a un CDN es
cambiar **una sola variable**, sin tocar una sola fila de `plantillas_html`. Ese es justo el motivo
de que `_assets` sea un namespace sintético y no texto incrustado en el HTML (§8.2).

### 9.4 Endurecimiento

`index: false` y `redirect: false`: una petición a un directorio debe ser 404, nunca un listado del
contenido del servidor ni un `index.html` implícito. Los *dotfiles* los ignora la librería por
defecto, así que `.gitkeep` tampoco se sirve. El *path traversal* lo bloquea Express, tanto
codificado (`..%2f`) como literal (`--path-as-is`).

El alcance se detiene aquí: **referenciar y servir**. Sin subida, sin recorte, sin compresión y sin
edición gráfica (`security-and-scope.md` §3). Los archivos los prepara el operador.

---

## 10. Nodo de ingesta `TRIGGER_IMAP` y sondeo periódico (PROT-12)

Rama: `feat/trigger-imap`.

Primera estrategia **productora** del motor. Hasta ahora el pipeline solo se podía disparar a mano
(Camino B, §8) sembrando el contexto por HTTP; `DummyInputStrategy` ocupaba el hueco de
`NodeType.TRIGGER_IMAP` devolviendo sus propios `params`. Este nodo lo sustituye con la ingesta real.

### 10.1 Contrato de `ImapTriggerConfigDto`

Primer DTO de configuración de nodo del proyecto: fija el patrón para `PARSER_PRE_IA`, `PROCESADOR_IA`
y los que vengan. Los `params` de un nodo dejan de ser un `Record<string, unknown>` inspeccionado a
mano y pasan a validarse con `class-validator`.

| Campo | Obligatorio | Default | Validación |
|---|---|---|---|
| `host` | sí | — | `@IsString` `@IsNotEmpty` |
| `port` | no | `993` | `@IsInt` `@IsPositive` `@Max(65535)` |
| `secure` | no | `true` | `@IsBoolean` |
| `user` | sí | — | `@IsString` `@IsNotEmpty` |
| `passwordEnvKey` | sí | — | `@IsString` `@IsNotEmpty` `@Matches(/^IMAP_[A-Z0-9_]*PASSWORD$/)` |
| `mailbox` | no | `'INBOX'` | `@IsString` `@IsNotEmpty` |
| `pollIntervalMs` | no | `60000` | `@IsInt` `@IsPositive` `@Min(30000)` |
| `outputNamespace` | no | `'raw_email'` | `@Matches(OUTPUT_NAMESPACE_PATTERN)` |
| `markAsRead` | no | `true` | `@IsBoolean` |

No existe campo `password`. Los defaults **no** se aplican con inicializadores de propiedad —no
actuarían sin `exposeDefaultValues`— sino en la función pura `resolveImapConfig`, único punto que
conoce la cadena de `??` y compartido por la estrategia y el sondeo.

### 10.2 Modelo de seguridad híbrido

```
flujos.configuracion_pipeline (JSONB)          backend/.env
└── params                                     └── IMAP_PASSWORD=········
    ├── host, port, secure, user                        ▲
    ├── mailbox, markAsRead, pollIntervalMs             │ ConfigService.get(passwordEnvKey)
    └── passwordEnvKey: "IMAP_PASSWORD" ────────────────┘
```

El nodo guarda el **nombre** de la variable, nunca su valor. `params` se persiste en una columna JSONB
y viaja al editor de flujos del frontend, así que un secreto ahí quedaría en claro en la base de datos
y expuesto al cliente (`security-and-scope.md` §0.1).

`passwordEnvKey` está restringido por patrón a claves `IMAP_*PASSWORD`, y **eso es una barrera de
seguridad, no una validación cosmética**: `params` es editable por un rol EDITOR desde el asistente.
Sin la restricción, un editor podría declarar `host: imap.atacante.com` junto a
`passwordEnvKey: JWT_SECRET` y el backend enviaría el secreto de firma de tokens como contraseña IMAP
a un servidor ajeno. Queda pendiente restringir también `host` a una lista blanca de dominios.

### 10.3 Payload del namespace de salida

Namespace por defecto: **`raw_email`**, que ya está reservado en `ALLOWED_NAMESPACES` para el correo
crudo. No confundir con el `nodeId` del nodo, que es una clave de topología: un nodo `trigger_imap`
escribe en el namespace `raw_email`.

```jsonc
{
  "message_id": "<abc-123@unuware.com>",
  "from":       "prensa@unuware.com",   // dirección plana, no el AddressObject
  "subject":    "Innovacion en Madrid",
  "text":       "…",                    // solo la parte text/plain del MIME
  "date":       "2026-03-01T10:30:00.000Z"
}
```

Cinco claves, todas `string`, nunca `undefined`. La restricción viene del contexto:
`StatePayloadContext` clona con `structuredClone` en entrada y salida, así que un `Date`, un `Buffer` o
un objeto de librería no sobrevivirían intactos al checkpoint JSONB. Un correo sin cuerpo produce
cadena vacía para que una plantilla que interpole la clave no falle por variable ausente.

**Ninguna clave de marcado.** El HTML del correo no se propaga: arrastraría estilos en línea, imágenes
incrustadas como `data:` URI y etiquetas del cliente remitente, y el marcado final lo aporta la
plantilla del gestor, no el correo de origen. `PARSER_PRE_IA` trabaja sobre texto para ahorrar tokens.
Consecuencia a tener presente al configurar un flujo: un correo que llegue **solo en HTML**, sin parte
`text/plain`, dejará `text` vacío — derivar texto del marcado sería sanitizar, y eso es competencia del
escudo pre-IA, no del nodo de ingesta (`security-and-scope.md` §3).

Cuando el buzón no tiene mensajes nuevos, el nodo devuelve `{ status: 'NO_MESSAGES_FOUND' }` con
`success: true`: el sondeo corre cada minuto y encontrar el buzón vacío es el caso **normal**, no un
fallo que deba dejar el flujo PAUSADO varias veces por hora.

### 10.4 Topología del disparo

```
ImapPollingService (@nestjs/schedule)
  │  SchedulerRegistry.addInterval('imap-poll:<flowId>', pollIntervalMs)
  │
  ├─ STATUS(mailbox, {unseen})          ← solo DETECTA: no abre el buzón,
  │    └─ unseen === 0 → fin              no descarga, no toca banderas
  │
  └─ WorkflowsService.runAutomaticWorkflow(flowId)
       ├─ exige flujos.activo = true
       ├─ PipelineValidatorService.validateSchema
       ├─ FsmEngineService.createExecution(flowId, {})   ← sin initialPayload
       └─ FsmEngineService.executeWorkflow
            └─ ImapTriggerStrategy.execute()  ← LEE, parsea y marca \Seen
                 └─ NodeResult.data → context.setNamespace(node.outputNamespace, …)
```

**Un solo lector del buzón.** El sondeo detecta y la estrategia consume. Si el sondeo leyera el
mensaje, habría dos rutas compitiendo por marcar `\Seen` y el nodo del pipeline encontraría el buzón
vacío justo después de que el sondeo lo hubiera vaciado. Como el sondeo no consume nada, un 409 de
concurrencia (RNF-09) no pierde el correo: sigue `UNSEEN` y el ciclo siguiente lo recoge.

Se usan intervalos dinámicos de `SchedulerRegistry` y no el decorador `@Cron` porque `pollIntervalMs`
es un parámetro **por nodo**, y un decorador se evalúa una sola vez en tiempo de clase.

### 10.5 Dos interruptores en serie

| Interruptor | Alcance | Motivo |
|---|---|---|
| `IMAP_POLLING_ENABLED` (`.env`) | Global | Arrancar el backend en una máquina de desarrollo no debe consumir el buzón real: la estrategia marca `\Seen`. Se exige el valor exacto `'true'`, para que el fallo por omisión sea "no sondea" |
| `flujos.activo` | Por flujo | La columna existe precisamente para gobernar los disparadores automáticos; el despacho manual la ignora a propósito |

### 10.6 Comprobación de conectividad del asistente (`WizardController`)

`POST /api/wizard/check-imap` valida las credenciales de un nodo **antes** de guardar el
`pipeline_schema`, para que el operador no descubra que el buzón está mal configurado la primera vez
que el sondeo dispare el flujo en producción. Es la contrapartida servidor del Poka-Yoke de la interfaz.

| Pieza | Responsabilidad |
|---|---|
| `WizardController` | Superficie HTTP. Guards de clase (`JwtAuthGuard`, `RolesGuard`), roles ADMIN y EDITOR |
| `WizardService.checkImap` | Resuelve el secreto, conecta, comprueba que el buzón existe y traduce el resultado |
| `createImapClient` | Compartido con la estrategia y el sondeo: las opciones endurecidas no pueden divergir |

Cuatro decisiones:

1. **Reutiliza `ImapTriggerConfigDto`**, no un contrato propio. Si el asistente validase con reglas
   distintas de las que aplica la estrategia, una configuración podría pasar la comprobación y fallar
   en la ejecución — justo lo contrario de lo que aporta el paso.
2. **`ValidationPipe` local con `forbidNonWhitelisted`.** El pipe global de `main.ts` solo lleva
   `{ whitelist: true, transform: true }`, que **elimina en silencio** las propiedades desconocidas.
   Aquí hace falta que las **rechace**: un cliente que envíe `password` en el cuerpo debe recibir un
   400, no un 200 tras haberse descartado el campo sin decir nada.
3. **Comprueba conexión *y* buzón** (`connect` + `status`). Un `Conexión exitosa` que solo garantice el
   login sería un falso positivo cuando el `mailbox` no existe.
4. **Un fallo de conexión es 200 con `success: false`**, no un 4xx. El diagnóstico del servidor de
   correo forma parte de la respuesta que el asistente debe mostrar; el 400 queda para un cuerpo mal
   formado. La respuesta **no** incluye `stackTrace`: revelaría rutas del servidor y no aporta nada a
   quien rellena un formulario. Al `.log` físico sigue yendo completa.

**Por qué el patrón de `passwordEnvKey` importa aún más aquí.** Este endpoint acepta un `host` y un
`user` arbitrarios, lo que lo convierte en un oráculo de conectividad: sin la restricción
`IMAP_*PASSWORD`, cualquiera con rol EDITOR podría pedir al backend que enviase `JWT_SECRET` a un
servidor propio y confirmar el acierto leyendo el `success` de la respuesta. Las tres barreras
—perímetro de red, JWT+RBAC y el patrón del DTO— son las que hacen que el endpoint sea publicable.

---

## 11. Seguimiento de PROT-12.3 / PROT-12.4 (Wizard + nodo TRIGGER_IMAP en Quasar)

Rama: `feat/trigger-imap`. Fuente de verdad del avance de esta tanda; el detalle de cada paso queda en
`Walkthrough.md`. Los pasos 4, 8 y 12 son fronteras de commit: cada uno cierra un submódulo que pasa
pruebas y lint de forma aislada.

- [x] 1. Backend — DTO `pipeline-summary-response.dto.ts` (sin `params`)
- [x] 2. Backend — `WorkflowsService.findSelectablePipelines()` con recorrido `entrypoint` → `nextStep`
- [x] 3. Backend — `@Get()` en `WorkflowsController`
- [x] 4. Backend — pruebas en `workflows.service.spec.ts` ⇒ verificación + commit
- [x] 5. Frontend — tipos `PipelineStep`, `PipelineSummary`, `WizardStep`
- [x] 6. Frontend — `pipelines.service.ts` y `nodes/trigger-imap.service.ts`
- [x] 7. Frontend — `stores/nodes/trigger-imap.store.ts`
- [x] 8. Frontend — `trigger-imap.store.spec.ts` ⇒ verificación + commit
- [x] 9. Frontend — `TriggerImapConfig.vue` + entrada en `node-config-registry.ts`
- [x] 10. Frontend — `node-store-registry.ts`
- [x] 11. Frontend — `stores/flujo-draft.store.ts`
- [x] 12. Frontend — `flujo-draft.store.spec.ts` ⇒ verificación + commit
- [x] 13. Frontend — `PipelineSelector.vue`, `WizardPage.vue`, ruta, breadcrumb y drawer
- [x] 14. Cierre — verificación completa de ambos lados y commit final

---

## 12. Cierre de PROT-12: persistencia del flujo y conexión de namespaces

Rama: `feat/trigger-imap`. Cierra los tres pendientes que dejó anotados `Walkthrough.md`.

- [x] 1. Backend — `CreateWorkflowDto` (delegando la validación del grafo en `PipelineValidatorService`)
- [x] 2. Backend — `WorkflowsService.createWorkflow()` + `toPipelineSummary()` compartido
- [x] 3. Backend — `@Post()` en `WorkflowsController` con autoría desde el token
- [x] 4. Backend — reconciliación periódica en `ImapPollingService` (evita el ciclo de módulos)
- [x] 5. Backend — pruebas de alta y de reconciliación ⇒ verificación + commit
- [x] 6. Frontend — `workflows.service.ts` con `createWorkflow()`
- [x] 7. Frontend — contrato `NodeConfigStore` ampliado (`toNodeParams`, `setAvailableUpstreamNamespaces`)
- [x] 8. Frontend — `assembleAndSaveWorkflow()` y `syncUpstreamNamespaces()` en el draft store
- [x] 9. Frontend — pruebas del ensamblado ⇒ verificación + commit
- [x] 10. Frontend — paso terminal de revisión y guardado en `WizardPage.vue`
- [x] 11. Cierre — verificación completa y commit final

---

## 13. Correcciones arquitectónicas post-PROT-12 (capas, `.env` y aislamiento por nodo)

Rama: `feat/trigger-imap`. Tres frentes de corrección más un hallazgo de DI del desarrollador. Ninguno
es funcionalidad nueva.

- [x] 0. Backend — `ConfigService` como import de valor en `ImapPollingService` (DI roto en arranque real)
- [x] 1. Frontend — mover `node-store-registry.ts` de `components/nodes/` a `stores/nodes/`
- [x] 2. Backend — reducir la sección IMAP de `.env.example` al secreto referenciado
- [x] 3a. Frontend — factoría de store por `nodeId` en los dos stores de nodo + contrato y registro
- [x] 3b. Frontend — propagación del `nodeId` y limpieza de stores en `resetDraft` / `selectPipeline`
- [x] 3c. Frontend — `nodeId` capturado en los dos configuradores y en el banco de pruebas
- [x] 3d. Frontend — pruebas adaptadas + bloque `10. Aislamiento de la configuracion por nodo`
- [x] 4. Cierre — verificación completa de ambos lados y commit final

**Nota sobre el objetivo 3 tal como se reportó.** No existía la mutación destructiva descrita:
`assemblePipelineSchema` construye un diccionario `nodes` local y nuevo en cada llamada, lo puebla por
llave recorriendo la topología completa, y `nextStep` ya apunta al `nodeId` siguiente — invariante que
la prueba 8.3 fijaba ya en verde. Lo que sí producía pérdida de configuración eran dos defectos
adyacentes: la identidad del store por `nodeType` en vez de por `nodeId`, y un `resetDraft()` que no
limpiaba los stores de nodo. Son esos los que se corrigen.

---

## 14. Estandarización de `refresh_tokens` → `tokens_sesion`

Rama: `feat/trigger-imap`. Renombrado de la última tabla que no seguía la nomenclatura castellana del
esquema. Alcance limitado a la capa de base de datos.

- [x] 1. `init.sql`: tabla, PK e índice
- [x] 2. `db/migrations/009-tokens-sesion.sql` con los seis renombrados e idempotencia
- [x] 3. Nota de obsolescencia en las cabeceras de las migraciones 001 y 004
- [x] 4. Entidad: `@Entity`, `@PrimaryGeneratedColumn({ name })`, `@Index`
- [x] 5. Comentarios del servicio y de la interfaz del payload JWT
- [x] 6. `PLAN.md` §2.6 y entrada en `Walkthrough.md`
- [x] 7. Verificación (`npm test`, `tsc`, `eslint`) y commit

**Sin cambios de código en inglés ni en el frontend.** La clase `RefreshToken`, los archivos
`refresh-token.{entity,service,dto}.ts`, `POST /auth/refresh` y el campo `refreshToken` se conservan:
`code-conventions.md` §1 exige identificadores en inglés, y tocar la ruta o el campo invalidaría las
sesiones guardadas en `localStorage`.

- [ ] **Aplicar `db/migrations/009-tokens-sesion.sql`** — la ejecuta el usuario. Hasta entonces el
      backend no arranca contra la base existente: la entidad ya apunta a `tokens_sesion`.

---

## 15. Separación entre Plantillas de Pipeline (`plantillas_flujo`) y Flujos Operativos

Rama: `feat/trigger-imap`. Introduce el catálogo de blueprints, la relación instancia → maestro y las
tres vistas que la separación exige. Cierra el pendiente «sin endpoint para activar un flujo».

- [x] 1. Esquema y entidades — migración 010, `init.sql`, `WorkflowTemplate`, relación en `Workflow`, helper `pipeline-topology.util.ts`
- [x] 2. Módulo `WorkflowTemplates` — DTOs, servicio, controlador, módulo y pruebas
- [x] 3. Flujos — `templateId` en el alta, `updateWorkflow` y `PATCH /api/workflows/:id`
- [x] 4. Frontend — tipos, servicios, tres stores, tres vistas, router, layout y pruebas

**Nomenclatura:** identificadores en inglés (`WorkflowTemplate`, `WorkflowTemplatesModule`, ruta
`/api/workflow-templates`) y esquema en castellano, según `code-conventions.md` §1. PK
`id_plantilla_flujo` y no `id_plantilla`, que ya es la de `plantillas_html`. La columna JSONB se llama
`configuracion_pipeline`, igual que en `flujos`: mismo concepto, mismo nombre.

- [ ] **Aplicar `db/migrations/010-plantillas-flujo.sql`** — la ejecuta el usuario.

---

## 16. Unificación del control de estado con el CRUD de usuarios (CU-10)

Rama: `feat/trigger-imap`. Sustituye el `q-toggle` de `/flujos` y `/plantillas-flujo` por el patrón de
botón que ya usa la tabla de usuarios.

- [x] 1. Columna Estado: `q-toggle` → `q-badge` (`pd-badge--active` / `pd-badge--inactive`), como en usuarios
- [x] 2. Botonera: par excluyente `pd-btn-icon--danger`/`block` y `pd-btn-icon--positive`/`check_circle`
- [x] 3. `activateWorkflow` / `activateTemplate` mutan directo; desactivar solo vía `SafeDeleteModal`
- [x] 4. Retirado el `q-toggle` del editor de plantillas (`UserDialog.vue` tampoco expone `isActive`)
- [x] 5. Pruebas 3.7 y 3.8 en `workflow-templates.store.spec.ts` ⇒ `npm test` + `vue-tsc` en verde

**Referencia del patrón:** `frontend/src/components/users/UsersManager.vue`, columna de acciones
(`requestDeactivation` + `activateUser`). Se replican clases, iconos, `outline dense size="sm"`,
`aria-label` y tooltip.

---

## 17. Catálogo de nodos, plantillas inactivas y ensamblador secuencial

Rama: `feat/trigger-imap`. Cuatro frentes independientes más el protocolo de cierre de sesión.

### 17.1 Contratos nuevos

```typescript
// @modules/nodes/entities/node-catalog.entity.ts — tabla `nodos` (catálogo de TIPOS)
@Entity('nodos')
export class NodeCatalogEntry {
  id: string;            // id_nodo   (UUID, PK)
  code: string;          // codigo    (VARCHAR(50), UNIQUE) — replica NodeType
  name: string;          // nombre
  category: NodeCategory;// categoria (enum_categoria)
  description: string | null;
  uiSchema: Record<string, unknown>; // ui_schema (jsonb, NOT NULL DEFAULT '{}')
}

// @modules/nodes/dto/node-catalog-response.dto.ts
export class NodeCatalogResponseDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: NodeCategory;
  readonly description: string | null;
  readonly uiSchema: Record<string, unknown>;
  /** `false` si el tipo NO tiene INodeStrategy: el selector lo deshabilita. */
  readonly implemented: boolean;
}

// frontend/src/utils/pipeline-assembler.ts — helper PURO, dos anfitriones
export const assemblePipelineSchema:
  (steps: readonly AssemblerStep[], meta: AssemblerMeta) => AssembledPipelineSchema;
export const disassemblePipelineSchema:
  (schema: AssembledPipelineSchema) => AssemblerStep[];
```

### 17.2 Inyección de dependencias

```
NodesModule
  ├── TypeOrmModule.forFeature([Workflow, NodeCatalogEntry])
  ├── NodeCatalogService ◄── Repository<NodeCatalogEntry>
  └── NodeCatalogController (PRIMER controlador del módulo)
        └── @UseGuards(JwtAuthGuard, RolesGuard) + @Roles(ADMIN, EDITOR)
```

### 17.3 Estado de las tareas

- [x] 1. SQL — `init.sql` y `011`: PK `id_nodo`, `logs_nodo.id_nodo VARCHAR(50)` sin FK, constraints sin prefijo (`id_nodo`, `nodos_codigo`, `id_log_nodo`, `id_ejecucion`)
- [x] 2. Backend plantillas — `?includeInactive`, `active` en el DTO, `update()` conmuta estado, specs de servicio y controlador
- [x] 3. Frontend plantillas — servicio, store, tabla con badge y botón «Activar»
- [x] 4. Navegación — `<q-item>` a `/flujos/nuevo` y `exact` en `/flujos`
- [x] 5. Backend `GET /api/nodos` — entidad, enum, DTO, servicio, controlador y spec
- [x] 6. Frontend ensamblador — tipos, servicio, store, `pipeline-assembler` (+ refactor de `flujo-draft.store`), `NodeSequenceBuilder.vue`, diálogo
- [x] 7. Verificación — `npm test` 517/517, `vue-tsc` limpio, `vitest` 210/210, ESLint limpio en lo tocado

**Nomenclatura de constraints:** el nombre de la columna, sin prefijos. La excepción es la UNIQUE de
`codigo`, que se llama `nodos_codigo`: una `UNIQUE` crea un índice homónimo y los índices comparten un
único espacio de nombres por esquema, así que `codigo` a secas bloquearía ese nombre para cualquier
otra tabla con esa columna.

**Sin `fk_logs_nodo_id_nodo`:** `nodos` es el catálogo de TIPOS y `logs_nodo.id_nodo` guarda el
`nodeId` de la INSTANCIA (texto libre del JSONB), que no existe como fila del catálogo. Una FK ahí
rechazaría todos los inserts. Antes de la 011 ese par de nombres sí era una clave ajena; el comentario
de la tabla lo advierte para que nadie lo dé por supuesto.

- [ ] **Aplicar `db/migrations/011-catalogo-nodos.sql`** — la ejecuta el usuario. Verificada contra la
      base real en transacción revertida, incluida una doble pasada (idempotente).

---

## 18. Periodo de sondeo por entorno y captura de errores catastróficos (URGENTE → FALLIDO)

Rama: `feat/trigger-imap`.

### 18.1 Contratos nuevos

```typescript
// @common/services/hybrid-logger.service.ts — persistencia híbrida (§4)
export interface CatastrophicFailureDetails {
  readonly executionId: string;
  readonly flowId: string;
  readonly nodeId: string | null;
  readonly level: NodeErrorSeverity;
  readonly message: string;
  readonly stackTrace?: string | undefined;
  readonly payload: Record<string, Record<string, unknown>>;
}

export class HybridLoggerService {
  /** Vuelca a disco y DEVUELVE la ruta. Nunca lanza; `null` si no pudo escribir. */
  public logCatastrophicFailure(d: CatastrophicFailureDetails): string | null;
}

// @core/fsm/services/fsm-engine.service.ts — clasificación del desenlace
interface NodeOutcome {
  /** NO se deduce de `result.error.level`: catastrófico es que la estrategia LANCE. */
  readonly catastrophic: boolean;
  readonly result: NodeResult;
}
```

### 18.2 Frontera dominio / catastrófico

| Origen | Clasificación | Estado final |
|---|---|---|
| `NodeResult{success:false}` devuelto (cualquier `level`, URGENTE incluido) | Dominio | `PAUSADO` |
| `StrategyNotFoundException` lanzada | Dominio (configuración) | `PAUSADO` |
| `HttpException` lanzada (timeout, validación de `params`) | Dominio | `PAUSADO` |
| Cualquier otro `throw` (`TypeError`, `QueryFailedError`, `Error`) | **Catastrófico** | **`FALLIDO`** |

El discriminante es **lanzar frente a devolver**, no el `level`. Una estrategia que devuelve
`URGENTE` controlaba la situación y lo comunicó; una que lanza se rompió y el motor no sabe qué dejó
a medias. Fundir ambos casos convertiría en terminal un flujo que hoy se reanuda con CU-09.

Un desenlace catastrófico **no reintenta** (aunque el nodo declare `retryPolicy`) y **no sigue
`onErrorStep`**: esa ruta es una decisión sobre fallos previstos.

### 18.3 Estado de las tareas

- [x] 1. `IMAP_POLLING_INTERVAL_MS` (+ `IMAP_RECONCILE_INTERVAL_MS`, que faltaba) en `.env.example`
- [x] 2. `ImapPollingService`: periodo por defecto desde entorno, con suelo `MIN_POLL_INTERVAL_MS`
- [x] 3. `HybridLoggerService` nuevo (Winston + rotación diaria) y registrado en `CommonModule`
- [x] 4. `FsmExecution.logFilePath` ⇒ columna `ruta_archivo_log`, que ya existía en el esquema
- [x] 5. Motor: `NodeOutcome`, `toDomainFailure()`, `failCatastrophically()` y volcado en el catch externo
- [x] 6. Pruebas: 537/537 en 31 suites; `nest build` en verde

**Sin migración SQL**: `ejecuciones_flujo.ruta_archivo_log VARCHAR(255)` ya estaba en `init.sql`;
la entidad solo la mapeaba a medias. Verificado contra la base real.

**El decorador `@Interval()` ya no existía**: el servicio usaba `SchedulerRegistry.addInterval()`
desde la entrega del diffing de intervalos. Lo que faltaba era el valor por defecto de instalación.

---

## 19. Homologación del marcado de errores en CodeMirror

Rama: `feat/trigger-imap`.

### 19.1 Contrato nuevo

```typescript
// frontend/src/utils/json-syntax-locator.ts — helper PURO
export interface SyntaxErrorRange { from: number; to: number; message: string }

/** Lo que el helper necesita de `view.state.doc`, por forma estructural. */
export interface DocumentLines {
  readonly lines: number;
  readonly length: number;
  readonly line: (lineNumber: number) => { from: number; to: number };
}

/** `null` si el texto parsea. */
export const locateJsonSyntaxError:
  (doc: string, lines: DocumentLines) => SyntaxErrorRange | null;

// frontend/src/utils/codemirror-theme.ts
export const unuwareEditorTheme: Extension;   // antes duplicado byte a byte
```

### 19.2 Precedencia de diagnósticos

Un **único** punto de despacho (`refreshDiagnostics`), porque `setDiagnostics`
reemplaza la lista entera del estado: dos llamadas separadas se pisan.

| Estado del documento | Qué se marca |
|---|---|
| No parsea | **Solo** el error de sintaxis; los `issues` del backend se descartan |
| Parsea | Los `issues` del backend, resueltos por `json-path-locator` |
| Cambia el texto | Se **recalcula** la sintaxis; los `issues` no se reinyectan |

### 19.3 Estado de las tareas

- [x] 1. `json-syntax-locator.ts` (+ spec, 9 casos) con las cuatro formas reales de `SyntaxError` de V8
- [x] 2. `codemirror-theme.ts`: tema extraído y consumido por los dos editores
- [x] 3. `JsonPipelinePreview.vue`: origen local y remoto unificados en un despacho
- [x] 4. `changeListener` pasa de limpiar a recalcular; despacho diferido con `queueMicrotask`
- [x] 5. Verificación: `vue-tsc` limpio, vitest 219/219, ESLint y Prettier limpios

**Fuera de alcance, anotado:** `props.readonly` se aplica una sola vez en el montaje
(`EditorView.editable.of()`), sin `Compartment` ni `watch`, así que cambiarlo en caliente no tiene
efecto. Hoy no se manifiesta porque los dos anfitriones pasan un literal estático.

---

## 20. Parada inmediata del sondeo y saneado de ejecuciones huérfanas

Rama: `feat/trigger-imap`.

Al desactivar un flujo quedaban dos residuos: el `setInterval` del sondeo IMAP seguía vivo en
`SchedulerRegistry` con su configuración capturada en la clausura, y las filas de
`ejecuciones_flujo` en `EN_PROCESO` / `PAUSADO` se quedaban ahí para siempre. La primera es una
fuga acotada —el diffing de `refreshSchedules` la retira en el siguiente ciclo, hasta 60 s
después—; la segunda no se resuelve sola, y una `EN_PROCESO` huérfana reserva el mutex parcial
`idx_flujo_activo`, de modo que el flujo **no podría volver a arrancar nunca** si se reactiva.

### 20.1 Contrato nuevo

```typescript
// @common/services/flow-polling.coordinator.ts
export interface FlowPollingPort {
  stopPollingForFlow(flowId: string): void;
  refreshPolling(): Promise<void>;
}

@Injectable()
export class FlowPollingCoordinator {
  register(port: FlowPollingPort): void;
  unregister(): void;
  stopPollingForFlow(flowId: string): void;   // no-op sin puerto; nunca propaga
  refreshPolling(): Promise<void>;            // idem
}

// ImapPollingService — implementación del puerto
public stopPollingForFlow(flowId: string): void;

// FsmEngineService — integridad de la FSM
public abortExecutionsForFlow(flowId: string, reason: string): Promise<number>;
```

### 20.2 Diagrama de inyección: por qué un puerto y no `forwardRef`

```
NodesModule ──importa──> WorkflowsModule        (ya existía: el sondeo despacha)
     │                          │
     │ register()               │ inyecta
     v                          v
        CommonModule (@Global) · FlowPollingCoordinator
```

`WorkflowsService` no puede inyectar `ImapPollingService`: `NodesModule` ya importa
`WorkflowsModule` y la flecha inversa cerraría el ciclo. El coordinador vive en `CommonModule`
—global, y ya alojaba `HybridLoggerService` por el mismo criterio de infraestructura
transversal—, así que el dominio habla contra una interfaz y el implementador se inscribe
hacia arriba. El grafo de módulos sigue siendo acíclico.

El registro ocurre **solo si `IMAP_POLLING_ENABLED === 'true'`**: con el sondeo deshabilitado no
hay nada que parar, y sobre todo un `refreshPolling()` externo no debe poder inscribir
temporizadores que ningún ciclo de reconciliación mantiene.

### 20.3 Cancelación cooperativa (por qué el UPDATE solo no basta)

`abortExecutionsForFlow` tiene dos mitades. El `UPDATE` masivo cierra las filas, pero un bucle
vivo **en este proceso** volvería a escribir sobre la suya en el siguiente `saveCheckpoint` y la
resucitaría a `EN_PROCESO`. Por eso los `executionId` en `EN_PROCESO` se marcan además en un
`Map` en memoria que el `while` de `executeWorkflow` consulta en **dos** puntos:

| Punto | Por qué hace falta |
|---|---|
| Primera sentencia del `while` | Aborto llegado mientras se escribía el checkpoint anterior; corta antes del circuit breaker |
| Tras el `for(;;)` de reintentos, antes de `outcome.catastrophic` | Aborto llegado **mientras el nodo corría**, que es donde el bucle pasa casi todo su tiempo. Sin este punto, la rama de éxito escribiría `EN_PROCESO` y la fila volvería a reservar el mutex |

Solo se marcan las `EN_PROCESO`: una `PAUSADO` es, por definición, una ejecución cuyo bucle ya
terminó, y dejar su identificador en el mapa sería una fuga que nadie limpiaría.

### 20.4 Esquema

```sql
-- db/migrations/012-motivo-fallo-ejecucion.sql
ALTER TABLE ejecuciones_flujo
    ADD COLUMN IF NOT EXISTS motivo_fallo VARCHAR(255);
```

Replicada en el `CREATE TABLE` de `init.sql` para los volúmenes vacíos. Es un **prerrequisito
duro**: con `synchronize: false`, en cuanto `FsmExecution` declara `failureReason` TypeORM
enumera la columna en todo `SELECT` de la entidad, así que entidad y migración se despliegan
juntas o el motor revienta al arrancar.

### 20.5 Estado de las tareas

- [x] 1. `FlowPollingCoordinator` + `FlowPollingPort` en `CommonModule` (@Global)
- [x] 2. `ImapPollingService.stopPollingForFlow`, auto-registro y baja en `onModuleDestroy`
- [x] 3. Migración 012 + `FsmExecution.failureReason` + `init.sql`
- [x] 4. `FsmEngineService.abortExecutionsForFlow` con cancelación cooperativa en dos puntos
- [x] 5. `WorkflowsService.updateWorkflow`: limpieza en `true → false`, recarga en `false → true`
- [x] 6. Pruebas: 568/568 en 32 suites (antes 537/31); `nest build` en verde; cero errores de lint nuevos

**Endurecimiento colateral:** la fase de altas de `refreshSchedules` comprueba ahora también
`doesExist('interval', ...)`. Desde que `stopPollingForFlow` es un segundo escritor del par
`scheduled` ↔ `SchedulerRegistry`, dar la invariante por supuesta dejaría un flujo activo y mudo
si alguna vez se desincronizan; ahora el reconcile la repara.

**`dispatchFlow` degrada los `HttpException` del motor a `warn`:** un tick que ya estaba en vuelo
cuando se desactivó el flujo llega con un 400, y antes se registraba como *"falla crítica de
conexión IMAP"* —a nivel `error` y con stack—, acusando al buzón de algo que no había pasado. Se
conserva el mensaje real para que un esquema corrupto siga siendo legible en la traza.

**Fuera de alcance, anotado:** (1) el barrido cierra también las `PAUSADO`, que son la cola de
reintento de CU-09; CU-09 todavía no tiene endpoint, así que hoy no destruye nada usable, pero
conviene revisarlo cuando exista. (2) La cancelación cooperativa es memoria de proceso: cuando
entre BullMQ, un worker de otro proceso seguiría corriendo la ejecución abortada. El arreglo
eventual es un `UPDATE` condicional (`estado <> 'FALLIDO'`) comprobando `affected`.
