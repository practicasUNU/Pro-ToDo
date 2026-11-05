import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
} from 'class-validator';

import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Verbos HTTP admitidos. Un enum porque `@IsEnum` necesita un objeto en runtime. */
export enum HttpGenericMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  PATCH = 'PATCH',
  DELETE = 'DELETE',
}

/**
 * Forma del cuerpo.
 *
 * `FORM_DATA` es `application/x-www-form-urlencoded` y su `bodyTemplate` es un
 * objeto JSON de cadenas (`{"campo": "{{ns.valor}}"}`), no multipart: este nodo
 * no sube ficheros, y un multipart sin fichero es un urlencoded mas caro.
 */
export enum HttpGenericBodyType {
  JSON = 'JSON',
  RAW_TEXT = 'RAW_TEXT',
  FORM_DATA = 'FORM_DATA',
  NONE = 'NONE',
}

/**
 * Esquema de autenticacion. Todo lo que no sea `NONE` exige una credencial de
 * la boveda (`authConfig.credentialId`) del MISMO tipo: el secreto nunca se
 * escribe en el `pipeline_schema`.
 */
export enum HttpGenericAuthType {
  NONE = 'NONE',
  BEARER_TOKEN = 'BEARER_TOKEN',
  BASIC_AUTH = 'BASIC_AUTH',
  API_KEY = 'API_KEY',
}

export const DEFAULT_HTTP_GENERIC_METHOD = HttpGenericMethod.POST;
export const DEFAULT_HTTP_GENERIC_BODY_TYPE = HttpGenericBodyType.JSON;
export const DEFAULT_HTTP_GENERIC_AUTH_TYPE = HttpGenericAuthType.NONE;

/** Espera por defecto: la misma que el cliente HTTP compartido. */
export const DEFAULT_HTTP_GENERIC_TIMEOUT_MS = 15_000;
export const MIN_HTTP_GENERIC_TIMEOUT_MS = 1_000;
export const MAX_HTTP_GENERIC_TIMEOUT_MS = 60_000;

/**
 * Reintentos por defecto de los verbos NO idempotentes (POST, PATCH): CERO.
 *
 * Un POST reintentado tras un timeout puede publicar dos veces en el servidor
 * de enfrente (el mismo motivo por el que DESTINO_DRUPAL envia sus POST sin
 * reintentos). Quien sepa que su API lo tolera los sube a mano.
 */
export const DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS = 0;

/**
 * Reintentos por defecto de los verbos idempotentes (GET, PUT, DELETE).
 *
 * Repetirlos no cambia el resultado en el servidor, asi que absorben un 5xx,
 * un timeout o un ECONNREFUSED pasajero con el backoff exponencial de
 * `HttpClientService` (500 ms, 1 s, 2 s).
 */
export const DEFAULT_HTTP_GENERIC_IDEMPOTENT_RETRY_ATTEMPTS = 3;
export const MAX_HTTP_GENERIC_RETRY_ATTEMPTS = 5;

/** Verbos que se pueden repetir sin efecto adicional en el servidor (RFC 9110 §9.2.2). */
export const IDEMPOTENT_HTTP_GENERIC_METHODS: ReadonlySet<HttpGenericMethod> =
  new Set([
    HttpGenericMethod.GET,
    HttpGenericMethod.PUT,
    HttpGenericMethod.DELETE,
  ]);

/** Reintentos que aplica el nodo cuando `retryAttempts` no se declara. */
export const defaultRetryAttemptsFor = (method: HttpGenericMethod): number =>
  IDEMPOTENT_HTTP_GENERIC_METHODS.has(method)
    ? DEFAULT_HTTP_GENERIC_IDEMPOTENT_RETRY_ATTEMPTS
    : DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS;

export const MAX_TARGET_URL_LENGTH = 2048;
export const MAX_BODY_TEMPLATE_LENGTH = 100_000;

/** Techo de entradas en `headers` y en `queryParams`. */
export const MAX_KEY_VALUE_ENTRIES = 20;
export const MAX_KEY_VALUE_VALUE_LENGTH = 2_000;

/** Nombre de cabecera o parametro: token HTTP sin separadores ni saltos de linea. */
export const KEY_VALUE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Nombre de parametro de consulta: como el de cabecera, mas los corchetes.
 *
 * Los corchetes son los de la convencion JSON:API (`page[number]`,
 * `filter[search]`) que usa Drupal. En una cabecera no caben (no son `tchar`,
 * RFC 9110 §5.6.2), y en la query el cliente HTTP los codifica al serializar.
 */
export const QUERY_PARAM_NAME_PATTERN = /^[A-Za-z0-9_.[\]-]{1,100}$/;

/**
 * Cabeceras que el operador NO puede fijar a mano.
 *
 * `authorization` y `cookie` porque la autenticacion entra SOLO por credencial
 * de la boveda: un token escrito aqui quedaria en claro en el `pipeline_schema`,
 * en cada checkpoint y en el JSON exportado. Las demas las calcula el propio
 * cliente HTTP, y fijarlas a mano produce peticiones que el servidor rechaza.
 */
export const FORBIDDEN_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

/**
 * URL absoluta http(s), o una URL que EMPIEZA por un marcador.
 *
 * La segunda forma es la que permite tomar la direccion entera de un paso
 * anterior (`{{scraped_web.url}}`, `{{parsed_email.extracted_urls[0]}}`): antes
 * se rechazaba con un 400 y solo cabia interpolar tramos de una URL literal.
 * El protocolo de esa forma no se puede comprobar aqui, porque no existe hasta
 * ejecutar; lo comprueba la guarda SSRF de la estrategia sobre la URL ya
 * interpolada, que solo admite http y https.
 */
export const TARGET_URL_PATTERN =
  /^(?:https?:\/\/\S+|\{\{\s*[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+|\[\d+\])+\s*\}\}\S*)$/i;

/**
 * Valida un mapa `Record<string, string>`.
 *
 * `class-validator` no recorre las claves de un `Record`, asi que el limite de
 * entradas, la forma de cada nombre y la lista de cabeceras prohibidas se
 * comprueban aqui. El primer argumento de `constraints` dice si el mapa son
 * cabeceras (`'headers'`), que son las unicas con nombres prohibidos.
 */
@ValidatorConstraint({ name: 'isStringRecord', async: false })
export class IsStringRecordConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown, args: ValidationArguments): boolean {
    return this.describeProblem(value, args) === null;
  }

  public defaultMessage(args: ValidationArguments): string {
    return (
      this.describeProblem(args.value, args) ??
      `${args.property} no es un mapa valido.`
    );
  }

  private describeProblem(
    value: unknown,
    args: ValidationArguments,
  ): string | null {
    const isHeaders = args.constraints[0] === 'headers';

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `${args.property} debe ser un objeto { nombre: valor }.`;
    }

    const entries = Object.entries(value as Record<string, unknown>);

    if (entries.length > MAX_KEY_VALUE_ENTRIES) {
      return `${args.property} no puede declarar mas de ${MAX_KEY_VALUE_ENTRIES} entradas.`;
    }

    for (const [name, entry] of entries) {
      const namePattern = isHeaders
        ? KEY_VALUE_NAME_PATTERN
        : QUERY_PARAM_NAME_PATTERN;

      if (!namePattern.test(name)) {
        return `${args.property}: "${name}" no es un nombre valido (letras, digitos, ".", "-" y "_"${isHeaders ? '' : ', y corchetes'}).`;
      }

      if (isHeaders && FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
        return `headers: la cabecera "${name}" no se puede fijar a mano; la autenticacion va por credencial (authType + authConfig).`;
      }

      if (typeof entry !== 'string') {
        return `${args.property}.${name} debe ser una cadena.`;
      }

      if (entry.length > MAX_KEY_VALUE_VALUE_LENGTH || /[\r\n]/.test(entry)) {
        return `${args.property}.${name} no puede superar ${MAX_KEY_VALUE_VALUE_LENGTH} caracteres ni contener saltos de linea.`;
      }
    }

    return null;
  }
}

/**
 * Validez de `method` y coherencia con `bodyType` / `bodyTemplate`, AL GUARDAR.
 *
 * GET y DELETE no llevan cuerpo (muchos servidores y proxies lo descartan o
 * rechazan); JSON y FORM_DATA exigen una plantilla que ya sea JSON valido
 * —los marcadores viven DENTRO de las cadenas, asi que la plantilla sin
 * interpolar parsea igual—; FORM_DATA, ademas, un objeto plano de cadenas.
 */
@ValidatorConstraint({ name: 'isCoherentHttpBody', async: false })
export class IsCoherentHttpBodyConstraint implements ValidatorConstraintInterface {
  public validate(_value: unknown, args: ValidationArguments): boolean {
    return describeBodyProblem(args.object) === null;
  }

  public defaultMessage(args: ValidationArguments): string {
    return (
      describeBodyProblem(args.object) ??
      'bodyTemplate no es coherente con bodyType.'
    );
  }
}

const describeBodyProblem = (
  dto: HttpGenericDestinationConfigDto,
): string | null => {
  if (
    dto.method !== undefined &&
    !(Object.values(HttpGenericMethod) as unknown[]).includes(dto.method)
  ) {
    return `method debe ser uno de: ${Object.values(HttpGenericMethod).join(', ')}.`;
  }

  const method = dto.method ?? DEFAULT_HTTP_GENERIC_METHOD;
  const bodyType = dto.bodyType ?? DEFAULT_HTTP_GENERIC_BODY_TYPE;
  const template = dto.bodyTemplate?.trim() ?? '';

  if (
    (method === HttpGenericMethod.GET || method === HttpGenericMethod.DELETE) &&
    bodyType !== HttpGenericBodyType.NONE
  ) {
    return `Un ${method} no lleva cuerpo: bodyType debe ser NONE.`;
  }

  if (
    template === '' ||
    (bodyType !== HttpGenericBodyType.JSON &&
      bodyType !== HttpGenericBodyType.FORM_DATA)
  ) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(template);
  } catch {
    return `bodyTemplate debe ser JSON valido cuando bodyType es ${bodyType} (los marcadores {{ns.campo}} van dentro de cadenas).`;
  }

  if (bodyType === HttpGenericBodyType.FORM_DATA) {
    const isFlatStringObject =
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((field) => typeof field === 'string');

    if (!isFlatStringObject) {
      return 'bodyTemplate de FORM_DATA debe ser un objeto plano de cadenas: {"campo": "valor"}.';
    }
  }

  return null;
};

/** Referencia a la credencial de la boveda. Nunca el secreto. */
export class HttpGenericAuthConfigDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all', { message: 'authConfig.credentialId debe ser un UUID.' })
  credentialId?: string;
}

/**
 * `params` del nodo DESTINO_HTTP_GENERICO.
 *
 * TODO es opcional, como en el resto de destinos: una plantilla de flujo se
 * guarda con `params: {}` y lo que hace falta para EJECUTAR lo exige
 * `getIncompleteParams` al activar. Los defectos se aplican en
 * `resolveHttpGenericDestinationConfig`, nunca con inicializadores.
 *
 * `outputNamespace` NO es un param: es del nodo (`PipelineNodeConfigDto`), con
 * `http_generic_response` como defecto en el asistente.
 */
export class HttpGenericDestinationConfigDto {
  @ApiPropertyOptional({ example: 'https://api.ejemplo.org/v1/avisos' })
  @IsOptional()
  @IsString({ message: 'targetUrl debe ser una cadena.' })
  @MaxLength(MAX_TARGET_URL_LENGTH, {
    message: `targetUrl no puede superar ${MAX_TARGET_URL_LENGTH} caracteres.`,
  })
  @Matches(TARGET_URL_PATTERN, {
    message:
      'targetUrl debe ser una URL absoluta http(s), o empezar por una variable {{ns.campo}}, sin espacios.',
  })
  targetUrl?: string;

  /**
   * Sin `@IsOptional`: este campo lleva tambien la coherencia metodo/cuerpo,
   * que debe comprobarse aunque `method` falte (un `bodyType: JSON` con el
   * metodo por defecto) y aunque no haya plantilla (un GET con cuerpo).
   * `@IsOptional` saltaria TODOS los validadores de la propiedad cuando vale
   * `undefined`, asi que la presencia se decide con `ValidateIf`.
   */
  @ApiPropertyOptional({ enum: HttpGenericMethod })
  @ValidateIf(
    (dto: HttpGenericDestinationConfigDto) =>
      dto.method !== undefined ||
      dto.bodyType !== undefined ||
      dto.bodyTemplate !== undefined,
  )
  @Validate(IsCoherentHttpBodyConstraint)
  method?: HttpGenericMethod;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject({ message: 'headers debe ser un objeto.' })
  @Validate(IsStringRecordConstraint, ['headers'])
  headers?: Record<string, string>;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject({ message: 'queryParams debe ser un objeto.' })
  @Validate(IsStringRecordConstraint, ['queryParams'])
  queryParams?: Record<string, string>;

  @ApiPropertyOptional({ enum: HttpGenericBodyType })
  @IsOptional()
  @IsEnum(HttpGenericBodyType, {
    message: `bodyType debe ser uno de: ${Object.values(HttpGenericBodyType).join(', ')}.`,
  })
  bodyType?: HttpGenericBodyType;

  /** La coherencia con `method` / `bodyType` la valida el campo `method`. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'bodyTemplate debe ser una cadena.' })
  @MaxLength(MAX_BODY_TEMPLATE_LENGTH, {
    message: `bodyTemplate no puede superar ${MAX_BODY_TEMPLATE_LENGTH} caracteres.`,
  })
  bodyTemplate?: string;

  @ApiPropertyOptional({ enum: HttpGenericAuthType })
  @IsOptional()
  @IsEnum(HttpGenericAuthType, {
    message: `authType debe ser uno de: ${Object.values(HttpGenericAuthType).join(', ')}.`,
  })
  authType?: HttpGenericAuthType;

  @ApiPropertyOptional({ type: HttpGenericAuthConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => HttpGenericAuthConfigDto)
  authConfig?: HttpGenericAuthConfigDto;

  @ApiPropertyOptional({
    minimum: MIN_HTTP_GENERIC_TIMEOUT_MS,
    maximum: MAX_HTTP_GENERIC_TIMEOUT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un entero.' })
  @Min(MIN_HTTP_GENERIC_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_HTTP_GENERIC_TIMEOUT_MS}.`,
  })
  @Max(MAX_HTTP_GENERIC_TIMEOUT_MS, {
    message: `timeoutMs no puede superar ${MAX_HTTP_GENERIC_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({
    description: `Reintentos ante 5xx, timeout o red caida, con backoff exponencial. Por defecto ${DEFAULT_HTTP_GENERIC_IDEMPOTENT_RETRY_ATTEMPTS} en GET/PUT/DELETE y ${DEFAULT_HTTP_GENERIC_RETRY_ATTEMPTS} en POST/PATCH`,
    minimum: 0,
    maximum: MAX_HTTP_GENERIC_RETRY_ATTEMPTS,
  })
  @IsOptional()
  @IsInt({ message: 'retryAttempts debe ser un entero.' })
  @Min(0, { message: 'retryAttempts no puede ser negativo.' })
  @Max(MAX_HTTP_GENERIC_RETRY_ATTEMPTS, {
    message: `retryAttempts no puede superar ${MAX_HTTP_GENERIC_RETRY_ATTEMPTS}.`,
  })
  retryAttempts?: number;
}

/** Configuracion con los defectos aplicados. */
export interface ResolvedHttpGenericDestinationConfig {
  readonly targetUrl: string | null;
  readonly method: HttpGenericMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly queryParams: Readonly<Record<string, string>>;
  readonly bodyType: HttpGenericBodyType;
  readonly bodyTemplate: string | null;
  readonly authType: HttpGenericAuthType;
  readonly credentialId: string | null;
  readonly timeoutMs: number;
  readonly retryAttempts: number;
}

const trimmedOrNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * Aplica los defectos sobre un DTO ya validado. Funcion pura.
 *
 * `bodyTemplate` NO se recorta: en RAW_TEXT un espacio o un salto de linea
 * final puede ser parte del contrato del destino. Solo se anula si esta vacio.
 */
export const resolveHttpGenericDestinationConfig = (
  dto: HttpGenericDestinationConfigDto,
): ResolvedHttpGenericDestinationConfig => {
  const method = dto.method ?? DEFAULT_HTTP_GENERIC_METHOD;

  return {
    targetUrl: trimmedOrNull(dto.targetUrl),
    method,
    headers: { ...(dto.headers ?? {}) },
    queryParams: { ...(dto.queryParams ?? {}) },
    bodyType: dto.bodyType ?? DEFAULT_HTTP_GENERIC_BODY_TYPE,
    bodyTemplate:
      dto.bodyTemplate === undefined || dto.bodyTemplate.trim().length === 0
        ? null
        : dto.bodyTemplate,
    authType: dto.authType ?? DEFAULT_HTTP_GENERIC_AUTH_TYPE,
    credentialId: trimmedOrNull(dto.authConfig?.credentialId),
    timeoutMs: dto.timeoutMs ?? DEFAULT_HTTP_GENERIC_TIMEOUT_MS,
    retryAttempts: dto.retryAttempts ?? defaultRetryAttemptsFor(method),
  };
};
