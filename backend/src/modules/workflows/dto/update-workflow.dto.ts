import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Longitud de `flujos.nombre` en el esquema SQL. */
const MAX_NAME_LENGTH = 100;

/** Longitud de `flujos.descripcion` en el esquema SQL. */
const MAX_DESCRIPTION_LENGTH = 255;

/**
 * Cuerpo de `PATCH /api/workflows/:id`: edicion de un flujo ya instanciado.
 *
 * NO es un `PartialType(CreateWorkflowDto)`, y la diferencia importa: ese DTO
 * incluye `templateId`, y el maestro del que nacio un flujo es un hecho
 * historico. Dejar reescribirlo permitiria falsear la procedencia de un flujo
 * despues de crearlo, que es justo lo que la columna existe para registrar.
 *
 * `pipelineSchema` se declara como objeto sin validar su estructura aqui, por el
 * mismo motivo que en `CreateWorkflowDto`: lo hace `PipelineValidatorService` en
 * sus dos capas y con un unico formato de error.
 *
 * Todos los campos son opcionales para que un cambio de estado sea
 * `{ "active": true }` a secas, sin obligar a reenviar el grafo completo.
 */
export class UpdateWorkflowDto {
  @ApiPropertyOptional({
    description: 'Nombre institucional del flujo',
    maxLength: MAX_NAME_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'name debe ser una cadena.' })
  @MaxLength(MAX_NAME_LENGTH, {
    message: `name no puede superar ${MAX_NAME_LENGTH} caracteres.`,
  })
  readonly name?: string;

  @ApiPropertyOptional({
    description: 'Descripcion legible del proposito del flujo',
    maxLength: MAX_DESCRIPTION_LENGTH,
  })
  @IsOptional()
  @IsString({ message: 'description debe ser una cadena.' })
  @MaxLength(MAX_DESCRIPTION_LENGTH, {
    message: `description no puede superar ${MAX_DESCRIPTION_LENGTH} caracteres.`,
  })
  readonly description?: string;

  @ApiPropertyOptional({
    description:
      'Habilitacion frente a los disparadores automaticos (Cron, IMAP). Activar exige un pipeline_schema valido',
  })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser un booleano.' })
  readonly active?: boolean;

  @ApiPropertyOptional({
    description:
      'Grafo declarativo nuevo. Se revalida por completo antes de escribirse',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject({ message: 'pipelineSchema debe ser un objeto.' })
  @IsNotEmptyObject(
    { nullable: false },
    { message: 'pipelineSchema no puede estar vacio.' },
  )
  readonly pipelineSchema?: Record<string, unknown>;
}
