import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { OUTPUT_NAMESPACE_PATTERN } from '@core/fsm/types/pipeline-schema.types';

/** Puerto IMAPS por defecto (IMAP sobre TLS implicito, RFC 8314). */
export const DEFAULT_IMAP_PORT = 993;

/** Buzon por defecto sobre el que sondear mensajes entrantes. */
export const DEFAULT_MAILBOX = 'INBOX';

/** Periodo de sondeo por defecto: un minuto. */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Namespace por defecto bajo el que el nodo declara escribir su salida. */
export const DEFAULT_OUTPUT_NAMESPACE = 'nodo_trigger';

/** Por defecto el correo procesado se marca como leido para no reprocesarlo. */
export const DEFAULT_MARK_AS_READ = true;

/** Por defecto se exige TLS implicito; degradar a texto claro debe ser explicito. */
export const DEFAULT_SECURE = true;

/** Numero de puerto TCP mas alto valido. */
const MAX_TCP_PORT = 65_535;

/**
 * Periodo minimo de sondeo. No es una preferencia: los proveedores IMAP aplican
 * limites de tasa y bloquean cuentas que reconectan de forma agresiva.
 */
export const MIN_POLL_INTERVAL_MS = 30_000;

/**
 * Claves de entorno admisibles para `passwordEnvKey`.
 *
 * BARRERA DE SEGURIDAD, no validacion cosmetica. `params` es editable por un rol
 * EDITOR desde el asistente de flujos. Sin esta restriccion, un editor podria
 * declarar `host: imap.atacante.com` junto a `passwordEnvKey: JWT_SECRET` y el
 * backend enviaria el secreto de firma de tokens como contrasena IMAP a un
 * servidor ajeno. Limitar la clave al prefijo `IMAP_` y al sufijo `PASSWORD`
 * acota lo que el nodo puede llegar a leer del entorno a credenciales de correo.
 */
export const PASSWORD_ENV_KEY_PATTERN = /^IMAP_[A-Z0-9_]*PASSWORD$/;

/**
 * Parametros del nodo TRIGGER_IMAP, tal como se declaran en `params` dentro del
 * `pipeline_schema` (columna JSONB `flujos.configuracion_pipeline`).
 *
 * MODELO DE SEGURIDAD HIBRIDO: no existe campo `password`. La contrasena vive
 * exclusivamente en `backend/.env` y el nodo solo guarda `passwordEnvKey`, el
 * NOMBRE de la variable de entorno que la contiene. `ImapTriggerStrategy` la
 * resuelve en tiempo de ejecucion con `ConfigService`.
 *
 * El motivo es que estos `params` se persisten en una columna JSONB y viajan al
 * editor de flujos del frontend: un secreto aqui quedaria en claro en la base de
 * datos y expuesto al cliente, contra `security-and-scope.md` §0.1. Y no es solo
 * una convencion: la validacion corre con `forbidNonWhitelisted`, asi que un
 * `params` que traiga `password` se RECHAZA en lugar de ignorarse en silencio.
 *
 * Los campos con valor por defecto se declaran opcionales y su default NO se
 * aplica con un inicializador de propiedad: se resuelve en `resolveImapConfig`
 * con `??`, siguiendo la convencion del repositorio (ver `DEFAULT_BACKOFF_FACTOR`
 * en `FsmEngineService`). Un inicializador solo actuaria si `plainToInstance`
 * corriera con `exposeDefaultValues`, que no es el caso.
 */
export class ImapTriggerConfigDto {
  @ApiProperty({
    description: 'Host del servidor IMAP',
    example: 'imap.unuware.com',
  })
  @IsString({ message: 'host debe ser una cadena.' })
  @IsNotEmpty({ message: 'host no puede estar vacio.' })
  host: string;

  @ApiPropertyOptional({
    description: `Puerto del servidor IMAP. Por defecto ${DEFAULT_IMAP_PORT}`,
    example: DEFAULT_IMAP_PORT,
    minimum: 1,
    maximum: MAX_TCP_PORT,
    default: DEFAULT_IMAP_PORT,
  })
  @IsOptional()
  @IsInt({ message: 'port debe ser un numero entero.' })
  @IsPositive({ message: 'port debe ser mayor que cero.' })
  @Max(MAX_TCP_PORT, { message: `port no puede superar ${MAX_TCP_PORT}.` })
  port?: number;

  @ApiPropertyOptional({
    description: `Si true, usa TLS implicito. Por defecto ${String(DEFAULT_SECURE)}`,
    example: DEFAULT_SECURE,
    default: DEFAULT_SECURE,
  })
  @IsOptional()
  @IsBoolean({ message: 'secure debe ser un booleano.' })
  secure?: boolean;

  @ApiProperty({
    description: 'Usuario de la cuenta de correo a sondear',
    example: 'notiweb@unuware.com',
  })
  @IsString({ message: 'user debe ser una cadena.' })
  @IsNotEmpty({ message: 'user no puede estar vacio.' })
  user: string;

  @ApiProperty({
    description:
      'NOMBRE de la variable de entorno que contiene la contrasena. Nunca la contrasena en si. Restringido a claves IMAP_*PASSWORD',
    example: 'IMAP_PASSWORD',
    pattern: PASSWORD_ENV_KEY_PATTERN.source,
  })
  @IsString({ message: 'passwordEnvKey debe ser una cadena.' })
  @IsNotEmpty({ message: 'passwordEnvKey no puede estar vacio.' })
  @Matches(PASSWORD_ENV_KEY_PATTERN, {
    message:
      'passwordEnvKey solo admite variables con el formato IMAP_*PASSWORD; no puede referenciar otros secretos del entorno.',
  })
  passwordEnvKey: string;

  @ApiPropertyOptional({
    description: `Buzon a sondear. Por defecto ${DEFAULT_MAILBOX}`,
    example: DEFAULT_MAILBOX,
    default: DEFAULT_MAILBOX,
  })
  @IsOptional()
  @IsString({ message: 'mailbox debe ser una cadena.' })
  @IsNotEmpty({ message: 'mailbox no puede estar vacio.' })
  mailbox?: string;

  @ApiPropertyOptional({
    description: `Periodo de sondeo en milisegundos. Por defecto ${DEFAULT_POLL_INTERVAL_MS}`,
    example: DEFAULT_POLL_INTERVAL_MS,
    default: DEFAULT_POLL_INTERVAL_MS,
  })
  @IsOptional()
  @IsInt({ message: 'pollIntervalMs debe ser un numero entero.' })
  @IsPositive({ message: 'pollIntervalMs debe ser mayor que cero.' })
  @Min(MIN_POLL_INTERVAL_MS, {
    message: `pollIntervalMs no puede bajar de ${MIN_POLL_INTERVAL_MS} ms para no exceder los limites de tasa del proveedor IMAP.`,
  })
  pollIntervalMs?: number;

  @ApiPropertyOptional({
    description:
      'Namespace declarado del nodo. El efectivo es el `outputNamespace` del pipeline_schema, que es el que usa el motor para escribir',
    example: DEFAULT_OUTPUT_NAMESPACE,
    default: DEFAULT_OUTPUT_NAMESPACE,
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsOptional()
  @IsString({ message: 'outputNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message: 'outputNamespace debe ser snake_case alfanumerico en minusculas.',
  })
  outputNamespace?: string;

  @ApiPropertyOptional({
    description: `Si true, marca el correo procesado con la bandera \\Seen. Por defecto ${String(DEFAULT_MARK_AS_READ)}`,
    example: DEFAULT_MARK_AS_READ,
    default: DEFAULT_MARK_AS_READ,
  })
  @IsOptional()
  @IsBoolean({ message: 'markAsRead debe ser un booleano.' })
  markAsRead?: boolean;
}

/**
 * Configuracion del nodo con todos los valores por defecto ya aplicados.
 *
 * Existe para que ni la estrategia ni el servicio de sondeo repitan la cadena de
 * `??`: con dos consumidores, un default divergente entre ambos significaria que
 * el sondeo vigila un buzon distinto del que el nodo acaba leyendo.
 */
export interface ResolvedImapConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly passwordEnvKey: string;
  readonly mailbox: string;
  readonly pollIntervalMs: number;
  readonly outputNamespace: string;
  readonly markAsRead: boolean;
}

/** Aplica los valores por defecto sobre un DTO ya validado. Funcion pura. */
export const resolveImapConfig = (
  dto: ImapTriggerConfigDto,
): ResolvedImapConfig => ({
  host: dto.host,
  port: dto.port ?? DEFAULT_IMAP_PORT,
  secure: dto.secure ?? DEFAULT_SECURE,
  user: dto.user,
  passwordEnvKey: dto.passwordEnvKey,
  mailbox: dto.mailbox ?? DEFAULT_MAILBOX,
  pollIntervalMs: dto.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  outputNamespace: dto.outputNamespace ?? DEFAULT_OUTPUT_NAMESPACE,
  markAsRead: dto.markAsRead ?? DEFAULT_MARK_AS_READ,
});
