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
`id_refresh_token`, `id_usuario` (FK `ON DELETE CASCADE`), `hash_token CHAR(64) UNIQUE`,
`expiracion`, `revocado`, `fecha_creacion`.

TypeORM corre con `synchronize: false`, así que el DDL se aplica a mano:
`db/migrations/001-refresh-tokens.sql` (idempotente) para bases ya creadas,
e `init.sql` para clonados nuevos.

`db/migrations/003-otp-secret.sql` añade `secreto_otp` y retira `codigo_otp` / `expiracion_otp`,
dos columnas de un diseño anterior de códigos persistidos que ningún código leía.

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

## 3. Motor FSM (pendiente)

`INodeStrategy`, `NodeStrategyFactory` y `StatePayloadContext` se documentarán aquí al implementarse.
El contrato de referencia vive en `.claude/rules/architecture-patterns.md` §2 y §3.
