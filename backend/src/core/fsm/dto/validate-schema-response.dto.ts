import { ApiProperty } from '@nestjs/swagger';

import { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';

/**
 * Un campo invalido, en el contrato que consume el editor JSON del frontend.
 *
 * Es una proyeccion de `SchemaIssue` —la forma interna del validador— y no la
 * misma estructura, a proposito:
 *
 * - `path` en vez de `field`: es una RUTA dentro del documento JSON
 *   (`nodes.trigger_imap.params.mailbox`), y el editor la resuelve a una linea y
 *   una columna para dibujar el subrayado. Llamarla `field` sugeriria el nombre
 *   de un control de formulario.
 * - `message` en singular en vez de `constraints[]`: cada regla rota produce su
 *   propio issue. Concatenar los mensajes de un campo en un solo texto daria un
 *   tooltip con dos frases pegadas y ninguna forma de distinguirlas.
 */
export class SchemaIssueDto {
  @ApiProperty({
    description: 'Ruta del campo invalido dentro del pipeline_schema',
    example: 'nodes.trigger_imap.params.mailbox',
  })
  readonly path: string;

  @ApiProperty({
    description: 'Motivo por el que ese campo no supera la validacion',
    example: 'mailbox no puede estar vacio.',
  })
  readonly message: string;
}

/** Respuesta 200 de `POST /api/fsm/validate-schema`. */
export class ValidateSchemaResponseDto {
  @ApiProperty({
    description: 'Siempre `true`; es la contraparte del `false` del 400',
    example: true,
  })
  readonly success: true;

  @ApiProperty({
    type: PipelineSchemaDto,
    description: 'El esquema ya validado, con los tipos aplicados',
  })
  readonly schema: PipelineSchemaDto;
}

/**
 * Respuesta 400 de `POST /api/fsm/validate-schema`.
 *
 * Se declara como clase y no solo como texto en `@ApiBadRequestResponse` para
 * que el contrato viaje al OpenAPI y el cliente pueda generarse contra el.
 */
export class ValidateSchemaErrorDto {
  @ApiProperty({
    description: 'Siempre `false`; el cliente conmuta sobre esta clave',
    example: false,
  })
  readonly success: false;

  @ApiProperty({
    type: [SchemaIssueDto],
    description: 'Un elemento por cada regla incumplida, no por campo',
  })
  readonly issues: SchemaIssueDto[];
}
