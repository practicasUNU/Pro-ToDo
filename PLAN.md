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

// @modules/auth/services/refresh-token.service.ts — único punto que conoce `refresh_tokens`
export class RefreshTokenService {
  /** Devuelve el token EN CLARO; en la tabla solo queda su SHA-256. */
  public async issue(user: User): Promise<string>;
  /** Canjea y revoca en el mismo acto. Lanza 401 en todo caso de fallo. */
  public async rotate(rawToken: string): Promise<User>;
  public async revoke(rawToken: string): Promise<void>;
  public async revokeAllForUser(userId: string): Promise<void>;
  public async purgeExpired(): Promise<void>;
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
  ─────────────────►  VIGENTE  ──────────────►  REVOCADO ──► (purgeExpired)
                         │  │                       │
       expiracion ◄──────┘  └──── revoke()          │
       vencida                    (logout)          │
                                                    ▼
                              rotate() de nuevo ⇒ REUTILIZACIÓN
                              ⇒ revokeAllForUser() + 401
```

### 2.5 Variables de entorno

| Variable | Uso | Política si falta |
|---|---|---|
| `OTP_EXPIRATION_MINUTES` | Vigencia del código y valor de `expiresInSeconds` | Cae a `5` |
| `JWT_EXPIRES_IN` | Vigencia del access token (**`1h`**) | Cae a `8h` |
| `REFRESH_TOKEN_EXPIRES_IN_DAYS` | Vigencia del refresh token | Cae a `7` |
| `OTP_THROTTLE_TTL_MS` / `OTP_THROTTLE_LIMIT` | Ventana y cupo del límite de tasa | Caen a `60000` / `3` |
| `SMTP_*` | Transporte del correo | El envío falla con `500` |

### 2.6 Esquema

Tabla `refresh_tokens` (columnas en español, como el resto de `init.sql`):
`id_refresh_token`, `id_usuario` (FK `ON DELETE CASCADE`), `id_dispositivo UUID NOT NULL`,
`hash_token CHAR(64) UNIQUE`, `expiracion`, `revocado`, `fecha_creacion`.

TypeORM corre con `synchronize: false`, así que el DDL se aplica a mano:
`db/migrations/001-refresh-tokens.sql` (idempotente) para bases ya creadas,
e `init.sql` para clonados nuevos.

`db/migrations/003-otp-secret.sql` añade `secreto_otp` y retira `codigo_otp` / `expiracion_otp`,
dos columnas de un diseño anterior de códigos persistidos que ningún código leía.

`db/migrations/004-device-id-refresh-tokens.sql` añade `id_dispositivo`, que agrupa los tokens
por origen para que emitir uno nuevo revoque solo la sesión anterior de **ese** dispositivo.
Descarta las filas heredadas (no tienen dispositivo conocido), así que quien tuviera sesión
abierta al aplicarla vuelve a entrar por OTP.

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
