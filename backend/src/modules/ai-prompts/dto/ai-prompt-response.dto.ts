import { ApiProperty } from '@nestjs/swagger';

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
export class AiPromptResponseDto {
  @ApiProperty({ description: 'Identificador del prompt' })
  readonly id: string;

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

  @ApiProperty({ description: 'Alta del prompt' })
  readonly createdAt: Date;

  @ApiProperty({ description: 'Ultima edicion del prompt' })
  readonly updatedAt: Date;
}

/** Detalle de un prompt: el resumen mas la instruccion completa. */
export class AiPromptDetailResponseDto extends AiPromptResponseDto {
  @ApiProperty({
    description:
      'Instruccion completa, con sus marcadores {{nodo.campo}} sin resolver',
  })
  readonly promptText: string;
}
