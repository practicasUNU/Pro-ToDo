import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidatorConstraint,
} from 'class-validator';

import { IsStringRecordConstraint } from './http-generic-destination-config.dto';

import type {
  ValidationArguments,
  ValidatorConstraintInterface,
} from 'class-validator';

/** Verbos que admite la API de Acens. Enum porque `@IsEnum` necesita runtime. */
export enum AcensHttpMethod {
  GET = 'GET',
  POST = 'POST',
  PUT = 'PUT',
  DELETE = 'DELETE',
}

export const DEFAULT_ACENS_METHOD = AcensHttpMethod.POST;

/** Espera por defecto del nodo; el techo real lo pone `ACENS_API_TIMEOUT_MS`. */
export const DEFAULT_ACENS_TIMEOUT_MS = 15_000;
export const MIN_ACENS_TIMEOUT_MS = 1_000;
export const MAX_ACENS_TIMEOUT_MS = 60_000;

export const MAX_ACENS_ENDPOINT_PATH_LENGTH = 512;
export const MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH = 100_000;

/**
 * Ruta RELATIVA a la raiz de Acens: empieza por `/`, sin esquema, sin `//`
 * (que `new URL` leeria como otro host), sin `..` ni `\` y sin espacios. Los
 * marcadores `{{ns.campo}}` caben porque llaves y puntos son legales aqui.
 *
 * La raiz la fija el entorno; esta forma es lo que impide que un `params`
 * redirija la clave de Acens a otro servidor.
 */
export const ACENS_ENDPOINT_PATH_PATTERN = /^\/(?!\/)(?!.*\.\.)[^\s\\]*$/;

/** GET y DELETE no llevan cuerpo; el resto, si lo lleva, debe ser JSON valido. */
@ValidatorConstraint({ name: 'isCoherentAcensPayload', async: false })
export class IsCoherentAcensPayloadConstraint implements ValidatorConstraintInterface {
  public validate(_value: unknown, args: ValidationArguments): boolean {
    return describePayloadProblem(args.object) === null;
  }

  public defaultMessage(args: ValidationArguments): string {
    return (
      describePayloadProblem(args.object) ??
      'payloadTemplate no es coherente con method.'
    );
  }
}

const describePayloadProblem = (dto: AcensHttpConfigDto): string | null => {
  if (
    dto.method !== undefined &&
    !(Object.values(AcensHttpMethod) as unknown[]).includes(dto.method)
  ) {
    return `method debe ser uno de: ${Object.values(AcensHttpMethod).join(', ')}.`;
  }

  const method = dto.method ?? DEFAULT_ACENS_METHOD;
  const template = dto.payloadTemplate?.trim() ?? '';

  if (template === '') {
    return null;
  }

  if (method === AcensHttpMethod.GET || method === AcensHttpMethod.DELETE) {
    return `Un ${method} no lleva cuerpo: deja payloadTemplate vacio.`;
  }

  try {
    JSON.parse(template);
  } catch {
    return 'payloadTemplate debe ser JSON valido (los marcadores {{ns.campo}} van dentro de cadenas).';
  }

  return null;
};

/**
 * Que hace el nodo con Acens.
 *
 * - `RAW_REQUEST` (defecto): peticion libre (verbo, ruta, cabeceras y cuerpo
 *   interpolados). Es el comportamiento de siempre.
 * - `CREATE_CAMPAIGN`: crea la campana del boletin en
 *   `POST /api/1/createCampaign/` con parametros tipados; la ruta y el cuerpo
 *   los compone la estrategia, no el flujo.
 */
export enum AcensOperation {
  RAW_REQUEST = 'RAW_REQUEST',
  CREATE_CAMPAIGN = 'CREATE_CAMPAIGN',
}

/** Ruta FIJA de la creacion de campanas, relativa a `ACENS_API_BASE_URL`. */
export const ACENS_CREATE_CAMPAIGN_PATH = '/api/1/createCampaign/';

export const DEFAULT_ACENS_CAMPAIGN_FROM_NAME = 'Notiweb';
export const DEFAULT_ACENS_CAMPAIGN_FROM_EMAIL = 'notiweb@madrimasd.org';
export const DEFAULT_ACENS_CAMPAIGN_NAME_PREFIX = 'Notiweb';
export const DEFAULT_ACENS_CAMPAIGN_SUBJECT_PREFIX =
  'Servicio NotiWEB de madri+d';
/** Namespace del que sale el marcado ya validado de las noticias. */
export const DEFAULT_ACENS_CONTENT_NAMESPACE = 'validated_drupal_json';

export const MAX_ACENS_CAMPAIGN_TEXT_LENGTH = 200;
export const MAX_ACENS_LIST_ID_LENGTH = 64;

/** Identificador de lista: alfanumerico, guion o guion bajo. */
export const ACENS_LIST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Nombre de namespace del contexto (snake_case). */
export const ACENS_NAMESPACE_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * `params` del nodo DESTINO_ACENS.
 *
 * NO lleva URL base ni credencial: salen de `AcensApiConfig` (entorno). Todo es
 * opcional al guardar, como en el resto de destinos; lo que falta para EJECUTAR
 * (`endpointPath`) lo declara `getIncompleteParams` de la estrategia.
 */
export class AcensHttpConfigDto {
  /**
   * Sin `@IsOptional`: este campo lleva tambien la coherencia metodo/cuerpo,
   * que debe comprobarse aunque `method` falte (un cuerpo con el POST por
   * defecto). `@IsOptional` saltaria TODOS sus validadores con `undefined`.
   */
  @ApiPropertyOptional({ enum: AcensHttpMethod })
  @ValidateIf(
    (dto: AcensHttpConfigDto) =>
      dto.method !== undefined || dto.payloadTemplate !== undefined,
  )
  @Validate(IsCoherentAcensPayloadConstraint)
  method?: AcensHttpMethod;

  @ApiPropertyOptional({
    example: '/mailing/campaigns/{{llm_response.campaign_id}}',
  })
  @IsOptional()
  @IsString({ message: 'endpointPath debe ser una cadena.' })
  @MaxLength(MAX_ACENS_ENDPOINT_PATH_LENGTH, {
    message: `endpointPath no puede superar ${MAX_ACENS_ENDPOINT_PATH_LENGTH} caracteres.`,
  })
  @Matches(ACENS_ENDPOINT_PATH_PATTERN, {
    message:
      'endpointPath debe ser una ruta relativa que empiece por "/" (sin esquema, sin "//", sin ".." ni espacios): la URL base la fija el servidor.',
  })
  endpointPath?: string;

  /** Reusa la validacion del destino generico: `Authorization` queda vetada. */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject({ message: 'headers debe ser un objeto.' })
  @Validate(IsStringRecordConstraint, ['headers'])
  headers?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: 'payloadTemplate debe ser una cadena.' })
  @MaxLength(MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH, {
    message: `payloadTemplate no puede superar ${MAX_ACENS_PAYLOAD_TEMPLATE_LENGTH} caracteres.`,
  })
  payloadTemplate?: string;

  @ApiPropertyOptional({
    minimum: MIN_ACENS_TIMEOUT_MS,
    maximum: MAX_ACENS_TIMEOUT_MS,
  })
  @IsOptional()
  @IsInt({ message: 'timeoutMs debe ser un entero.' })
  @Min(MIN_ACENS_TIMEOUT_MS, {
    message: `timeoutMs no puede ser menor que ${MIN_ACENS_TIMEOUT_MS}.`,
  })
  @Max(MAX_ACENS_TIMEOUT_MS, {
    message: `timeoutMs no puede superar ${MAX_ACENS_TIMEOUT_MS}.`,
  })
  timeoutMs?: number;

  @ApiPropertyOptional({
    enum: AcensOperation,
    default: AcensOperation.RAW_REQUEST,
  })
  @IsOptional()
  @IsEnum(AcensOperation, {
    message: `operation debe ser uno de: ${Object.values(AcensOperation).join(', ')}.`,
  })
  operation?: AcensOperation;

  @ApiPropertyOptional({ description: 'Lista de destinatarios de la campana' })
  @IsOptional()
  @IsString({ message: 'listId debe ser una cadena.' })
  @MaxLength(MAX_ACENS_LIST_ID_LENGTH, {
    message: `listId no puede superar ${MAX_ACENS_LIST_ID_LENGTH} caracteres.`,
  })
  @Matches(ACENS_LIST_ID_PATTERN, {
    message: 'listId solo admite letras, digitos, guion y guion bajo.',
  })
  listId?: string;

  @ApiPropertyOptional({ default: DEFAULT_ACENS_CAMPAIGN_FROM_NAME })
  @IsOptional()
  @IsString({ message: 'fromName debe ser una cadena.' })
  @MaxLength(MAX_ACENS_CAMPAIGN_TEXT_LENGTH, {
    message: `fromName no puede superar ${MAX_ACENS_CAMPAIGN_TEXT_LENGTH} caracteres.`,
  })
  fromName?: string;

  @ApiPropertyOptional({ default: DEFAULT_ACENS_CAMPAIGN_FROM_EMAIL })
  @IsOptional()
  @IsEmail({}, { message: 'fromEmail debe ser un correo valido.' })
  fromEmail?: string;

  @ApiPropertyOptional({ default: DEFAULT_ACENS_CAMPAIGN_NAME_PREFIX })
  @IsOptional()
  @IsString({ message: 'campaignNamePrefix debe ser una cadena.' })
  @MaxLength(MAX_ACENS_CAMPAIGN_TEXT_LENGTH, {
    message: `campaignNamePrefix no puede superar ${MAX_ACENS_CAMPAIGN_TEXT_LENGTH} caracteres.`,
  })
  campaignNamePrefix?: string;

  @ApiPropertyOptional({ default: DEFAULT_ACENS_CAMPAIGN_SUBJECT_PREFIX })
  @IsOptional()
  @IsString({ message: 'subjectPrefix debe ser una cadena.' })
  @MaxLength(MAX_ACENS_CAMPAIGN_TEXT_LENGTH, {
    message: `subjectPrefix no puede superar ${MAX_ACENS_CAMPAIGN_TEXT_LENGTH} caracteres.`,
  })
  subjectPrefix?: string;

  @ApiPropertyOptional({ default: DEFAULT_ACENS_CONTENT_NAMESPACE })
  @IsOptional()
  @IsString({ message: 'contentNamespace debe ser una cadena.' })
  @Matches(ACENS_NAMESPACE_PATTERN, {
    message: 'contentNamespace debe ser un namespace en snake_case.',
  })
  contentNamespace?: string;
}

/** Configuracion con los defectos aplicados. */
export interface ResolvedAcensHttpConfig {
  readonly method: AcensHttpMethod;
  readonly endpointPath: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadTemplate: string | null;
  readonly timeoutMs: number;
  readonly operation: AcensOperation;
  /** `null` si no se declaro: obligatorio para ejecutar una campana. */
  readonly listId: string | null;
  readonly fromName: string;
  readonly fromEmail: string;
  readonly campaignNamePrefix: string;
  readonly subjectPrefix: string;
  readonly contentNamespace: string;
}

/** Aplica los defectos sobre un DTO ya validado. Funcion pura. */
export const resolveAcensHttpConfig = (
  dto: AcensHttpConfigDto,
): ResolvedAcensHttpConfig => {
  const endpointPath = dto.endpointPath?.trim() ?? '';
  const payloadTemplate = dto.payloadTemplate?.trim() ?? '';

  return {
    method: dto.method ?? DEFAULT_ACENS_METHOD,
    endpointPath: endpointPath.length === 0 ? null : endpointPath,
    headers: { ...(dto.headers ?? {}) },
    payloadTemplate: payloadTemplate.length === 0 ? null : payloadTemplate,
    timeoutMs: dto.timeoutMs ?? DEFAULT_ACENS_TIMEOUT_MS,
    operation: dto.operation ?? AcensOperation.RAW_REQUEST,
    listId:
      (dto.listId?.trim() ?? '') === '' ? null : (dto.listId?.trim() ?? null),
    fromName: dto.fromName?.trim() || DEFAULT_ACENS_CAMPAIGN_FROM_NAME,
    fromEmail: dto.fromEmail?.trim() || DEFAULT_ACENS_CAMPAIGN_FROM_EMAIL,
    campaignNamePrefix:
      dto.campaignNamePrefix?.trim() || DEFAULT_ACENS_CAMPAIGN_NAME_PREFIX,
    subjectPrefix:
      dto.subjectPrefix?.trim() || DEFAULT_ACENS_CAMPAIGN_SUBJECT_PREFIX,
    contentNamespace:
      dto.contentNamespace?.trim() || DEFAULT_ACENS_CONTENT_NAMESPACE,
  };
};
