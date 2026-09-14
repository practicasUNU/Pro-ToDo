import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  registerDecorator,
  IsNotEmpty,
  IsNotEmptyObject,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
} from 'class-validator';

import type { SelectiveErrorFallback } from '@core/fsm/types/pipeline-schema.types';
import type {
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraintInterface,
} from 'class-validator';

import {
  MAX_RETRY_ATTEMPTS,
  NodeType,
  OUTPUT_NAMESPACE_PATTERN,
  SEMVER_PATTERN,
} from '@core/fsm/types/pipeline-schema.types';

/**
 * Valida la union de `onErrorStep`: `null`, cadena, o ruta selectiva.
 *
 * Se escribe a mano porque class-validator no sabe validar uniones con sus
 * decoradores de serie: `@IsString()` rechazaria el objeto y `@ValidateNested()`
 * rechazaria la cadena.
 *
 * Comprueba el INTERIOR del objeto el mismo, y eso no es opcional: `whitelist`
 * solo poda las propiedades de clases anidadas declaradas con
 * `@ValidateNested()`, de modo que un objeto suelto entraria sin que nadie mire
 * sus claves y el motor acabaria saltando a un `targetNode` que no es una
 * cadena.
 */
@ValidatorConstraint({ name: 'isErrorRoute', async: false })
class IsErrorRouteConstraint implements ValidatorConstraintInterface {
  public validate(value: unknown): boolean {
    if (value === null) {
      return true;
    }

    if (typeof value === 'string') {
      return value.trim() !== '';
    }

    if (typeof value !== 'object') {
      return false;
    }

    const route = value as Partial<SelectiveErrorFallback>;

    return (
      typeof route.targetNode === 'string' &&
      route.targetNode.trim() !== '' &&
      Array.isArray(route.catchErrors) &&
      route.catchErrors.every(
        (code) => typeof code === 'string' && code.trim() !== '',
      )
    );
  }

  public defaultMessage(args: ValidationArguments): string {
    return `${args.property} debe ser null, el nodeId destino, o un objeto { targetNode, catchErrors[] }.`;
  }
}

/** Decorador de la union de `onErrorStep`. */
const IsErrorRoute =
  (options?: ValidationOptions) =>
  (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: options ?? {},
      validator: IsErrorRouteConstraint,
    });
  };

/**
 * Politica de ejecucion del flujo completo.
 *
 * Se declara aqui y no como campo suelto porque `PipelineValidatorService` valida
 * con `forbidNonWhitelisted`: un `executionPolicy` que no figure en este DTO se
 * rechaza con un 400 en vez de ignorarse, asi que la unica forma de que la
 * politica viaje en el esquema es declararla.
 */
export class ExecutionPolicyDto {
  @ApiPropertyOptional({
    description:
      'Desactiva el flujo tras la primera ejecucion que recorra el grafo entero con exito',
    example: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'stopOnFirstSuccess debe ser booleano.' })
  stopOnFirstSuccess?: boolean;
}

/** Politica de reintentos declarada por un nodo del pipeline. */
export class RetryPolicyDto {
  @ApiProperty({
    description: 'Reintentos adicionales tras el primer intento fallido',
    example: 2,
    minimum: 0,
    maximum: MAX_RETRY_ATTEMPTS,
  })
  @IsInt({ message: 'maxRetries debe ser un numero entero.' })
  @Min(0, { message: 'maxRetries no puede ser negativo.' })
  @Max(MAX_RETRY_ATTEMPTS, {
    message: `maxRetries no puede superar ${MAX_RETRY_ATTEMPTS}.`,
  })
  maxRetries: number;

  @ApiPropertyOptional({
    description: 'Espera base en milisegundos antes del primer reintento',
    example: 1000,
  })
  @IsOptional()
  @IsNumber({}, { message: 'backoffMs debe ser un numero.' })
  @IsPositive({ message: 'backoffMs debe ser mayor que cero.' })
  backoffMs?: number;

  @ApiPropertyOptional({
    description: 'Multiplicador aplicado al backoff en cada reintento',
    example: 2,
  })
  @IsOptional()
  @IsNumber({}, { message: 'backoffFactor debe ser un numero.' })
  @IsPositive({ message: 'backoffFactor debe ser mayor que cero.' })
  backoffFactor?: number;
}

/** Configuracion de un nodo del grafo (`PipelineSchemaDto.nodes[clave]`). */
export class PipelineNodeConfigDto {
  @ApiProperty({
    description:
      'Identificador del nodo; debe coincidir con su clave en el mapa',
    example: 'nodo_trigger',
  })
  @IsString({ message: 'nodeId debe ser una cadena.' })
  @IsNotEmpty({ message: 'nodeId no puede estar vacio.' })
  @MaxLength(50)
  nodeId: string;

  @ApiProperty({
    description: 'Tipo de estrategia que ejecutara este nodo',
    enum: NodeType,
    example: NodeType.TRIGGER_IMAP,
  })
  @IsEnum(NodeType, {
    message: `nodeType debe ser uno de: ${Object.values(NodeType).join(', ')}.`,
  })
  nodeType: NodeType;

  @ApiProperty({
    description:
      'Namespace bajo el que el nodo escribe en el StatePayloadContext',
    example: 'raw_email',
    pattern: OUTPUT_NAMESPACE_PATTERN.source,
  })
  @IsString({ message: 'outputNamespace debe ser una cadena.' })
  @Matches(OUTPUT_NAMESPACE_PATTERN, {
    message:
      'outputNamespace solo admite minusculas, digitos y guion bajo (snake_case).',
  })
  @MaxLength(50)
  outputNamespace: string;

  @ApiProperty({
    description:
      'Siguiente nodo del camino activo, o null si es el nodo terminal',
    example: 'nodo_parser',
    nullable: true,
  })
  // `null` es un valor legitimo (nodo terminal), no una ausencia: se salta la
  // validacion en ese caso concreto en lugar de aceptarlo con @IsOptional, que
  // tambien dejaria pasar `undefined`.
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString({ message: 'nextStep debe ser una cadena o null.' })
  @IsNotEmpty({ message: 'nextStep no puede ser una cadena vacia.' })
  nextStep: string | null;

  @ApiProperty({
    description:
      'Ruta de recuperacion: el nodeId destino (respaldo incondicional), un objeto { targetNode, catchErrors } que solo atrapa los codigos declarados, o null para detener la ejecucion',
    example: { targetNode: 'nodo_alerta', catchErrors: ['ERR_IMAP_TIMEOUT'] },
    nullable: true,
  })
  // Se conserva el `@ValidateIf` por el mismo motivo que en `nextStep`: `null`
  // es un valor legitimo y `@IsOptional()` dejaria pasar tambien `undefined`.
  @ValidateIf((_, value: unknown) => value !== null)
  @IsErrorRoute()
  onErrorStep: string | SelectiveErrorFallback | null;

  @ApiPropertyOptional({
    description: 'Politica de reintentos; si se omite, el nodo no reintenta',
    type: RetryPolicyDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => RetryPolicyDto)
  retryPolicy?: RetryPolicyDto;

  @ApiProperty({
    description:
      'Parametros propios del tipo de nodo; cada estrategia valida los suyos',
    example: { host: 'imap.unuware.com', folder: 'INBOX' },
  })
  @IsObject({ message: 'params debe ser un objeto.' })
  params: Record<string, unknown>;
}

/** Esquema completo del pipeline de un flujo (`flujos.configuracion_pipeline`). */
export class PipelineSchemaDto {
  @ApiProperty({
    description: 'Identificador del flujo al que pertenece el esquema',
    example: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  })
  @IsString({ message: 'flowId debe ser una cadena.' })
  @IsNotEmpty({ message: 'flowId no puede estar vacio.' })
  flowId: string;

  @ApiProperty({
    description: 'Nombre legible del pipeline',
    example: 'Notiweb - publicacion automatica',
  })
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name no puede estar vacio.' })
  @MaxLength(100)
  name: string;

  @ApiProperty({
    description: 'Version del esquema en formato SemVer',
    example: '1.0.0',
    pattern: SEMVER_PATTERN.source,
  })
  @IsString({ message: 'version debe ser una cadena.' })
  @Matches(SEMVER_PATTERN, {
    message: 'version debe seguir el formato SemVer MAJOR.MINOR.PATCH.',
  })
  version: string;

  @ApiProperty({
    description: 'Clave de `nodes` por la que arranca el camino activo',
    example: 'nodo_trigger',
  })
  @IsString({ message: 'entrypoint debe ser una cadena.' })
  @IsNotEmpty({ message: 'entrypoint no puede estar vacio.' })
  entrypoint: string;

  @ApiProperty({
    description: 'Mapa de nodos indexado por nodeId',
    type: 'object',
    additionalProperties: {
      $ref: '#/components/schemas/PipelineNodeConfigDto',
    },
  })
  // Sin @ValidateNested({ each: true }) ni @Type: class-validator 0.15.1 solo
  // itera Array, Set y Map (ValidationExecutor.js:272). Con un Record valida el
  // mapa entero como si fuera un unico PipelineNodeConfigDto y, junto a
  // forbidNonWhitelisted, reporta cada nodeId como "property X should not exist"
  // sin llegar a validar un solo campo real. La iteracion nodo a nodo la hace
  // PipelineValidatorService, que ademas conserva el path exacto del error.
  @IsObject({ message: 'nodes debe ser un objeto indexado por nodeId.' })
  @IsNotEmptyObject(
    { nullable: false },
    { message: 'nodes debe declarar al menos un nodo.' },
  )
  nodes: Record<string, PipelineNodeConfigDto>;

  @ApiPropertyOptional({
    description:
      'Politica del flujo completo; si se omite, la ejecucion no altera el flujo',
    type: ExecutionPolicyDto,
  })
  // `@ValidateNested()` SI funciona aqui, a diferencia del `nodes` de arriba:
  // lo que class-validator no sabe recorrer es un Record, no un objeto suelto.
  @IsOptional()
  @ValidateNested()
  @Type(() => ExecutionPolicyDto)
  executionPolicy?: ExecutionPolicyDto;
}
