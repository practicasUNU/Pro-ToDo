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
  [NodeType.TRIGGER_IMAP]:      defineAsyncComponent(() => import('@components/nodes/TriggerImapConfig.vue')),
  [NodeType.TRIGGER_CRON]:      defineAsyncComponent(() => import('@components/nodes/TriggerCronConfig.vue')),
  [NodeType.PARSER_PRE_IA]:     defineAsyncComponent(() => import('@components/nodes/ParserEmailConfig.vue')),
  [NodeType.MAPEADOR_PLANTILLA]:defineAsyncComponent(() => import('@components/nodes/TemplateMapperConfig.vue')),
};
```

El anfitrión monta con `<component :is="nodeConfigRegistry[node.nodeType]" />`. Añadir un tipo de
nodo es añadir una entrada; el anfitrión no cambia. `Partial` es deliberado: los tipos aún sin
implementar simplemente no están, y el anfitrión debe contemplar el `undefined`. Cuando existan los
ocho, el `Partial` cae y el compilador exigirá cobertura total.

**Son DOS registros, y hacen falta los dos.** `nodeConfigRegistry` resuelve el COMPONENTE;
`src/stores/nodes/node-store-registry.ts` resuelve el STORE que el agregador consulta. Dar de alta
solo el primero deja un nodo que pinta su formulario con normalidad pero que `flujo-draft.store` marca
como `SIN_STORE`: el asistente muestra «Nodo no ejecutable» y `canSave` queda bloqueado para siempre
sin que nada explique por qué. Implementados a 2026-09-18: `TRIGGER_IMAP`, `TRIGGER_CRON`,
`PARSER_PRE_IA` y `MAPEADOR_PLANTILLA`.

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

### 10.7 Banco de pruebas del parser (`POST /api/wizard/check-parser`)

Segundo endpoint del asistente, con el mismo molde que el anterior: `@HttpCode(OK)`, el
`STRICT_VALIDATION` local, guards y roles heredados de la clase, y un fallo del nodo como 200 con
`success: false` en vez de un 4xx. Sanea un correo de prueba y devuelve el payload de doce claves que
el nodo depositaría en `parsed_email`.

**Una sola implementación de la composición.** `ParserEmailStrategy` es `@Injectable` y su
`execute()` exige un `StatePayloadContext`, así que invocarla desde el asistente habría obligado a
importar `NodesModule` —que el TSDoc de `WizardModule` prohíbe— *y además* a fabricar un contexto
falso. Por eso la composición se extrajo a `@modules/nodes/utils/parsed-email-payload.util.ts`
(`buildParsedEmail`, `extractEmailBody`), función pura que consumen la estrategia y el asistente. La
alternativa —duplicarla— habría producido un banco de pruebas que anuncia una reducción que la
ejecución real no produce, y divergirían en la primera corrección.

**Canales de aviso en vez de un `Logger` dentro.** `ParsedEmailHooks` (`onSanitizeFailure`,
`onMultimodalFallback`) es lo que permite que la función siga siendo pura: la estrategia los enchufa
a su logger y el asistente los devuelve al navegador en `warnings`. Es el mismo patrón que
`createImapClient(config, password, onError)`. Efecto útil: el aviso «no se pudo sanear el marcado»,
que en producción solo existe en el `.log` del servidor, aquí se ve.

| Diferencia con `check-imap` | Motivo |
|---|---|
| **Síncrono**, sin `async` | No hay socket ni nada que esperar; una promesa por simetría haría buscar una espera que no existe |
| Topes `@MaxLength` en el cuerpo | `sanitizeEmailHtml` monta un DOM con cheerio, **síncrono y en el único hilo**: un correo de 20 MB sería una denegación de servicio de una sola petición. `MAX_CHECK_PARSER_BODY_CHARS = 50_000`, calibrado **por debajo** del límite de 100 kB de `express.json()` que `main.ts` no eleva, contando el escapado JSON |
| Adjuntos **sin `contentBase64`** | La decisión multimodal solo mira `contentType`; con `forbidNonWhitelisted`, mandar base64 da 400. Una ruta de asistente nunca acepta megabytes |
| `sourceNamespace` **rechazado** | El correo viaja en el cuerpo y no hay contexto del que leer: aceptarlo sería admitir un campo que no hace nada |

**Un HTML impresentable NO es `success: false`.** La estrategia lo degrada a `body_source: 'none'`, y
el asistente reproduce esa decisión exactamente; hacerlo de otro modo sería mentir sobre lo que
ocurrirá en producción. El `success: false` queda reservado a una excepción inesperada.

**Umbral `minBodyLength`: alineación sin relajar el backend.** `ParserEmailConfigDto` conserva
`@IsInt` + `@IsPositive`, que impone exactamente `>= 1`. El frontend replica ese mínimo en
`MIN_BODY_LENGTH = 1` con la regla «El umbral debe ser mayor o igual a 1» y `min="1"` en el campo. Se
descartó relajar el backend a `@Min(0)`: un `0` haría la condición `bodyLength < minBodyLength`
imposible de satisfacer, de modo que `requires_multimodal_fallback` nunca se activaría y un correo
cuyo único contenido es un PDF escaneado pasaría al modelo sin nada que leer. Es el mismo criterio por
el que `trigger-imap.store.ts` replica el `@Min(30000)` en `MIN_POLL_INTERVAL_MS`: sin la copia, el
operador vería un 400 de servidor donde debería haber visto una regla de campo.

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
  // NO hay `uiSchema`: la columna `ui_schema` se retiro en la migracion 020.
  // El formulario de cada tipo lo resuelve el frontend con componentes tipados
  // (`node-config-registry.ts`) y el contrato de SALIDA vive en los
  // `outputFields` de la `INodeStrategy`.
}

// @modules/nodes/dto/node-catalog-response.dto.ts
export class NodeCatalogResponseDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: NodeCategory;
  readonly description: string | null;
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

UPDATE ejecuciones_flujo
   SET estado = 'INACTIVO',
       paso_actual = NULL
 WHERE estado = 'PAUSADO';
```

La columna está replicada en el `CREATE TABLE` de `init.sql` para los volúmenes vacíos. Es un
**prerrequisito duro**: con `synchronize: false`, en cuanto `FsmExecution` declara
`failureReason` TypeORM enumera la columna en todo `SELECT` de la entidad, así que entidad y
migración se despliegan juntas o el motor revienta al arrancar.

El `UPDATE` sanea las ejecuciones residuales. Proceden de la reconciliación de arranque de
`FsmModule` —que pasa a `PAUSADO` todo lo que encuentra `EN_PROCESO` al levantar el proceso—,
y como CU-09 todavía no tiene endpoint, nadie las ha reintentado nunca: son residuo de
reinicios, no una cola de trabajo, y mientras figuren como `PAUSADO` la trazabilidad afirma
que hay reintentos pendientes que no existen.

**Por qué también `paso_actual = NULL`:** el motor arranca con
`execution.activeCursor ?? schema.entrypoint`. Una fila `INACTIVO` que conservara su cursor
reanudaría a media topología en lugar de empezar por el entrypoint — el estado diría "nueva" y
el comportamiento sería "reanudada". No se toca `contexto_acumulado`: es la única evidencia que
queda de lo que esas ejecuciones llegaron a hacer.

**Idempotencia:** el predicado es la guarda. Tras la primera pasada no queda ninguna fila en
`PAUSADO`, así que reejecutar afecta a 0 filas y termina en éxito, sin `IF EXISTS` ni bloque
`DO`. Sigue sin `BEGIN`/`COMMIT` manual, como el resto del directorio (ver la nota de la
migración 006): psql corre en autocommit y las dos sentencias son independientes.

**Restricciones:** esta migración no crea ninguna, así que la regla de nomenclatura —cero
prefijos, la restricción se llama como su columna identificadora (`id_nodo`, `id_log_nodo`,
`id_ejecucion`)— no tiene aquí nada que revalidar.

### 20.5 Estado de las tareas

- [x] 1. `FlowPollingCoordinator` + `FlowPollingPort` en `CommonModule` (@Global)
- [x] 2. `ImapPollingService.stopPollingForFlow`, auto-registro y baja en `onModuleDestroy`
- [x] 3. Migración 012 (`motivo_fallo` + saneado `PAUSADO → INACTIVO`) + `FsmExecution.failureReason` + `init.sql`
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

---

## 21. Ingesta de adjuntos IMAP y liberación de binarios en el motor

### Contrato de datos

`backend/src/modules/nodes/interfaces/raw-email-attachment.interface.ts`

```typescript
export interface RawEmailAttachment {
  readonly filename: string;      // del remitente; NUNCA para construir rutas
  readonly contentType: string;   // def. 'application/octet-stream'
  readonly size: number;          // bytes DECODIFICADOS, no longitud del base64
  contentBase64: string | null;   // mutable: es la palanca de liberación
}

export type RawEmailAttachmentMetadata = Omit<RawEmailAttachment, 'contentBase64'>;
```

Vive en `@modules/nodes` y no en `@core/fsm/types/` porque `@core` no puede depender de
`@modules`: el motor libera el binario de forma **estructural**, por el nombre de la clave,
justamente para no tener que importar esta interfaz.

### Payload de `raw_email` (aditivo)

Las seis claves planas anteriores (`message_id`, `from`, `subject`, `text`, `html`, `date`)
se conservan sin cambios; se añade `attachments: RawEmailAttachment[]`. La clave está
**siempre presente** —`[]` cuando la ingesta está apagada— para que la interpolación nunca
falle por variable ausente. Se descartó la forma anidada (`headers.from`, `raw_html`):
habría roto toda plantilla guardada que interpole `{{raw_email.subject}}`.

### Configuración del nodo `TRIGGER_IMAP`

| Clave | Def. | Regla |
|---|---|---|
| `includeAttachments` | `false` | Opt-in: el coste se paga en cada checkpoint, no donde se ve |
| `maxAttachmentBytes` | `5_242_880` | `@Max(MAX_ATTACHMENT_BYTES_LIMIT)`: solo puede endurecer el tope |

Más dos límites estructurales no configurables: `MAX_TOTAL_ATTACHMENT_BYTES = 10_485_760`
(presupuesto acumulado por correo) y la exclusión de los adjuntos `related` (ya incrustados
como `data:` URI dentro de `html` por `simpleParser`).

### Regla de purga del motor (`FsmEngineService`)

Tras depositar el `data` de un nodo con éxito, y antes de cualquier checkpoint:

```
si algún valor de BINARY_RETENTION_KEYS = ['requires_multimodal_fallback']
   es el booleano true EXACTO
entonces  se conserva el binario                    ← veto, gana sobre el texto
si no, si algún valor de EXTRACTED_TEXT_KEYS = ['clean_body','text','extracted_text']
   es una cadena cuyo trim() alcanza FSM_MIN_USEFUL_TEXT_LENGTH (def. 50)
entonces  raw_email.attachments[*].contentBase64 = null   (metadatos intactos)
si no     se conserva el binario  →  caso multimodal pendiente
```

El binario se conserva **si y solo si** sigue siendo la única fuente de datos. Un correo con
cuerpo textual ve sus adjuntos liberados en el mismo checkpoint que los escribió, así que el
base64 no llega a tocar PostgreSQL; un PDF escaneado los conserva para el nodo multimodal.

**El veto gana sobre el texto, y la asimetría es deliberada.** El texto es la afirmación «el
binario ya sobra»; la bandera es la afirmación contraria, y cuando llegan juntas manda la
conservadora: un binario no liberado pesa unos bytes en una fila, mientras que uno liberado
de más destruye la única copia del dato con el checkpoint ya escrito. No hay vuelta atrás.

**La comparación con `true` es estricta**, y no es celo: el `data` se rehidrata desde una
columna `jsonb`, donde la cadena `"false"` es *truthy*. Un veto que se pudiera levantar por
accidente desactivaría en silencio la política de memoria de toda la plataforma, y nadie lo
notaría hasta ver crecer `contexto_acumulado`.

**El listón de longitud cierra el caso del texto corto.** `TRIGGER_IMAP` emite `text` en su
propio `data` y corre *antes* del parser: sin listón, un `"Ver adjunto."` de doce caracteres
purgaba los bytes del PDF escaneado antes de que ningún nodo pudiera vetarlo, y el veto del
parser llegaba sobre un adjunto ya vacío. `FSM_MIN_USEFUL_TEXT_LENGTH` va calibrado contra el
`minBodyLength` de `PARSER_PRE_IA` (ambos 50): los dos números deben moverse juntos, porque
cualquier hueco entre ellos reabre esa ventana. Un `0` restaura el comportamiento anterior.

`payloadSnapshot` de la traza por nodo recibe el mismo saneado, sustituyendo el base64 por
`[base64 omitido]`: ese volcado va al archivo `execution-*.log`, que rota por tamaño.

| Variable | Uso | Política si falta o no sirve |
|---|---|---|
| `FSM_MIN_USEFUL_TEXT_LENGTH` | Caracteres mínimos para que el texto de un nodo libere el binario | Cae a `50`; se rechaza con `warn` lo que no sea un entero ≥ 0 |

Se resuelve **una sola vez por instancia**, de forma perezosa: un valor mal escrito avisa por
el log la primera vez que importa, no al arrancar el módulo, para que construir el motor no
tenga efectos. El `0` explícito se admite y restaura el comportamiento anterior.

### Nodo `PARSER_PRE_IA`

`ParserEmailStrategy` es un consumidor **puro**: lee `raw_email`, publica en `parsed_email` y
no escribe en ningún namespace ajeno. Artefactos: la estrategia, su DTO
(`parser-email-config.dto.ts`) y las heurísticas de limpieza, que viven aparte como funciones
puras en `src/modules/nodes/utils/email-sanitizer.util.ts`.

Payload de **trece** claves. **El orden es parte del contrato** (la prueba 1.1 lo compara
posicionalmente) y todas están siempre presentes con su tipo:

```typescript
{
  subject: string;                    // asunto crudo, tal cual llegó
  clean_title: string;                // sin prefijos de respuesta/reenvío
  clean_body: string;                 // SIEMPRE cadena; '' = sin texto
  body_source: 'text' | 'html' | 'none';
  character_count: number;            // === clean_body.length
  original_character_count: number;   // longitud de la FUENTE consumida
  reduction_percentage: number;       // 0..100 con dos decimales
  extracted_urls: string[];           // del MARCADO siempre, máx. 50
  attachment_count: number;
  attachments: RawEmailAttachmentMetadata[];   // inventario SIN base64
  extracted_documents_text: string;   // texto NATIVO de los adjuntos, CERO OCR
  requires_multimodal_fallback: boolean;
  multimodal_reason: string;          // '' cuando la bandera es false
}
```

#### Extracción nativa de documentos adjuntos (cero OCR)

`extracted_documents_text` concatena el texto que se saca de cada adjunto legible, con un
separador que nombra el fichero (`--- Documento: nota.pdf ---`) para que un modelo pueda
atribuir cada cifra al documento del que salió. Las heurísticas viven aparte, como funciones
puras, en `src/modules/nodes/utils/document-extractor.util.ts`:

| Tipo MIME | Vía | Librería |
|---|---|---|
| `text/plain`, `text/csv` | `buffer.toString('utf-8')` | ninguna |
| `application/pdf` | texto nativo del PDF | `pdf-parse@1.x` |
| `…wordprocessingml.document` | `extractRawText` | `mammoth` |
| `…spreadsheetml.sheet` | filas aplanadas, celdas por `, ` | `exceljs` |
| `image/*` y cualquier otro | `''` inmediato | ninguna |

**Ni una línea de OCR, por diseño.** Una imagen devuelve cadena vacía sin tocar el búfer, y es
justo esa ausencia de texto la que levanta la bandera multimodal: el respaldo con visión deja
de ser la primera respuesta y pasa a ser la última.

Tres decisiones de contorno:

- **`pdf-parse` en la línea 1.x, no en la 2.x.** La 2.x arrastra `pdfjs-dist` y `@napi-rs/canvas`,
  un módulo NAPI nativo cuya única razón de ser es rasterizar páginas — algo que sin OCR no hace
  falta. La 1.x depende únicamente de `node-ensure`, JS puro. La línea estuvo siete años parada
  (1.1.1 es de 2018) y revivió en octubre de 2025 con la 1.1.4, publicada por el mismo mantenedor
  y el mismo día que la 2.4.5; esa 1.1.4 elimina la dependencia `debug` y el bloque de depuración
  de `index.js` que leía un PDF de prueba del propio paquete.
- **`exceljs` y no `xlsx`.** `xlsx` quedó congelado en npm en la 0.18.5 y `npm audit` lo marca
  **high sin parche disponible** (prototype pollution GHSA-4r6h-8v6p-xvw6 y ReDoS
  GHSA-5pgg-2g8v-p4x9); SheetJS solo publica las correcciones en su propio CDN. En una ruta
  que analiza ficheros de remitentes externos eso no es aceptable. `exceljs` arrastra un aviso
  moderado transitivo por `uuid@8`, cerrado con `"overrides": { "uuid": "^11.1.1" }`.
- **Un CSV no pasa por el analizador de hojas de cálculo.** Ya es texto; leerlo para volver a
  serializarlo como CSV es un viaje de ida y vuelta que solo puede perder información.

Nada de esto lanza. `extractTextFromBuffer` devuelve `{ text, failure }`, y un documento
corrupto sale con `text: ''` y su motivo por el hook `onDocumentFailure`, que la estrategia
enchufa a un `logger.warn('LEVE | …')`. Un adjunto ilegible no puede tumbar la ejecución: el
motor normaliza toda excepción a URGENTE, que `canRetry` nunca reintenta.

#### La regla multimodal, con el texto documental dentro

```
requires_multimodal_fallback =
      (clean_body.length + extracted_documents_text.length) < minBodyLength
  AND  existe ≥ 1 adjunto que cumple LAS TRES:
         · trae contentBase64 utilizable (no null)
         · su extracción salió en blanco
         · su contentType es image/* o application/pdf
```

Las tres condiciones del segundo operando son deliberadas:

1. **`contentBase64` no nulo.** El `null` no es un caso raro: lo pone el motor en cuanto un
   nodo anterior emite texto útil. Un adjunto ya liberado no se puede evaluar, y tratarlo como
   «sin texto» pediría visión sobre bytes que ya no existen.
2. **Extracción en blanco.** Un PDF con texto nativo deja de ser candidato en cuanto se le saca
   el contenido. Ése es el ahorro que persigue el nodo.
3. **Tipo visual.** Un `.docx` corrupto o un `.xlsx` ilegible también devuelven cadena vacía, y
   **no** cuentan: no los arregla un modelo con visión, y retener sus megabytes para una
   llamada que no puede servir sería pagar lo más caro del pipeline por un fichero roto. Salen
   por `onDocumentFailure`, que es donde pertenecen.

#### Efecto sobre la purga de binarios del motor

`extracted_documents_text` se añadió a `EXTRACTED_TEXT_KEYS` en `fsm-engine.service.ts`. Sin
ella, el caso que más pesa —el correo de cuerpo vacío cuyo contenido entero viaja en un PDF—
dejaba `clean_body` vacío, `hasUsefulText` devolvía `false` y los megabytes se quedaban en
`contexto_acumulado` para siempre, **aun habiéndose extraído ya todo su texto**. El veto por
`requires_multimodal_fallback === true` sigue mandando sobre el texto.

`clean_body` dejó de admitir `null`, y no es cosmético: interpolar
`{{parsed_email.clean_body}}` sobre un `null` lanzaba igual que sobre una variable ausente,
mientras que una cadena vacía no lanza. Las plantillas montadas sobre este nodo pasan a ser
seguras por construcción. Para ramificar hay que seguir mirando `body_source`, que es la
clave que explica *por qué* el cuerpo está como está.

#### Pipeline de saneado

El texto plano manda cuando existe —ya es texto, y saltarse el DOM ahorra la operación más
cara del nodo—; el marcado es el plan B del `multipart/alternative` sin parte `text/plain`,
que es el caso habitual de un boletín institucional. En la ruta HTML, trece pasos
deterministas y sin ramas:

1. `cheerio.load(html, { xml: { xmlMode: false } }, false)` — misma invocación que el resto
   del repositorio: htmlparser2 sin modo XML, y modo fragmento para que parse5 no sintetice
   `<html><head><body>`.
2. Borrado del ruido estructural: `script`, `style`, `noscript`, `iframe`, `object`, `embed`,
   `svg`, `head`, `meta`, `link`, `title`, `[aria-hidden]`, `[hidden]`.
3. Marcadores de corte de Outlook (`#appendonsend`, `#divRplyFwdMsg`): se borra el marcador
   **y todo lo que le sigue**, subiendo por los ancestros. No envuelven la cita, la preceden.
4. Contenedores de firma y cita conocidos (`.gmail_signature`, `.moz-cite-prefix`,
   `blockquote[type="cite"]`, `.yahoo_quoted`…).
5. **Recolección de URLs**, sobre el árbol ya podado (ver más abajo por qué aquí).
6. `<br>` → `\n`.
7. `td`/`th` → separador de **espacio**: con `\n` una fila horizontal se volvería columna.
8. Elementos de bloque → `\n` antes y después.
9. `$.root().text()` — htmlparser2 ya decodificó las entidades durante el parseo.
10. `normalizeWhitespace`: CRLF, espacios duros, invisibles, colapso y máximo una línea en
    blanco. **El orden importa**: `&nbsp;` decodifica a U+00A0, que no es un espacio ASCII, y
    si no se convierte antes del colapso el recuento queda inflado con blancos invisibles.
11. Corte de la cadena de cita (`-----Mensaje original-----`, `El … escribió:`, la regla de
    guiones bajos, las cabeceras `De:`/`Enviado el:`) y del delimitador de firma de la
    RFC 3676.
12. Retirada de la **racha final** de párrafos que son aviso legal o pie de cortesía.
13. `trim()`.

**El DOM resuelve la estructura; el regex resuelve la prosa.** `-----Mensaje original-----` y
`El … escribió:` son texto, no marcado, y ningún `blockquote` los envuelve de forma fiable.

Dos guardas impiden que el saneado destruya contenido. La primera: si cortar por una cita
deja la cabeza vacía **no se corta** —un reenvío puro, con el cuerpo vacío y toda la
sustancia dentro de la cita, se quedaría sin nada—. La segunda: el barrido de avisos legales
recorre **desde el final hacia atrás** y se detiene en el primer párrafo que no case o que
supere los 800 caracteres. Esto último es una decisión de producto, no una optimización: el
corpus son notas de prensa institucionales, donde un comunicado puede mencionar el RGPD o la
protección de datos **como contenido**. Barrer todo el cuerpo destruiría justo lo que el nodo
existe para conservar; limitarse a la racha final lo garantiza por construcción.

Se descartaron a propósito las heurísticas de teléfono, dirección y cargo para detectar
firmas: producen falsos positivos garantizados en un corpus donde el último párrafo suele ser
el contacto del gabinete de prensa, y ese contacto a menudo **es** información que el flujo
quiere.

**Por qué `cheerio` y no `@mozilla/readability`**, aunque esté instalado: Readability exige
un `Document` real de jsdom, penaliza las tablas (y un correo de Outlook es,
estructuralmente, tablas anidadas), necesita un `documentURI` que un correo no tiene, y su
sistema de puntuación no es estable entre versiones menores —mientras que este payload es
contrato y tiene que ser reproducible—. Readability y jsdom siguen reservados para
`EXTRACTOR_WEB`, donde sí hay un artículo y sí hay URL base.

#### Política de `extracted_urls`

Se recolectan **antes de podar el DOM**, nada más cargar el marcado. Ese orden se invirtió por
el pipeline Notiweb: un correo **reenviado** lleva su contenido —y con él sus referencias
bibliográficas— dentro del `<blockquote>` que la poda retira, de modo que recogerlos después
los perdía enteros y `EXTRACTOR_WEB` se quedaba sin nada que escrapear.

El precio, asumido: un enlace que vivía en una firma también entra, aunque su texto ya no
aparezca en `clean_body`. **`extracted_urls` deja por tanto de describir el mismo documento
que el cuerpo.** Lo que acota el ruido es el filtrado de `collectUrls`, que no cambió:

- Solo `http:` y `https:`. El consumidor natural es `EXTRACTOR_WEB`, que solo sabe navegar
  http(s); un `mailto:` ahí es una descarga fallida con su reintento y su alerta.
- **Relativas: descartadas.** Un correo no tiene documento base, y absolutizar contra el
  dominio del remitente fabricaría una dirección que puede no existir.
- **Protocol-relative (`//host/ruta`): rescatadas** promoviendo a `https:`. Ahí el host es
  explícito y no se inventa nada.
- Descarte por host: redirectores de campaña (`list-manage.com`, `sendgrid.net`,
  `awstrack.me`, `bit.ly`…) y las cuatro familias sociales pedidas con sus acortadores
  (`twitter.com`, `x.com`, `t.co`, `facebook.com`, `linkedin.com`, `lnkd.in`,
  `instagram.com`…). **YouTube, TikTok, Threads, WhatsApp y Telegram quedan fuera de esa
  lista a propósito**: una nota de prensa que enlaza un vídeo institucional está enlazando
  contenido, y este pipeline es de recorte de prensa.
- Descarte de desuscripción: se mira la ruta y el query **y además el texto del ancla**.
  Muchos boletines esconden el enlace tras un redirector opaco donde la ruta es un
  identificador ilegible y solo el texto («Darse de baja») delata la función.
- Se retiran los parámetros de campaña (`utm_*`, `gclid`, `fbclid`, `mc_cid`…). El motivo es
  operativo: dos enlaces al mismo artículo que solo difieren en `utm_content` sobreviven a la
  deduplicación por `Set`, y `EXTRACTOR_WEB` acabaría pagando **dos navegaciones de
  Playwright** por la misma página. `ref` y `spm` se conservan: hay sitios que los usan para
  enrutar, y quitarlos cambiaría la página que se descarga.
- Tope de `MAX_EXTRACTED_URLS = 50`. Un boletín puede traer trescientos enlaces, y el arreglo
  se reserializa entero en `contexto_acumulado` en cada checkpoint posterior: es el mismo
  argumento de peso que motivó la purga de binarios, a otra escala.

Los enlaces salen **siempre del marcado**, gane quien gane la cascada del cuerpo. Un correo de
Gmail trae parte de texto y parte HTML; la cascada elige el texto —es más barato que el DOM—
pero antes eso dejaba `extracted_urls` vacío en el caso más común. Del texto plano no se
rescata nada, y eso no cambia: ese texto parte las URLs a 78 columnas (RFC 5322) y produciría
direcciones truncadas que `EXTRACTOR_WEB` intentaría descargar y fallaría. El marcado del
MISMO correo las declara enteras en `<a href>`, así que se leen de ahí, vía
`extractEmailUrls`, que se salta el aplanado a texto por innecesario.

Cuando hay marcado y aun así no sale ni un enlace, se emite un aviso **LEVE** no bloqueante
(`onNoUrlsFound`): `extracted_urls` sigue siendo `[]` —nunca `null`—, pero el operador ve en
el log y en el banco de pruebas por qué `EXTRACTOR_WEB` no va a recibir nada. No se avisa en
un correo sin HTML: ahí no hay ningún `<a>` que recoger y el aviso sería ruido constante.

Un `href` que no parsee como URL http(s) se descarta sin más. En particular, `new URL()` lanza
sobre valores como `[https://ejemplo.com](https://ejemplo.com)` —un esquema URI debe empezar
por letra ASCII— y descartarlos es lo correcto: no son navegables. Si aparecen en
`raw_email.html`, el problema está **aguas arriba**, en lo que escribe ese namespace.

#### Métricas de reducción (RNF-01)

> **RNF-01 · Economía de tokens pre-IA.** El nodo `PARSER_PRE_IA` debe reducir **al menos un
> 50 %** los caracteres de un correo HTML realista antes de la llamada al modelo de lenguaje.
> Cada ejecución publica su medida en `parsed_email.reduction_percentage`, de modo que el
> requisito es auditable sobre cualquier checkpoint y no solo en pruebas.
> Verificado por `parser-email.strategy.spec.ts` 9.3, cuyo fixture es un correo de Outlook con
> hoja de estilos, tabla anidada, firma y aviso legal.

Se da de alta aquí, junto a la única implementación que lo cumple, por el mismo criterio con
el que RNF-09 vive en §8.4: un requisito sin el código que lo satisface al lado envejece mal.

`reduction_percentage = round(clamp((original - final) / original, 0, 1) * 10000) / 100`.

Dos guardas: si `original <= 0` devuelve `0` y no `NaN` —`NaN` se serializa a `null` al
escribir el `jsonb` y rompería en silencio la regla de «toda clave presente **con su
tipo**»—, y el resultado va acotado a `[0, 100]` para que un futuro separador que añadiera
texto no deje un porcentaje negativo que nadie sepa leer seis meses después.

`original_character_count` es la longitud de la **fuente consumida**, no la del correo
entero:

| `body_source` | `original_character_count` |
|---|---|
| `'text'` | `raw_email.text.length` |
| `'html'` | `raw_email.html.length` |
| `'none'` | `0` |

La pareja `(original, final)` tiene que ser la entrada y la salida de la **misma**
transformación. Medir siempre contra `html` daría una división por cero en un correo
`text/plain` puro; medir siempre contra `text` daría 0 % en la ruta HTML, que es justo donde
la reducción es del 80-95 % y donde RNF-01 tiene algo que medir. Comparar dos correos con
`body_source` distinto es comparar cosas distintas, y para eso existe esa clave.

Consecuencia de diseño: **la ruta `'text'` dejó de ser un `trim()`**. También pasa por el
corte de citas, firma y pie legal; si no, un `text/plain` con cuarenta líneas de hilo citado
y un aviso de confidencialidad entraría entero al prompt, que es el gasto que el nodo existe
para evitar.

#### Decisión multimodal y errores

`requires_multimodal_fallback` exige **ambas** condiciones: adjunto de tipo imagen o PDF **y**
cuerpo textual por debajo de `minBodyLength` (def. **50**, recalibrado desde 200). El AND
evita gastar una llamada multimodal en un boletín que solo trae su logo en PNG.

El recalibrado no es arbitrario: los 200 originales estaban medidos contra texto **sin
sanear**, donde una firma y un pie legal sumaban solos unos 300 caracteres y casi cualquier
correo superaba el listón por puro ruido. Con el saneador, `clean_body` es texto útil: 50
caracteres son una frase con sujeto y predicado, y un «Adjunto la nota de prensa» (25) se
queda debajo, que es donde tiene que quedarse. Va en sincronía con
`FSM_MIN_USEFUL_TEXT_LENGTH` del motor.

El nodo **no expone las heurísticas como opciones** —no hay `stripSignatures` ni
`filterSocialUrls`—: cada interruptor multiplica las formas posibles del payload histórico,
y un `extracted_urls: []` significaría a veces «no había enlaces» y a veces «alguien apagó la
extracción ese día», sin que ningún checkpoint de hace seis meses pueda distinguirlas. Es el
mismo argumento ya escrito para `attachments: []`. Un flujo que quiera la firma quiere el
correo crudo, y ese sigue intacto en `raw_email`.

Si el saneado del marcado lanzase sobre un correo patológico, el nodo **degrada**: registra
un `warn`, devuelve `body_source: 'none'` y conserva el inventario de adjuntos y la decisión
multimodal. El motor normaliza toda excepción a `URGENTE`, que `canRetry` nunca reintenta; un
correo mal formado no puede llevarse por delante la ejecución entera.

Códigos de fallo: `ERR_PARSER_CONFIG` y `ERR_PARSER_SOURCE_MISSING`, ambos `GRAVE` para que
entren en `canRetry` y el flujo quede PAUSADO y reanudable (CU-09).

#### Artefactos del nodo (a 2026-09-18)

| Capa | Archivo |
|---|---|
| Composición pura | `backend/src/modules/nodes/utils/parsed-email-payload.util.ts` |
| Limpieza de texto | `backend/src/modules/nodes/utils/email-sanitizer.util.ts` |
| Estrategia | `backend/src/modules/nodes/strategies/parser-email.strategy.ts` |
| Configuración | `backend/src/modules/nodes/dto/parser-email-config.dto.ts` |
| Banco de pruebas | `backend/src/modules/wizard/dto/check-parser{,-response}.dto.ts` + `WizardService.checkParser` |
| Tipos del cliente | `frontend/src/types/parser-email.ts` |
| Servicio | `frontend/src/services/nodes/parser-email.service.ts` |
| Store | `frontend/src/stores/nodes/parser-email.store.ts` |
| Componente | `frontend/src/components/nodes/ParserEmailConfig.vue` |

---

## 20. Seguimiento — Tríada frontend de `PARSER_PRE_IA` y endpoint de saneado

Rama: `feat/parser-email-ui`, a partir de `feat/parser-email`. El detalle del «por qué» queda en
`Walkthrough.md`.

- [x] 1. Backend — extraer la composición a `parsed-email-payload.util.ts` (`ParsedEmailPayload`
      exportada, `ParsedEmailHooks`, `extractEmailBody`, `buildParsedEmail`)
- [x] 2. Backend — adelgazar `ParserEmailStrategy` al contrato del nodo, con los hooks al `logger`
- [x] 3. Backend — `parser-email.strategy.spec.ts` en verde **sin tocar una sola aserción** (red de
      regresión de la extracción: 43/43)
- [x] 4. Backend — `check-parser.dto.ts` (`PickType` sobre `minBodyLength`, topes de longitud,
      adjuntos sin `contentBase64`) y `check-parser-response.dto.ts`
- [x] 5. Backend — `WizardService.checkParser()` síncrono y `POST /api/wizard/check-parser`
- [x] 6. Backend — `parsed-email-payload.util.spec.ts` (21), bloque 4 de `wizard.service.spec.ts` (8)
      y `check-parser.dto.spec.ts` (14)
- [x] 7. Frontend — tipos en `src/types/parser-email.ts`
- [x] 8. Frontend — `parser-email.service.ts`
- [x] 9. Frontend — `parser-email.store.ts` memoizado por `nodeId` (`node-parser-email:${nodeId}`)
- [x] 10. Frontend — `ParserEmailConfig.vue` con el campo único y el banco de pruebas
- [x] 11. Frontend — alta en `node-config-registry.ts` **y** en `node-store-registry.ts`
- [x] 12. Frontend — retargeteo de las pruebas 3.3, 16.1 y 16.4 de `flujo-draft.store.spec.ts` a
      `EXTRACTOR_WEB`, más la nueva 16.4.1 que fija el desbloqueo
- [x] 13. Frontend — `NodeConfigSandboxPage.vue` resuelve el store con `resolveNodeStore` y acota
      `inspectedState` al contrato público
- [x] 14. Frontend — `parser-email.store.spec.ts` (25)
- [x] 15. Verificación — backend 40 suites / 913 pruebas; frontend 15 ficheros / 321 pruebas;
      `tsc --noEmit -p tsconfig.build.json`, `vue-tsc --noEmit`, `quasar build` y lint en verde

**Desbloqueo funcional:** hasta esta tanda, cualquier plantilla de flujo que incluyera un
`PARSER_PRE_IA` era **imposible de guardar** — el asistente pintaba «Configurador no disponible» y
`canSave` quedaba en `false` para siempre. La prueba 16.4.1 de `flujo-draft.store.spec.ts` es la que
fija ese cambio.

---

## Tanda actual — Contrato de issues, inventario de salida y selector del EXTRACTOR_WEB

### Contratos nuevos

```typescript
// @core/fsm/types/node-strategy.types.ts — que PRODUCE un nodo
export type NodeOutputFieldType = 'url' | 'url[]' | 'text' | 'number' | 'boolean' | 'object';

export interface NodeOutputField {
  readonly name: string;            // snake_case: asi viaja y asi se interpola
  readonly type: NodeOutputFieldType;
  readonly description?: string;
}

export interface INodeStrategy {
  readonly outputFields?: readonly NodeOutputField[];   // NUEVO
  readonly getRequiredNamespaces?: (params: Record<string, unknown>) => readonly string[];
  // ...
}
```

`outputFields` es la contrapartida de `getRequiredNamespaces`: aquel declara lo que el nodo
**consume**, este lo que **produce**. Es propiedad constante y no metodo porque lo que un nodo
publica depende de su tipo, no de su configuracion. Viaja al frontend por `GET /api/nodos`
(`NodeCatalogResponseDto.outputFields`), resuelto contra la factoria **en cada peticion** — las
estrategias se registran en `onModuleInit`, despues de que el provider se construya.

```typescript
// @stores/nodes/node-store-registry.ts — canal anfitrion -> nodo
export interface UpstreamNamespace {
  readonly namespace: string;
  readonly fields: readonly NodeOutputField[];
}

export interface NodeConfigStore {
  readonly setAvailableUpstreamNamespaces?: (namespaces: string[]) => void;  // ya existia
  readonly setAvailableUpstreamContext?: (context: UpstreamNamespace[]) => void;  // NUEVO
}
```

Los dos canales **conviven**. El mapeador solo pregunta si un namespace existe; el extractor web
tiene que componer `{{namespace.campo}}` y necesita el inventario. `flujo-draft.store` empuja ambos
en `syncUpstreamNamespaces()` y cada store implementa el que usa.

### Dependencias de un nodo: union de dos fuentes

`PipelineValidatorService.resolveNodeDependencies()` pasa a devolver
`getRequiredNamespaces(params) ∪ collectNamespaceRoots(params)`, deduplicado. El segundo canal
—barrido recursivo de las marcas `{{ns.campo}}` en cualquier clave de `params`, con tope de
profundidad— cubre los seis tipos de nodo que no implementan el primero. La regla 7 de
`validatePipelineTopology` no cambia: recibe el resolutor por parametro.

### Checklist

- [x] 1. Backend — `NodeOutputField` / `NodeOutputFieldType` y `INodeStrategy.outputFields`
- [x] 2. Backend — `outputFields` declarados en `ParserEmailStrategy` (13 claves) y
      `WebScraperStrategy` (5)
- [x] 3. Backend — `NodeCatalogResponseDto.outputFields` y `NodeCatalogService.resolveOutputFields()`
- [x] 4. Backend — `collectNamespaceRoots()` en `state-payload.context.ts`, reutilizando
      `extractNamespaceRoots` y su `INTERPOLATION_PATTERN`
- [x] 5. Backend — union de fuentes en `resolveNodeDependencies()`
- [x] 6. Backend — `toIssueContractException()` y su aplicacion en los controladores de flujos,
      plantillas y FSM (causa raiz del crash)
- [x] 7. Frontend — guardas en `locatePath` y `locateJsonPaths`
- [x] 8. Frontend — `NodeOutputField` y `outputFields` replicados en `types/node-catalog.ts`
- [x] 9. Frontend — `UpstreamNamespace` y `setAvailableUpstreamContext` en el contrato del store
- [x] 10. Frontend — `upstreamContext(index)` en el agregador, cruzando topologia y catalogo;
      `fetchCatalog()` en paralelo en los dos cargadores asincronos
- [x] 11. Frontend — `web-scraper.store.ts` sin `URL_SOURCE_NAMESPACE` ni `URL_SOURCE_FIELD`:
      opciones derivadas, `hasStaleTargetUrl`, `isConfigValid` de tres filtros
- [x] 12. Frontend — `WebScraperConfig.vue` con selector deshabilitado y banner reescrito
- [x] 13. Frontend — `NodeConfigSandboxPage.vue` alimenta el canal rico y carga el catalogo
- [x] 14. Verificacion — backend 47 suites / 1089 pruebas; frontend 17 ficheros / 379 pruebas;
      `vue-tsc --noEmit` y lint de ambos lados en verde

### Correccion — El EXTRACTOR_WEB no era expresable en una plantilla

`WebScraperConfigDto.targetUrl` era obligatorio y `PipelineValidatorService` aplica los
`paramsSchema` a plantillas y flujos por igual, asi que un `params: {}` —lo que trae toda
plantilla, que declara topologia y no operativa— disparaba los tres constraints a la vez.
EXTRACTOR_WEB es el unico de los ocho tipos con `paramsSchema`, de ahi que fuera el unico
afectado.

La exigencia se reparte en tres capas, cada una con la informacion que necesita:

```typescript
// 1. DTO — la FORMA de lo que haya. Un nodo AISLADO no sabe quien va delante.
@IsOptional()
@Matches(INTERPOLATION_ONLY_PATTERN)
targetUrl?: string;

// 2. INodeStrategy — dos hooks nuevos
readonly requiredUpstreamFieldTypes?: readonly NodeOutputFieldType[];   // regla 8
readonly getIncompleteParams?: (params) => readonly string[];           // activacion

// 3. Topologia — regla 8, la unica capa que conoce el grafo
validatePipelineTopology(schema, {
  dependencies, outputFields, requiredFieldTypes,   // objeto, no posicionales
});
```

`getRequiredNamespaces` del extractor **deja de caer** a `FALLBACK_SCRAPER_NAMESPACE`
(`'parsed_email'`): era una suposicion que acusaba al operador de un namespace que su esquema
nunca cito, y su propio TSDoc reconocia el precio. La garantia la sostiene ahora la regla 8,
que pregunta si hay DE DONDE sacar una URL en vez de adivinar de cual.

`assertActivatable` pasa `{ requireRunnableParams: true }`: guardar es un borrador, activar es
ponerlo a disparar.

- [x] 15. Backend — `targetUrl` opcional en el DTO, con `@Matches` intacto
- [x] 16. Backend — `requiredUpstreamFieldTypes` y `getIncompleteParams` en `INodeStrategy`,
      declarados por `WebScraperStrategy`; retirado `FALLBACK_SCRAPER_NAMESPACE`
- [x] 17. Backend — regla 8 (`detectMissingUpstreamFieldTypes`) y `PipelineTopologyResolvers`
- [x] 18. Backend — `ValidateSchemaOptions.requireRunnableParams` y su uso en `assertActivatable`
- [x] 19. Backend — guarda de ejecucion: sin `targetUrl`, `ERR_SCRAPER_CONFIG` con el mensaje real
- [x] 20. Frontend — `toNodeParams()` OMITE `targetUrl` vacio en vez de publicar `''`
- [x] 21. Verificacion — backend 47 suites / 1105 pruebas; frontend 17 ficheros / 380 pruebas

---

## Tanda actual — Inventario de salida completo: de 2/5 a 5/5 estrategias

### Por que NO se creo `NODE_OUTPUT_CATALOG` ni `GET /api/fsm/nodes/catalog`

La peticion describia una constante estatica en `src/modules/fsm/constants/` expuesta por un
endpoint nuevo. Se descarta por dos motivos, en este orden:

1. **Ya existe el mecanismo.** `INodeStrategy.outputFields` -> `NodeCatalogService.resolveOutputFields()`
   -> `NodeCatalogResponseDto.outputFields` -> `GET /api/nodos`. El frontend lo consume de punta a
   punta desde la tanda anterior.
2. **Una constante seria una segunda fuente de verdad.** Es el argumento que ya esta escrito en el
   TSDoc del contrato y que no ha cambiado: la lista escrita a mano y el `data` que construye la
   estrategia se desincronizan en cuanto alguien anade una clave, y la que manda en ejecucion es
   siempre la segunda.

`src/modules/fsm/` tampoco existe: el motor es `@core/fsm` y el catalogo `@modules/nodes`.

### Lo que si faltaba

Tres de las cinco estrategias registradas no declaraban su inventario:

| Estrategia | `outputFields` | Tipos |
|---|---|---|
| `CronTriggerStrategy` | `triggered_at`, `cron_expression`, `time_zone`, `next_run_at` | los cuatro `text` |
| `ImapTriggerStrategy` | `message_id`, `from`, `subject`, `text`, `html`, `date`, `attachments` | seis `text` + un `object` |
| `TemplateMapperStrategy` | `compiled_markup`, `mapped_at` | los dos `text` |

Dos invariantes que se declaran por escrito en el TSDoc de cada propiedad:

- **`status` queda fuera del IMAP.** Solo existe en la via del buzon vacio, que devuelve `halt`:
  el motor cierra en EXITOSO y nadie aguas abajo interpola. Declararla prometeria un campo que
  nunca esta cuando hay algo que mapear.
- **Ningun campo del IMAP es `url`.** `html` y `text` contienen enlaces pero no son una direccion;
  extraerlas es trabajo de `PARSER_PRE_IA` (`extracted_urls: url[]`). `TRIGGER_IMAP -> EXTRACTOR_WEB`
  sigue emitiendo `ERR_MISSING_UPSTREAM_FIELD_TYPE`, y ahora por lectura del inventario en vez de
  por ausencia de inventario.

No se toca `NodeOutputFieldType`: `text` es contrato vivo de la regla 8, del store del extractor y
de `frontend/src/types/node-catalog.ts`. Renombrarlo a `string` no compra nada.

### Checklist

- [x] 22. Backend — `outputFields` en `CronTriggerStrategy` (4 claves)
- [x] 23. Backend — `outputFields` en `ImapTriggerStrategy` (7 claves, sin `status`, ninguna `url`)
- [x] 24. Backend — `outputFields` en `TemplateMapperStrategy` (2 claves)
- [x] 25. Backend — prueba de sincronizacion por estrategia: `Object.keys(result.data)` contra los
      `name` declarados, para que anadir una clave sin declararla rompa el spec
- [x] 26. Docs — TSDoc de `ParserEmailStrategy` decia "doce claves" sobre un arreglo de trece
- [x] 27. Verificacion — backend 47 suites / 1114 pruebas; frontend 17 ficheros / 380 pruebas (sin
      cambios); `nest build` en verde
- [x] 28. `DEFAULT_UPSTREAM_NAMESPACES` en `template-mapper.store.ts` — cerrado en la tanda
      siguiente (ver "Selector determinista de variables en el MAPEADOR_PLANTILLA")

---

## Tanda actual — Selector determinista de variables en el MAPEADOR_PLANTILLA

### Por que NO se creo el servicio ni el getter del enunciado

El enunciado pedia `getNodeCatalog()` contra `GET /api/fsm/nodes/catalog` y, en el agregador,
`nodeCatalog` + `fetchNodeCatalog()` + `availableInterpolationVariables(currentNodeId)`. Las tres
ya existen, repartidas donde las reglas las quieren: `node-catalog.service.ts` (contra `GET /nodos`,
que es la ruta real), `node-catalog.store.ts`, y `upstreamContext(stepIndex)` +
`syncUpstreamNamespaces()`, que desde la tanda anterior empuja los dos canales a todos los stores.

Componer las opciones en el agregador ademas lo obligaria a conocer la forma de la configuracion de
un tipo de nodo concreto, que es lo que §3.1 prohibe. El getter va en el store del nodo, como
`buildUrlOptions()` en el extractor web.

### Contrato ampliado

```typescript
// @stores/nodes/node-store-registry.ts
export interface UpstreamNamespace {
  readonly namespace: string;
  readonly nodeType?: NodeType;   // NUEVO; opcional porque `_assets` no lo escribe ningun nodo
  readonly fields: readonly NodeOutputField[];
}

// @stores/nodes/template-mapper.store.ts
export interface InterpolationVariableOption {
  readonly label: string;   // `clean_title (text)`
  readonly value: string;   // `{{parsed_email.clean_title}}`
  readonly group: string;   // `parsed_email (PARSER_PRE_IA)`
}
```

### Las tres reglas de `missingRequiredVariables`

| # | Situacion | Veredicto |
|---|---|---|
| 1 | Ningun paso anterior escribe ese namespace | Falta (ya existia) |
| 2 | El namespace existe y se conoce su inventario, pero no publica ese campo | Falta (**nuevo**) |
| 3 | El namespace existe y llega con `fields: []` | Satisfecha |

La 3 no es una concesion: vacio significa "aun no se que publica" —catalogo viajando, o tipo sin
`outputFields`—, y tratarlo como fallo pintaria de rojo todas las plantillas durante la carga.
Rutas profundas: se juzgan por los dos primeros segmentos, que es lo que el nodo publica.

`isConfigValid` NO incorpora "hay variables disponibles": una plantilla estatica es legitima. De la
ausencia avisa `hasUpstreamVariables`, sin bloquear.

### Checklist

- [x] 29. Frontend — `nodeType` opcional en `UpstreamNamespace`, propagado por `upstreamContext()`
      y por `buildSimulatedContext()` del banco de pruebas
- [x] 30. Frontend — `setAvailableUpstreamContext`, `variableOptions`, `hasUpstreamVariables`,
      `missingUpstreamNamespaces` y `missingUpstreamFields` en `template-mapper.store.ts`;
      retirado `DEFAULT_UPSTREAM_NAMESPACES` (cierra la pendiente 28)
- [x] 31. Frontend — `TemplateMapperConfig.vue`: `outputNamespace` a `q-select` cerrado, selector
      de variables con `use-input` y agrupacion, aviso ambar no bloqueante, banner rojo que
      distingue el fallo de namespace del de campo
- [x] 32. Frontend — `TemplateEditorDialog.vue`: prop opcional `upstreamContext`; con ella los
      chips insertan `{{ns.campo}}` completo con offset 0
- [x] 33. Frontend — `TemplateMapperConfig.spec.ts` (nuevo, 10 pruebas) y 15 pruebas nuevas en el
      spec del store; `flujo-draft.store.spec.ts` actualizado por el `nodeType`
- [x] 34. Verificacion — frontend 18 ficheros / 405 pruebas; `vue-tsc --noEmit` y lint en verde
- [x] 35. Prueba de componente de `TemplateEditorDialog` — cerrada en la tanda siguiente (ver
      "Explorador jerarquico de variables en el editor de plantillas")

---

## Tanda actual — Explorador jerarquico de variables en el editor de plantillas

### El hueco: el backend no valida el campo

`TemplatesService.extractAndValidateVariables` comprueba el NAMESPACE de cada `{{ns.campo}}`
contra `ALLOWED_NAMESPACES` y acepta el resto de la ruta tal cual. Un
`{{parsed_email.clean_bodyy}}` se persiste sin protesta y falla en render con un GRAVE. Los chips
del editor, que insertaban `{{ns.}}` y dejaban al autor escribiendo el campo, eran la via directa a
esa errata.

### Contratos nuevos

```typescript
// @/types/html-template — unico namespace que no sale del catalogo
export const ASSETS_NAMESPACE = '_assets';
export const ASSETS_FIELDS: readonly NodeOutputField[];   // [{ name: 'base_url', type: 'text' }]

// @/utils/upstream-catalog — helpers puros, sin Pinia ni E/S
export const NODE_TYPE_BY_NAMESPACE: Readonly<Record<string, NodeType>>;
export const buildContextForNamespaces: (
  namespaces: readonly string[],
  findByCode: (code: string) => NodeCatalogEntry | null,
) => UpstreamNamespace[];

// @stores/templates.store — fallback sin gramatica propia
insertTextAtCursor(text: string, caretOffset?: number): void;   // insertMarker delega en el
```

### Origen de los datos por anfitrion

| Anfitrion | Origenes ofrecidos |
|---|---|
| `TemplateMapperConfig` | `upstreamContext`: lo que ese flujo publica de verdad |
| `TemplatesManager` | Catalogo global: los ocho namespaces mas `_assets` |

La prop gana porque es la respuesta mas especifica. El catalogo se pide con
`nodeCatalogStore.fetchCatalog()` AL ABRIR el dialogo (memoizada), no en `onMounted`.

No se creo `getNodeCatalog()` en `templates.service.ts`: la ruta del enunciado
(`GET /api/fsm/nodes/catalog`) no existe y `node-catalog.service.ts` ya consume la real.
Tampoco se alcanza el `EditorView`: `insertTextAtCursor` del editor ya despacha esa transaccion, y
la vista es privada a proposito.

### Checklist

- [x] 36. Frontend — `ASSETS_NAMESPACE` y `ASSETS_FIELDS` en `@/types/html-template`
- [x] 37. Frontend — `@/utils/upstream-catalog` con la inversion UNICA del mapa de defectos;
      `NodeConfigSandboxPage.vue` pasa a usarlo y borra su copia privada
- [x] 38. Frontend — `insertTextAtCursor(text, caretOffset)` en `templates.store.ts`;
      `insertMarker` delega y retira el `replace` con el que el dialogo degradaba un marcador
- [x] 39. Frontend — `TemplateEditorDialog.vue`: fuera los dos bloques de chips; dos `q-select`
      encadenados, tarjeta de detalle con badge de tipo y botones Copiar / Insertar
- [x] 40. Frontend — `upstream-catalog.spec.ts` (9), `TemplateEditorDialog.spec.ts` (11, cierra la
      pendiente 35) y 4 pruebas nuevas del fallback del store
- [x] 41. Verificacion — frontend 20 ficheros / 429 pruebas; `vue-tsc --noEmit`, eslint y prettier
      en verde
- [ ] 42. Pendiente (fuera de alcance) — no hay prueba con CodeMirror real: el spec del dialogo
      sustituye el editor por un doble de modulo, asi que la insercion efectiva solo se comprueba a
      mano

---

## Tanda actual — PROT-15.2 · Repositorio desacoplado de prompts de IA

### El hueco: el prompt vivia dentro del flujo

La instruccion que recibe el modelo viajaba incrustada en los `params` del nodo `PROCESADOR_IA`,
dentro de `configuracion_pipeline`. Dos flujos que comparten la misma instruccion la duplicaban, y
corregir una frase obligaba a editar el JSON de cada uno. Es exactamente el problema que PROT-11.1
resolvio para el HTML del mapeador con `plantillas_html`, y se resuelve igual: una tabla propia.

### Desacoplamiento estricto

`prompts_ia` NO guarda `provider`, `model`, `temperature`, `max_tokens` ni referencia a ninguna
plantilla HTML. Un prompt es un activo de TEXTO. Que modelo lo ejecuta lo decide la configuracion
del nodo; el contexto lo aporta el `StatePayloadContext` en ejecucion. Guardar el modelo aqui
ataria el texto a un proveedor e impediria reutilizar el mismo prompt con Claude y con ChatGPT,
que es el motivo de extraerlo.

### Contratos nuevos

```typescript
// @modules/ai-prompts/entities/ai-prompt.entity — tabla `prompts_ia`
export class AiPrompt {
  id: string;                    // id_prompt
  name: string;                  // nombre VARCHAR(120) UNIQUE
  description: string | null;    // descripcion VARCHAR(255)
  promptText: string;            // texto_prompt TEXT
  active: boolean;               // activo — borrado logico
  createdById: string;           // id_usuario_creador → usuarios(id_usuario) ON DELETE RESTRICT
  createdBy: User;               // relacion, NUNCA serializada (User lleva secreto_otp)
  createdAt: Date;               // fecha_creacion TIMESTAMPTZ
  updatedAt: Date;               // fecha_actualizacion TIMESTAMPTZ
}

// @modules/ai-prompts/ai-prompts.service
findAll(onlyActive = true): Promise<AiPromptResponseDto[]>      // sin promptText
findOne(id): Promise<AiPromptDetailResponseDto>                 // con promptText
findOneEntity(id): Promise<AiPrompt>                            // NotFoundException
findByName(name): Promise<AiPrompt | null>                      // para PROT-15.3
create(dto, createdById): Promise<AiPromptDetailResponseDto>
update(id, dto): Promise<AiPromptDetailResponseDto>
softDelete(id): Promise<AiPromptDetailResponseDto>
```

`AiPromptsModule` no importa ningun otro modulo y exporta su servicio: ese aislamiento es el
objetivo de la subtarea, no una casualidad.

### Rutas

`/api/ai-prompts` — `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id` (logico).
`@UseGuards(JwtAuthGuard, RolesGuard)` y `@Roles(ADMIN, EDITOR)` a nivel de clase: curar prompts es
operacion de flujos, y la unica frontera reservada al ADMIN es la gestion de cuentas.

### Checklist

- [x] 43. BD — `db/migrations/018-prompts-ia.sql` idempotente y el mismo DDL en `init.sql`
- [x] 44. Backend — entidad `AiPrompt`, DTOs create/update/response y `AiPromptsModule` en `AppModule`
- [x] 45. Backend — `AiPromptsService` con borrado logico y `assertNameAvailable`; controlador con
      autoria desde `@CurrentUser()`
- [x] 46. Pruebas — `ai-prompts.service.spec.ts` (17), suite completa 48 ficheros / 1136 pruebas
- [ ] 47. Pendiente — aplicar la migracion 018 en el contenedor (la ejecuta el usuario)
- [ ] 48. Pendiente (PROT-15.3) — conectar `findByName` a la estrategia del `PROCESADOR_IA` y
      decidir alli si `promptId` o `promptName` es lo que guarda el nodo en sus `params`

---

## Tanda actual — Plantillas de Prompts IA y selector Poka-Yoke de namespaces

### Dos cosas a la vez

1. **Renombrado de dominio.** `prompts_ia` -> `plantillas_prompts_ia`, y con ella el modulo, la
   ruta REST y toda la capa Vue. Lo que se guarda lleva marcadores `{{nodo.campo}}` sin resolver:
   es una PLANTILLA, y el prompt real es lo que sale de interpolarla contra el
   `StatePayloadContext` de una ejecucion concreta.
2. **El explorador determinista.** El autor tecleaba la ruta a mano; un `clean_bodyy` se guardaba
   sin protesta y reventaba en ejecucion con un GRAVE.

### Por que NO hubo trabajo de `output_schema`

El enunciado pedia "asegurar que los nodos tengan definido su output_schema". No existe ni debe
existir esa columna: `GET /api/nodos` ya sirve `outputFields` por nodo, resueltos en cada peticion
desde `INodeStrategy.outputFields`. El TSDoc de la interfaz lo declara explicitamente asi para que
tabla y estrategia no puedan desincronizarse. Los campos citados ya estaban: `parsed_email` publica
13 y `raw_email` 7. Lo unico vacio es `PROCESADOR_IA` y `ESCUDO_POST_IA`, y eso se arregla
escribiendo sus estrategias, no tocando SQL.

### Contratos nuevos

```typescript
// @/utils/prompt-namespaces — helpers puros, sin estado ni E/S
export const PROMPT_EXCLUDED_NODE_TYPES: ReadonlySet<string>;   // IA, ESCUDO, MAPEADOR
export const buildPromptContextFromCatalog: (entries: readonly NodeCatalogEntry[]) => UpstreamNamespace[];
export const filterPromptContext: (context: readonly UpstreamNamespace[]) => UpstreamNamespace[];

// @components/shared/VariableExplorer.vue — extraido de TemplateEditorDialog
interface Props { context: readonly UpstreamNamespace[]; insertLabel?: string }
emits: { insert: [token: string] }
defineExpose({ reset })
```

### Los dos escenarios del filtro

| Escenario | Origen del contexto | Quien lo invoca |
|---|---|---|
| A — CRUD global | `buildPromptContextFromCatalog(catalog.entries)` | El gestor de plantillas de prompt |
| B — dentro del asistente | prop `upstreamContext`, pasada por `filterPromptContext` | PENDIENTE: PROT-15.3 |

Escenario A deja exactamente cuatro origenes: `raw_email`, `cron_trigger`, `parsed_email` y
`scraped_web`. Los destinos se excluyen por CATEGORIA (`DESTINO`) y no por nombre, para que el
tercer destino que se anada no obligue a acordarse de ninguna lista.

### Checklist

- [x] 49. BD — `019-renombrar-plantillas-prompts-ia.sql` idempotente (6 objetos, no 2) e `init.sql`
- [x] 50. Backend — `ai-prompts` -> `ai-prompt-templates` con `git mv`; `AiPromptTemplate`,
      `@Controller('ai-prompt-templates')`, `AiPromptTemplatesModule` en `AppModule`
- [x] 51. Frontend — renombrado de tipos, servicio, store, pagina, dialogo y manager; ruta
      `/plantillas-prompts-ia`, drawer y `ROUTE_BREADCRUMBS`
- [x] 52. Frontend — `VariableExplorer.vue` extraido; `TemplateEditorDialog` pasa a consumirlo con
      sus 11 pruebas intactas
- [x] 53. Frontend — `prompt-namespaces.ts` y su cableado en `AiPromptTemplateDialog`, con
      insercion sobre el caret real del textarea
- [x] 54. Pruebas — 11 de `prompt-namespaces`, 10 de `VariableExplorer`; frontend 461, backend 1136
- [ ] 55. Pendiente — aplicar la 019 en el contenedor (la ejecuta el usuario)
- [ ] 56. Pendiente (PROT-15.3) — estrategia y triada del `PROCESADOR_IA`; al montarlo, pasar
      `upstream-context` al dialogo y cerrar el Escenario B

---

## Tanda actual — PROT-15.1 + PROT-15.3 · Nodo `PROCESADOR_IA`, cliente HTTP base y retirada de `ui_schema`

### Tres cosas a la vez

1. **Retirada de `ui_schema`.** Migración 020 + cascada en entidad, DTO, servicio y el tipo del
   frontend. La columna prometía ser el contrato declarativo del formulario y nunca se llenó; el
   formulario lo resuelve `node-config-registry.ts` con componentes tipados.
2. **Cliente HTTP base (`@core/http/`).** Primer consumidor de `@nestjs/axios` en el proyecto.
3. **Estrategia del `PROCESADOR_IA`** con freno de emergencia y simulación de coste cero.

### Contratos nuevos

```typescript
// @core/http/http-client.service.ts
export type HttpClientOutcome<T> =
  | { readonly data: T }
  | { readonly failure: NodeErrorDetail };

export interface HttpClientOptions {
  readonly timeoutMs?: number;   // por defecto 15_000
  readonly maxRetries?: number;  // por defecto 3
  readonly baseDelayMs?: number; // por defecto 500, factor 2
}

export class HttpClientService {
  request<T>(config: AxiosRequestConfig, options?: HttpClientOptions):
    Promise<HttpClientOutcome<T>>;
}
// Códigos: ERR_HTTP_TIMEOUT, ERR_HTTP_UPSTREAM_UNAVAILABLE, ERR_HTTP_CLIENT_REJECTED.
// Los tres son GRAVE: solo los GRAVE entran en `FsmEngineService.canRetry`.
// `ERR_HTTP_CLIENT_REJECTED` (4xx de cliente) es el único que NO se reintenta.

// @modules/nodes/strategies/interfaces/llm-provider.interface.ts
export enum LlmProvider { GEMINI, ANTHROPIC, OPENAI, MOCK }

export interface LlmResponsePayload {
  headline: string;
  summary: string;
  body_paragraphs: string[];
  metadata: {
    tokensPrompt: number; tokensCompletion: number;
    modelUsed: string; isMock: boolean;
  };
}

export interface ILlmProviderClient {
  readonly provider: LlmProvider;
  // LANZA ante fallo, al revés que una INodeStrategy: la excepción es la señal
  // que alimenta el contador del freno de emergencia.
  generateCompletion(prompt: string, systemPrompt?: string,
    config?: LlmExecutionOptions): Promise<LlmResponsePayload>;
}

// @modules/nodes/strategies/llm-extractor.strategy.ts
export const LLM_OUTPUT_KEYS =
  ['headline', 'summary', 'body_paragraphs', 'metadata'] as const;
// Códigos: ERR_LLM_CONFIG, ERR_LLM_MISSING_INPUT_TEXT, ERR_LLM_PROMPT_UNRESOLVED,
//          ERR_LLM_INTERPOLATION, ERR_LLM_PROVIDER_UNSUPPORTED,
//          ERR_LLM_PROVIDER_FAILURE, ERR_LLM_EMERGENCY_BRAKE.
```

### Diagrama de inyección

```
HttpCoreModule (imports HttpModule)     AiPromptTemplatesModule
      └── exports HttpClientService           └── exports AiPromptTemplatesService
                    │                                      │
                    ▼                                      │
          GeminiLlmProvider ──┐                            │
            (+ ConfigService, │                            │
             + MockLlmProvider)                            │
                              ▼                            ▼
                        LlmExtractorStrategy ◄─────────────┘
                              │
                              ▼  onModuleInit() de NodesModule
                        NodeStrategyFactory.registerStrategy(...)
```

`NodesModule` importa ambos módulos; ninguno de los dos lo importa a él, de modo que el grafo sigue
siendo acíclico. `GeminiLlmProvider` recibe `MockLlmProvider` inyectado, no construido: la
degradación sin API key tiene que reusar el mismo singleton que la ruta de `dryRun`.

### Por qué el freno cuenta por ejecución y no por instancia

La estrategia es un singleton de Nest compartido por todas las ejecuciones concurrentes. Un contador
único haría que un flujo agotara su umbral y pausara el nodo de IA de otro flujo sano que entrara
después, y el operador vería una ejecución pausada sin un solo fallo propio que la explique. La clave
es `${executionId}:${cursor}`, y la entrada se borra en cuanto el nodo cierra —acierte, falle o
frene— para no acumular claves de ejecuciones muertas. Lo exige `testing-standards.md` §4.

El freno **devuelve** `URGENTE`, no lo lanza: `runNode` respeta el `level` del `NodeResult` devuelto
y `canRetry` solo reintenta `GRAVE`, así que la ejecución queda `PAUSADO` con el cursor intacto.
Lanzar la clasificaría `toDomainFailure` como catastrófica y daría `FALLIDO` terminal, obligando a
relanzar el flujo desde cero y tirando el trabajo válido de los nodos anteriores.

### Estado de las tareas

- [x] 57. BD — migración `020-eliminar-ui-schema-nodos.sql` + `init.sql` (CREATE TABLE y el UPDATE
      que la 013 sembró para `TRIGGER_CRON`)
- [x] 58. Backend — `uiSchema` fuera de `NodeCatalogEntry`, `NodeCatalogResponseDto` y
      `NodeCatalogService`
- [x] 59. Frontend — `uiSchema` fuera de `types/node-catalog.ts` y de los 5 specs que lo construían
- [x] 60. Backend — `HttpClientService` + `HttpCoreModule` con timeout, backoff exponencial y
      traducción a `NodeErrorDetail`; 11 pruebas
- [x] 61. Backend — `ILlmProviderClient`, `LlmExtractorConfigDto`, `MockLlmProvider`,
      `GeminiLlmProvider` con degradación sin `GEMINI_API_KEY`
- [x] 62. Backend — `LlmExtractorStrategy` con guardas, interpolación y freno de emergencia;
      registro en `NodesModule.onModuleInit()`
- [x] 63. Pruebas — 24 de la estrategia, 11 del cliente HTTP, 1 nueva en `nodes.module.spec.ts`;
      backend 1172, frontend 461
- [x] 64. `.env.example` — `GEMINI_API_KEY` documentada
- [ ] 65. Pendiente — aplicar la 020 en el contenedor (la ejecuta el usuario)
- [ ] 66. Pendiente — unificar `ANTHROPIC_API_KEY` (`.env`) vs `CLAUDE_API_KEY` (`.env.example`)
      cuando se escriba el proveedor correspondiente
- [ ] 67. Pendiente — `npm run test:e2e` falla al importar `sanitize-html`; ya fallaba en la rama
      base (verificado con `git stash`), ajeno a esta tanda
- [ ] 68. Pendiente — `ESCUDO_POST_IA`, validador natural de la salida de este nodo

---

## Tanda actual — PROT-16 · Bifurcación de errores, nodo `DESTINO_SMTP` y visión multimodal

Rama `feat/bifurcacion-errores`, creada desde `feat/llm-extractor-node`.

El motor ya sabía desviar por `onErrorStep` desde PROT-07, pero la rama de recuperación era **ciega**:
el salto movía el cursor y persistía el checkpoint sin entregar al nodo de respaldo un solo dato sobre
el fallo que lo invocaba. En paralelo, `PARSER_PRE_IA` ya detectaba el correo cuyo único contenido es
una imagen o un PDF escaneado —lo marca con `requires_multimodal_fallback`— pero esa bandera no tenía
consumidor: el nodo de IA solo hablaba texto y no existía ningún nodo capaz de avisar a una persona.
La detección terminaba en un booleano que nadie leía.

Esta tanda cierra el circuito: el parser puede declarar ese caso como fallo enrutable, el motor
entrega el contexto del error al respaldo, y existen los dos destinos que dan sentido a la
bifurcación —una alerta SMTP y una inferencia con visión.

### Contratos nuevos

```typescript
// @core/fsm/types/pipeline-schema.types.ts
// Namespace reservado que el motor siembra al desviar. No figura en
// NODE_OUTPUT_NAMESPACES porque ningún nodo lo escribe: va en
// ENGINE_PROVIDED_NAMESPACES del validador, como `trigger`.
export const ERROR_CONTEXT_NAMESPACE = 'error_context';

export enum NodeType {
  /* ...ocho anteriores... */
  DESTINO_SMTP = 'DESTINO_SMTP',
}

export const NODE_OUTPUT_NAMESPACES = [
  /* ...ocho anteriores... */
  'smtp_result',
] as const;

// @core/fsm/types/node-strategy.types.ts
// El negativo de "qué puedo fallar": qué he apagado. Lo consulta la regla 10.
export interface INodeStrategy {
  readonly getUnreachableErrorCodes?: (
    params: Record<string, unknown>,
  ) => readonly string[];
}

// @core/fsm/utils/pipeline-topology.util.ts
// Distinta de resolveErrorRoute: la forma heredada de cadena atrapa TODO, así
// que aquella diría que sí para cualquier código. Ésta pregunta si alguien
// escribió ese código a mano.
export const catchesErrorExplicitly: (
  route: ErrorRoute,
  errorCode: string,
) => boolean;

// @modules/nodes/strategies/interfaces/llm-provider.interface.ts
export interface LlmInlineAttachment {
  readonly filename: string;
  readonly contentType: string;   // image/* o application/pdf
  readonly contentBase64: string;
}

export interface ILlmProviderClient {
  generateCompletion(
    prompt: string,
    systemPrompt?: string,
    config?: LlmExecutionOptions,
    attachments?: readonly LlmInlineAttachment[],   // ← opcional: los clientes que
  ): Promise<LlmResponsePayload>;                   //   lo ignoren siguen cumpliendo
}

// @modules/nodes/strategies/parser-email.strategy.ts
export const ERR_PARSER_UNEXTRACTABLE_MEDIA = 'ERR_PARSER_UNEXTRACTABLE_MEDIA';

// @modules/nodes/strategies/smtp-alert.strategy.ts
export const ERR_SMTP_CONFIG = 'ERR_SMTP_CONFIG';
export const ERR_SMTP_INTERPOLATION = 'ERR_SMTP_INTERPOLATION';
export const ERR_SMTP_SEND_FAILURE = 'ERR_SMTP_SEND_FAILURE';

// @core/config/ai-defaults.config.ts
export interface AiDefaultPair {
  readonly provider: string | null;   // string y no LlmProvider: @core no
  readonly model: string | null;      // puede importar de @modules
}
```

El payload de `error_context`, en `snake_case` porque es lo que se interpola:

| Clave | Contenido |
|---|---|
| `failed_node_id` / `failed_node_type` | Quién falló |
| `error_code` / `error_level` | El código es contrato; el nivel, diagnóstico |
| `error_message` | El `customMessage` de la ruta si lo declara; si no, el del fallo |
| `missing_fields` | Rutas `{{ns.campo}}` que se esperaban y no llegaron |
| `attempts` | Reintentos consumidos antes de desviar |
| `failed_at` | Marca ISO-8601 |
| `partial_data` | Lo que el nodo alcanzó a producir (`NodeResult.data` del fallo) |

**Todas se escriben siempre**, incluso vacías: `setNamespace` fusiona por clave de primer nivel, así
que un segundo desvío debe pisar las del primero. Omitir `missing_fields` porque este fallo no los
trae dejaría en pie los del anterior, y el respaldo acusaría de un campo ausente ajeno a su error.

### Diagrama de inyección de dependencias

```
CommonModule (@Global)
 ├── EmailService ─────────── SMTP_OTP_*   (login, pool de 1 conexión)
 └── SmtpNodeMailerService ── SMTP_NODE_*  (alertas, pool de 2)

NodesModule
 ├── providers: …, SmtpAlertStrategy, AiDefaultsConfig
 ├── SmtpAlertStrategy ──────── SmtpNodeMailerService
 ├── LlmExtractorStrategy ───── AiPromptTemplatesService, MockLlmProvider,
 │                              GeminiLlmProvider, AiDefaultsConfig
 └── onModuleInit(): registerStrategy(smtpAlertStrategy)   ← séptima estrategia

FsmModule
 └── PipelineValidatorService ── resolvers.unreachableErrorCodes
                                  └── strategy.getUnreachableErrorCodes?.(params)
```

### Esquema

Migración `db/migrations/021-nodo-destino-smtp.sql`: décima fila del catálogo `nodos`
(`DESTINO_SMTP`, categoría `DESTINO`), con `ON CONFLICT (codigo) DO NOTHING` sobre la UNIQUE
`nodos_codigo` que dejó la 011. `init.sql` se actualiza en el mismo commit; sin eso, un volumen de
Docker nuevo nacería sin la fila y la migración haría falta para siempre —el error que la 013
documenta haber cometido.

Sin columnas nuevas: `ui_schema` desapareció en la 020 y el `error_context` vive en el jsonb
`contexto_acumulado` que ya existía.

### Variables de entorno

Los cinco `SMTP_*` se parten en dos bloques (`SMTP_OTP_*` y `SMTP_NODE_*`). Es un **renombrado que
rompe el arranque** si no se acompaña del `.env` real: con los nombres viejos, el login OTP se queda
sin transporte. `--watch` no recarga el entorno, así que hay que reiniciar Nest.

Cuatro variables nuevas de IA, en dos pares. Son el último escalón, nunca el primero: un nodo que
declara su `provider` o `model` en los `params` sigue mandando.

```
AI_DEFAULT_PROVIDER=anthropic          AI_OCR_DEFAULT_PROVIDER=google_gemini
AI_DEFAULT_MODEL=claude-3-5-…          AI_OCR_DEFAULT_MODEL=gemini-1.5-flash
```

Precedencia: `params` del nodo → par OCR si hay adjuntos de visión → par de texto → constantes del DTO.

### Por qué el parser no falla SIEMPRE ante un correo sin texto

Es lo que pedía el encargo literal, y habría roto tres cosas a la vez. El motor solo escribe el
`outputNamespace` en la rama de éxito, así que `parsed_email` dejaría de publicarse para todos los
flujos, incluidos los que hoy atraviesan tranquilamente un correo de solo imagen. La bandera
`requires_multimodal_fallback` quedaría sin uso y con ella el veto de `BINARY_RETENTION_KEYS`, que es
lo único que impide al motor purgar el base64 del único contenido del correo. Y `WizardService`
comparte `buildParsedEmail` para el banco de pruebas, que pasaría a anunciar un fallo donde el
operador espera ver un payload.

El interruptor `failOnUnextractableMedia` (defecto `false`) deja la decisión donde corresponde: en el
diseñador del flujo, no en el despliegue.

### Por qué la bifurcación no se declara desde la estrategia

El encargo pedía emitir el fallo «si el nodo tiene configurado un `onErrorStep`». No es expresable:
`INodeStrategy.execute(context, params)` **no recibe `onErrorStep`**, y dárselo rompería el
aislamiento que permite a un mismo nodo reutilizarse en dos flujos con topologías distintas.

El único punto donde el interruptor y la ruta son visibles a la vez es la validación del esquema, así
que la intención se entrega ahí, como Poka-Yoke al guardar (regla 10): si un nodo declara
`catchErrors: ['ERR_PARSER_UNEXTRACTABLE_MEDIA']` y no lleva el `param` puesto, se rechaza. Sin esa
regla el síntoma sería mudo —ni excepción ni traza, solo un nodo de respaldo que no corre nunca.

El mecanismo es genérico (`getUnreachableErrorCodes`), no un caso especial del parser: `@core` no
puede conocer códigos de `@modules`, y centralizarlos obligaría a tocar el núcleo con cada nodo nuevo.

### Por qué la regla 10 ignora la forma heredada de cadena

Un `onErrorStep: "alerta"` atrapa cualquier código y está ahí para los DEMÁS fallos del nodo.
Rechazarlo porque el nodo no emite uno concreto sería un falso positivo que dejaría sin respaldo a un
flujo correcto. Mencionar el código a mano en `catchErrors`, en cambio, es una declaración inequívoca.

### Riesgo aceptado: `ANTHROPIC`/`OPENAI` degradan al simulador

Antes devolvían `ERR_LLM_PROVIDER_UNSUPPORTED` para que una redacción simulada no llegase al
`MAPEADOR_PLANTILLA` disfrazada de real. Con los defaults por entorno, `AI_DEFAULT_PROVIDER` puede
nombrar un proveedor aún sin cliente, y fallar habría pausado de golpe todo flujo que no declarase el
suyo —incluidos los que hoy corren sobre el defecto `MOCK`.

Lo que sostiene ahora la auditoría es `metadata.isMock`, que viaja en el namespace y queda en la
traza. **Quien publique a producción debería mirarlo.** Es además el criterio que ya aplicaba
`GeminiLlmProvider` al faltar `GEMINI_API_KEY`. La prueba 2.6 del spec cambió de sentido en
consecuencia.

### Estado de las tareas

- [x] 69. Motor — `ERROR_CONTEXT_NAMESPACE` y `buildErrorContext()`; siembra ANTES de mover el
      cursor para que el checkpoint de esa misma transición ya lo lleve
- [x] 70. Contratos — `NodeResult.data` documentado en su segundo destino
      (`error_context.partial_data`); `getUnreachableErrorCodes` en `INodeStrategy`
- [x] 71. Validador — `error_context` en `ENGINE_PROVIDED_NAMESPACES`; regla 10 con su resolutor,
      cableado desde `PipelineValidatorService`
- [x] 72. Parser — `failOnUnextractableMedia` (defecto `false`) y `ERR_PARSER_UNEXTRACTABLE_MEDIA`
      con el payload completo en el fallo
- [x] 73. BD — migración 021 + `init.sql`; `NodeType.DESTINO_SMTP` y namespace `smtp_result`
- [x] 74. Backend — `SmtpAlertConfigDto`, `SmtpAlertStrategy` y `SmtpNodeMailerService`; registro en
      `NodesModule.onModuleInit()`
- [x] 75. Entorno — `SMTP_*` partido en `SMTP_OTP_*` / `SMTP_NODE_*`; cuatro variables `AI_*` y
      `AiDefaultsConfig` con su tabla de alias
- [x] 76. Visión — `LlmInlineAttachment`, `inline_data` en Gemini, modo visión en
      `LlmExtractorStrategy` con tope de 3 adjuntos
- [x] 77. Pruebas — backend 53 suites / 1223 pruebas (+51), con tres specs nuevos (`smtp-alert`,
      `gemini-llm.provider`, `ai-defaults.config`); frontend 23 archivos / 461 pruebas, sin cambios
- [x] 77b. Frontend — `src/types/pipeline.ts` replica `DESTINO_SMTP` y `smtp_result` (enum, etiqueta
      y los tres `Record<NodeType, …>`). Solo el contrato de tipos; el configurador queda fuera
- [ ] 78. Pendiente — aplicar la 021 en el contenedor (la ejecuta el usuario) y actualizar el `.env`
      real con los dos bloques SMTP y las cuatro `AI_*`, reiniciando Nest
- [x] 79. Configurador Quasar del nodo `DESTINO_SMTP` — **cerrado en PROT-17** (ver la tanda
      siguiente). `PROCESADOR_IA` sigue sin el suyo: el registro cubre ahora 6 de 9 tipos
- [ ] 80. Pendiente — cliente `AnthropicLlmProvider`. Mientras no exista,
      `AI_DEFAULT_PROVIDER=anthropic` degrada al simulador (ver el riesgo aceptado). Sustituye y
      concreta al pendiente 66

---

## Tanda actual — PROT-17 · Configurador Quasar de `DESTINO_SMTP` y carta institucional de alerta

PROT-16 dejó el nodo operativo en backend pero **inconfigurable desde la interfaz**: la única forma
de declarar destinatarios era escribir el `pipeline_schema` a mano, que es justo lo que RNF-04
prohíbe. Y el aviso salía como un párrafo de texto suelto, mientras el correo de OTP ya tenía carta
institucional desde hacía meses.

Esta tanda cierra las dos cosas bajo un mismo criterio: **el operador configura a quién avisar, con
qué asunto y qué nota añadir; no escribe ni una etiqueta HTML.** La carta la compone el sistema.

### Contratos nuevos

```ts
// @common/utils/alert-email.template.ts
export interface AlertEmailParams {
  readonly flowId: string;          // context.getWorkflowId()
  readonly timestamp: string;
  readonly failedNodeId?: string;   // todo lo del fallo es OPCIONAL
  readonly failedNodeType?: string;
  readonly errorCode?: string;
  readonly errorLevel?: string;
  readonly errorMessage?: string;
  readonly customNote?: string;
  readonly partialData?: Record<string, unknown>;
  readonly unresolvedSubjectVariable?: string;
}

export const buildAlertEmailHtml: (params: AlertEmailParams) => string;
export const buildAlertEmailText: (params: AlertEmailParams) => string;

// @common/utils/escape-html.util.ts
export const escapeHtml: (value: string) => string;

// @modules/nodes/strategies/smtp-alert.strategy.ts
export const DEFAULT_ALERT_SUBJECT =
  '[ALERTA PROTO-DO] Notificacion de incidencia en flujo {{trigger.flow_name}}';
export const SAFE_FALLBACK_SUBJECT =
  '[ALERTA PROTO-DO] Notificacion de incidencia en el flujo';
```

`SmtpAlertConfigDto` pierde `bodyTemplate` y gana `customMessage` (`MAX_ALERT_NOTE_LENGTH = 2000`).
`NodeMailMessage` gana `html?: string`.

### Diagrama de inyección de dependencias

```
CommonModule
  └── SmtpNodeMailerService  (pool SMTP_NODE_*, ahora con parte HTML)
            ▲
NodesModule │
  └── SmtpAlertStrategy ──> buildAlertEmailHtml / buildAlertEmailText  (funciones puras)
                                        └──> escapeHtml                (función pura)

Frontend (sin capa de servicios, como TRIGGER_CRON)
  SmtpAlertConfig.vue ──> useSmtpAlertStore(nodeId) ──> isEmailAddress
  node-config-registry ─┐
  node-store-registry  ─┴─> los dos, o el asistente monta el formulario y nunca habilita "Siguiente"
```

### Por qué el aviso se envía aunque el asunto no resuelva

`getInterpolatedValue` lanza ante una ruta ausente, y en cualquier otro nodo eso debe detener el
flujo: publicar una noticia con el titular en blanco es peor que no publicarla. **Aquí la aritmética
se invierte.** Este nodo es la última vía por la que una persona se entera de la incidencia, así que
negarse a enviar por una errata en el asunto deja el fallo original sin testigo además de sin
arreglar.

No es un caso rebuscado: el defecto cita `{{trigger.flow_name}}` y **`trigger` no lo siembra nadie en
los dos caminos reales de ejecución** — `WorkflowsService` no pasa `initialPayload` en ninguna de sus
dos llamadas, y hay un comentario en el propio motor explicando por qué. Con interpolación estricta,
el nodo recién configurado no enviaría ni un correo.

El diagnóstico no se pierde, cambia de sitio: la variable culpable viaja al pie de la carta y al log.
En vez de un flujo `PAUSADO` que nadie mira, la misconfiguración llega impresa en el correo que la
persona ya está leyendo.

### Por qué desaparece `ERR_SMTP_INTERPOLATION`

Era el código de `bodyTemplate`, que ya no existe, y el asunto ya no puede fallar. Mantenerlo
exportado dejaría un código que `catchErrors` puede declarar y que no se dispararía jamás — el fallo
mudo que la regla 10 del validador de topología existe precisamente para impedir.

### Por qué NO se revierte la regla «solo texto plano», se acota

El TSDoc de `SmtpNodeMailerService` y el del DTO prohibían el HTML citando la inyección de marcado, y
ese razonamiento **sigue siendo correcto**. Lo que protegía era que el OPERADOR aportase marcado;
nada de lo que él escribe llega al buzón como HTML, ni siquiera su nota. Lo que se añade es HTML de
plantilla fija cuyos huecos pasan todos por `escapeHtml`.

El peligro nunca fue el HTML: era el HTML de procedencia ajena. Y buena parte de los datos de esta
carta la tienen — `error_message` cita el asunto del correo entrante y `partial_data` lleva los
nombres de los adjuntos, que los escribe cualquiera que sepa la dirección del buzón del flujo. Por
eso el escapado es obligatorio sobre **todo** dato dinámico, sin excepción.

### Por qué la vista previa no imita la carta real

Replicar en Vue los colores y textos del HTML del backend crearía una segunda plantilla, en otro
lenguaje, que diverge en cuanto alguien toque el generador — y entonces la vista previa mentiría, que
es peor que no tenerla. La maqueta es **estructural**: cabecera con el degradado, badge de ejemplo y
recuadros punteados rotulados con lo que el motor rellenará. Lo único que refleja de verdad es
**dónde cae la nota del operador**, que es lo que él necesita saber.

### Por qué `customMessage` no se interpola

Se describió como «una nota en texto plano». Tratarlo como plantilla le añadiría un modo de fallo a
un campo cuyo propósito es que siempre se lea. Un `{{...}}` escrito ahí sale literal, y el `hint` del
campo lo dice.

### Por qué `hydrateFromNode` NO repone el asunto por defecto

El defecto es para nodos NUEVOS. Un nodo guardado sin asunto lo está porque el operador lo borró a
propósito; reponerlo al reabrirlo cambiaría su configuración con solo mirarla, y al cerrar el paso se
persistiría sin que nadie lo pidiera.

### Por qué el frontend NO tiene `smtp-alert.service.ts`

No hay endpoint que consultar. Validar un buzón de destino exigiría enviar un correo real a una
persona real cada vez que alguien reabre el paso del asistente, así que `isConfigValid` se resuelve
entero en el cliente. `TRIGGER_CRON` es el precedente explícito, y un servicio que no conoce ninguna
ruta del backend contradice su propia definición (`frontend-architecture.md` §2.1).

### Excepción Poka-Yoke registrada

`frontend-quasar.md` §4 prohíbe el texto libre en `QSelect`. Los dos selectores de direcciones lo
usan porque **no existe ni puede existir** una lista cerrada de correos. Es el segundo caso del
proyecto tras la zona horaria del cron, y de él se copia la pieza crítica: el manejador
`@input-value`, sin el cual un correo tecleado y no confirmado con Enter se pierde al guardar
mientras la pantalla lo sigue mostrando.

### Estado de las tareas

- [x] 81. Backend — `email-brand.constants.ts` con la paleta compartida; `email.service.ts` deja de
      declararla y su plantilla no cambia ni un carácter
- [x] 82. Backend — `escapeHtml` (no existía nada equivalente) y `buildAlertEmailHtml` /
      `buildAlertEmailText`, las dos versiones en el mismo módulo para que no diverjan
- [x] 83. Backend — `bodyTemplate` → `customMessage`; `getIncompleteParams` pasa a exigir solo `to`;
      asunto con defecto y respaldo; `ERR_SMTP_INTERPOLATION` retirado
- [x] 84. Backend — `NodeMailMessage.html` y multipart texto + HTML; TSDoc de la regla reescrito
- [x] 85. Frontend — `types/nodes/smtp-alert.types.ts`, `utils/email-address.ts`,
      `stores/nodes/smtp-alert.store.ts` y `components/nodes/SmtpAlertConfig.vue`
- [x] 86. Frontend — alta en los DOS registros (`node-config-registry` y `node-store-registry`)
- [x] 87. Pruebas — backend 55 suites / 1265 (+2 suites, +42); frontend 26 archivos / 506 (+3
      archivos, +45)
- [ ] 88. Pendiente — arrastrado del 78: aplicar la migración 021 en el contenedor y actualizar el
      `.env` real con los dos bloques SMTP y las cuatro `AI_*`, reiniciando Nest. **Sin esto el nodo
      no aparece en `GET /api/nodos` y el login OTP se queda sin transporte**
- [ ] 89. Pendiente — configurador Quasar de `PROCESADOR_IA`, el último tipo con estrategia pero sin
      formulario. `node-config-registry.ts` cubre ya 6 de 9. **Reaparece como pendiente 97**: sin él,
      la ruta de contingencia por visión depende de que la plantilla ya coloque ese nodo

---

## Tanda actual — PROT-18 · Bifurcaciones de contingencia (`onErrorStep`) en el asistente

PROT-16 construyó el mecanismo de desvío y PROT-17 el nodo al que desviar. Faltaba la pieza que los
une: **nadie podía apuntar a ese nodo**. El `grep` de `onErrorStep` en `frontend/src` no devolvía una
sola línea de producto que lo escribiera — solo el tipo, el literal `null` del ensamblador y prosa.
`SmtpAlertConfig.vue` ya hablaba de «la ruta declarada con onErrorStep» y su asunto por defecto
interpolaba `{{error_context.failed_node_id}}`, un namespace que solo existe si se llega por esa vía.
El destino estaba implementado y era inalcanzable.

### Contratos nuevos

```ts
// @/types/nodes/error-branch.types.ts
export type ErrorBranchTrigger = 'CUALQUIER_FALLO' | 'SIN_TEXTO_EXTRAIBLE';
export type ErrorBranchAction = 'ALERTA_SMTP' | 'VISION_IA';
export interface ErrorBranch { trigger: ErrorBranchTrigger; action: ErrorBranchAction }
export const SHARED_ALERT_NODE_ID = 'alerta_smtp';

// @stores/nodes/node-store-registry.ts — contrato NodeConfigStore
readonly declareCaughtErrorCodes?: (codes: readonly string[]) => void;

// @/utils/pipeline-assembler.ts
export const errorRouteTarget: (route) => string | null;
export const collectErrorSatellites: (schema, activeSteps) => AssemblerStep[];
assemblePipelineSchema(steps, meta, satellites = []);
```

### Diagrama de inyección

```
WizardPage.vue  (anfitrion, una sola insercion por paso)
   ├── <component :is=nodeConfigRegistry[nodeType]>   ← configurador del nodo
   └── <NodeErrorBranchConfig :node-id :node-type>
             │
             ├── useFlujoDraftStore()            ← duena de la TOPOLOGIA y las ramas
             │      ├── setErrorBranch() ──► store del nodo fuente
             │      │                          .declareCaughtErrorCodes()
             │      └── assemblePipelineSchema() ──► pipeline-assembler
             └── <SmtpAlertConfig :node-id=SHARED_ALERT_NODE_ID>   (incrustado)
```

### Por qué «cualquier error» es la forma de CADENA y no un código comodín

El encargo proponía `catchErrors: ['ANY_GRAVE_ERROR']`. Ese código no existe en el repositorio, y no
puede existir: el DTO exige que `catchErrors` sea un array y `resolveErrorRoute` compara el código
**literal**. La ruta se habría guardado sin protestar y **no se habría disparado jamás** — el fallo
mudo que la regla 10 del validador existe precisamente para impedir, y que ni siquiera la regla 10
habría detectado, porque solo consulta códigos que el nodo no puede emitir con sus `params`.

La forma de cadena (`onErrorStep: "alerta_smtp"`) es la que el motor documenta como «atrapa
cualquier código». A cambio no puede llevar `customMessage` —«una cadena no tiene donde ponerlo»—,
así que ese campo no se pide en el formulario. No se pierde nada práctico: `customMessage` SUSTITUYE
al mensaje real del fallo en la traza, y la nota que el operador quiera añadir al aviso ya tiene su
sitio en los `params` del nodo de alerta.

### Por qué un solo nodo de alerta por flujo

La regla 5 del validador prohíbe que dos nodos escriban el mismo `outputNamespace`, y la lista
cerrada tiene un único `smtp_result`. Un satélite por nodo fuente (`${nodeId}_error_smtp`, como pedía
el encargo) devuelve un 400 en cuanto hay dos ramas, o una rama más un `DESTINO_SMTP` como destino
principal.

Compartirlo tampoco pierde información: `error_context` ya lleva `failed_node_id`, así que la misma
carta sirve para cualquier rama y el destinatario sabe igualmente qué paso se detuvo. Si la plantilla
ya trae un `DESTINO_SMTP`, se reutiliza ese y no se provisiona nada.

### Por qué la ruta de visión NO crea un nodo

Un `PROCESADOR_IA` satélite chocaría con el del flujo en `llm_response` por la misma regla 5, y ese
tipo además sigue sin configurador (pendiente 89), así que nadie podría rellenar su prompt. La ruta
apunta al `PROCESADOR_IA` **que el flujo ya tiene** — que es exactamente el escenario para el que se
escribió `collectVisionAttachments` en PROT-16: el modo visión se activa solo al ver
`error_context.error_code === ERR_PARSER_UNEXTRACTABLE_MEDIA`. Sin nodo de IA en el flujo, la opción
no se ofrece.

### Por qué el interruptor del parser lo mueve el propio nodo

La rama `SIN_TEXTO_EXTRAIBLE` exige `failOnUnextractableMedia: true`, o la regla 10 rechaza el
esquema al guardar. El agregador no puede escribirlo: §3.1 le prohíbe conocer la forma interna de una
config, y el nombre del interruptor es privado del parser. Se añadió al contrato `NodeConfigStore` el
método opcional `declareCaughtErrorCodes(codes)` —espejo del `getUnreachableErrorCodes` del backend,
que responde la pregunta inversa— y el agregador pregunta en vez de escribir. Es reversible: retirar
la rama pasa `[]` y apaga el interruptor, porque dejarlo puesto convertiría en `PAUSADO` un flujo que
hoy atraviesa tranquilamente un correo de solo imagen.

### Bug corregido de paso: el round-trip destruía las rutas

`AssemblerStep` no declaraba `onErrorStep` y `assemblePipelineSchema` lo reescribía a `null`, así que
un `assemble → disassemble → assemble` **borraba cualquier ruta** escrita a mano en el panel JSON del
editor de plantillas, y perdía los nodos satélite —que no están en el camino de `nextStep`—. Era
latente desde que existe ese panel; con esta entrega habría dejado de serlo en cuanto alguien
declarase una rama. El TSDoc que afirmaba «tampoco la pierde» era cierto solo para la reconstrucción
del orden, no para el dato.

### Estado de las tareas

- [x] 90. Contratos — `error-branch.types.ts` con el catálogo de DISPARADORES (no de códigos);
      `customMessage` en `SelectiveErrorFallback` por fidelidad
- [x] 91. Ensamblador — `onErrorStep` en `AssemblerStep`, satélites fuera del encadenado,
      `collectErrorSatellites`, y el round-trip deja de perder el dato
- [x] 92. Contrato de nodo — `declareCaughtErrorCodes`; el parser expone
      `failOnUnextractableMedia` en su config, `toNodeParams` e `hydrateFromNode`
- [x] 93. Agregador — `errorBranches`, `setErrorBranch`, resolución del destino, satélite compartido,
      motivo `RAMA_DE_ERROR_INCOMPLETA` e hidratación en modo edición
- [x] 94. Interfaz — `NodeErrorBranchConfig.vue` montado desde `WizardPage`, con `SmtpAlertConfig`
      incrustado
- [x] 95. Pruebas — frontend 27 archivos / 547 (+1 archivo, +41); backend intacto en 55 / 1265
- [ ] 96. Pendiente — arrastrado del 88: aplicar la migración 021 y actualizar el `.env` real. **Sin
      ella `DESTINO_SMTP` llega con `implemented: false` y el editor de plantillas lo deshabilita**
- [ ] 97. Pendiente — configurador Quasar de `PROCESADOR_IA`. Mientras no exista, la ruta de visión
      solo se ofrece si la plantilla ya coloca ese nodo, y su prompt se configura fuera del asistente
