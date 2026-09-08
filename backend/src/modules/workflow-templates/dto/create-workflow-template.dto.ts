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

/** Longitud de `plantillas_flujo.nombre`, alineada con `flujos.nombre`. */
const MAX_NAME_LENGTH = 100;

/**
 * Techo de la descripcion.
 *
 * La columna es `TEXT` y no impone limite, pero un campo sin techo en un cuerpo
 * HTTP es una via de saturacion gratuita. 1000 caracteres bastan para documentar
 * una topologia de siete nodos.
 */
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * Alta de una plantilla de flujo (blueprint maestro).
 *
 * `pipelineSchema` se declara como objeto SIN validar aqui su estructura, por el
 * mismo motivo que en `CreateWorkflowDto`: `PipelineValidatorService.validateSchema()`
 * ya hace las dos capas —forma y tipos con `PipelineSchemaDto`, integridad del
 * grafo con `validatePipelineTopology`— y devuelve un `BadRequestException` con
 * la lista exacta de campos invalidos.
 *
 * Anidar aqui un `@ValidateNested()` duplicaria la primera capa y produciria DOS
 * formatos de error distintos para el mismo fallo, segun cual saltara antes: el
 * del `ValidationPipe` global o el del validador.
 *
 * No hay campo de autoria: a diferencia de `plantillas_html`, la tabla no lleva
 * `id_usuario_creador`. Una plantilla es un activo institucional, no de quien la
 * escribio.
 */
export class CreateWorkflowTemplateDto {
  @ApiProperty({
    description:
      'Nombre unico del blueprint, visible en el selector del asistente',
    example: 'Notiweb - correo a CMS',
    maxLength: MAX_NAME_LENGTH,
  })
  @IsString({ message: 'name debe ser una cadena.' })
  @IsNotEmpty({ message: 'name no puede estar vacio.' })
  @MaxLength(MAX_NAME_LENGTH, {
    message: `name no puede superar ${MAX_NAME_LENGTH} caracteres.`,
  })
  readonly name: string;

  @ApiPropertyOptional({
    description: 'Que hace esta topologia y cuando conviene partir de ella',
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
      'Topologia base completa. Se valida con PipelineValidatorService (forma, tipos y grafo)',
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
      'Disponibilidad en el selector. Por defecto TRUE: a diferencia de un flujo, una plantilla no dispara nada, asi que publicarla no tiene riesgo',
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'active debe ser un booleano.' })
  readonly active?: boolean;
}
