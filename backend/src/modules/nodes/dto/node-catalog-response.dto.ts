import { ApiProperty } from '@nestjs/swagger';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { NodeCategory } from '@modules/nodes/enums/node-category.enum';

/**
 * Entrada del catalogo tal como la ve el frontend (`GET /api/nodos`).
 *
 * Proyeccion y no la entidad cruda: `id` (el UUID) no interesa a ningun
 * consumidor —el `pipeline_schema` referencia tipos por `code`— pero se expone
 * igualmente porque es la clave estable para el `:key` de las listas de Vue.
 */
export class NodeCatalogResponseDto {
  @ApiProperty({
    description: 'Identificador de la fila del catalogo',
    example: '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10',
  })
  readonly id: string;

  @ApiProperty({
    description:
      'Codigo estable del tipo; es lo que viaja en el pipeline_schema',
    example: NodeType.TRIGGER_IMAP,
  })
  readonly code: string;

  @ApiProperty({
    description: 'Nombre legible para el selector',
    example: 'Disparador IMAP',
  })
  readonly name: string;

  @ApiProperty({
    description: 'Familia funcional, para agrupar el selector',
    enum: NodeCategory,
    example: NodeCategory.TRIGGER,
  })
  readonly category: NodeCategory;

  @ApiProperty({
    description: 'Proposito del nodo',
    example: 'Inicia el flujo mediante la lectura de correos entrantes',
    nullable: true,
  })
  readonly description: string | null;

  @ApiProperty({
    description:
      'Descriptor del formulario de `params`. Objeto vacio si el tipo aun no declara uno',
    example: {},
  })
  readonly uiSchema: Record<string, unknown>;

  @ApiProperty({
    description:
      '`false` cuando el tipo esta en el catalogo pero NO tiene estrategia: no es ' +
      'expresable en un pipeline_schema y el selector debe deshabilitarlo',
    example: true,
  })
  readonly implemented: boolean;
}
