import { ApiProperty } from '@nestjs/swagger';

import { AuditFieldsResponseDto } from '@common/dto/audit-response.dto';

/**
 * Prompt tal como lo ve el listado administrativo.
 *
 * Deja fuera `promptText` a proposito: la tabla muestra decenas de filas y el
 * cuerpo de una instruccion puede ocupar kilobytes. Quien lo necesita es el
 * detalle, que lo pide por id.
 *
 * Se serializa en camelCase aunque las columnas sean `texto_prompt` o
 * `fecha_creacion`: la frontera del JSON es contrato con la UI, no reflejo del
 * esquema.
 */
export class AiPromptTemplateResponseDto extends AuditFieldsResponseDto {
  @ApiProperty({ description: 'Identificador del prompt' })
  readonly id: string;

  @ApiProperty({
    description:
      'Clave de maquina, inmutable. Es la que citan los params del nodo IA',
    example: 'LICITACION_APERTURA_DEFAULT',
  })
  readonly code: string;

  @ApiProperty({
    description: 'Nombre unico, visible en el selector del nodo IA',
  })
  readonly name: string;

  @ApiProperty({
    description: 'Proposito del prompt',
    nullable: true,
    type: String,
  })
  readonly description: string | null;

  @ApiProperty({
    description: 'Falso si el prompt esta retirado (borrado logico)',
  })
  readonly active: boolean;

  @ApiProperty({ description: 'Autor, tomado del JWT en el alta' })
  readonly createdById: string;

  // `createdAt`, `updatedAt`, `createdBy` y `updatedBy` llegan heredados de
  // `AuditFieldsResponseDto` (migracion 045).
}

/** Detalle de un prompt: el resumen mas la instruccion completa. */
export class AiPromptTemplateDetailResponseDto extends AiPromptTemplateResponseDto {
  @ApiProperty({
    description:
      'Instruccion completa, con sus marcadores {{nodo.campo}} sin resolver',
  })
  readonly promptText: string;

  /**
   * Namespaces que el prompt necesita encontrar en el contexto al ejecutarse.
   *
   * Se DERIVA del texto, no se almacena: una copia en columna se
   * desincronizaria en cuanto alguien editase un marcador. El consumidor es el
   * asistente, que con esto puede avisar de que un prompt pide
   * `scraped_web.*` en un flujo que no tiene nodo EXTRACTOR_WEB, antes de
   * gastar una inferencia en descubrirlo.
   */
  @ApiProperty({
    description:
      'Raices de namespace que aparecen en los marcadores {{nodo.campo}} del prompt',
    example: ['parsed_email', 'scraped_web'],
    type: [String],
  })
  readonly requiredNamespaces: readonly string[];
}
