import { ApiPropertyOptional } from '@nestjs/swagger';
import {
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
}

/** Configuracion con los defectos aplicados. */
export interface ResolvedAcensHttpConfig {
  readonly method: AcensHttpMethod;
  readonly endpointPath: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadTemplate: string | null;
  readonly timeoutMs: number;
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
  };
};
