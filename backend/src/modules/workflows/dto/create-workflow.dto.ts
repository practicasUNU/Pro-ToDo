import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
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
 * Cuerpo de `POST /api/workflows`: alta de un flujo desde el asistente.
 *
 * `pipelineSchema` se declara como objeto SIN validar aqui su estructura, y es
 * deliberado: `PipelineValidatorService.validateSchema()` ya hace las dos capas
 * —forma y tipos con `PipelineSchemaDto`, integridad del grafo con
 * `validatePipelineTopology`— y devuelve `BadRequestException` con la lista
 * exacta de campos invalidos.
 *
 * Anidar aqui un `@ValidateNested()` sobre `PipelineSchemaDto` duplicaria la
 * primera capa y produciria DOS formatos de error distintos para el mismo fallo
 * segun cual saltara antes: el del `ValidationPipe` global y el del validador.
 * El servicio delega en la pieza ya probada y el cliente recibe siempre el mismo
 * contrato de error.
 *
 * No existe campo `createdById`: la autoria se toma del token JWT, nunca del
 * cuerpo, para que no se pueda suplantar (mismo criterio que `CreateTemplateDto`).
 */
export class CreateWorkflowDto {
  @ApiProperty({
    description: 'Nombre institucional del flujo',
    example: 'Notiweb - publicacion automatica',
    maxLength: MAX_NAME_LENGTH,
  })
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name no puede estar vacio.' })
  @MaxLength(MAX_NAME_LENGTH, {
    message: `name no puede superar ${MAX_NAME_LENGTH} caracteres.`,
  })
  readonly name: string;

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

  @ApiProperty({
    description:
      'Grafo declarativo del pipeline. Se valida con PipelineValidatorService (forma, tipos y topologia)',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject({ message: 'pipelineSchema debe ser un objeto.' })
  @IsNotEmptyObject(
    { nullable: false },
    { message: 'pipelineSchema no puede estar vacio.' },
  )
  readonly pipelineSchema: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Habilitacion frente a los disparadores automaticos. Por defecto FALSE: un flujo recien creado no debe empezar a consumir el buzon sin revision',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser un booleano.' })
  readonly active?: boolean;
}
