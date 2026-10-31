import { ApiProperty } from '@nestjs/swagger';

import type {
  DrupalPresetKey,
  DrupalPresetTarget,
} from '@core/config/drupal-api.config';

/** Pagina de un destino rapido en un entorno. Todo `null` si no esta declarada. */
export class DrupalPresetTargetDto implements DrupalPresetTarget {
  @ApiProperty({
    description: 'UUID v4 de la pagina sobre la que actua el destino',
    nullable: true,
    type: String,
  })
  targetNodeUuid: string | null;

  @ApiProperty({
    description: 'UUID v4 de la pagina receptora; solo en Cerrar licitacion',
    nullable: true,
    type: String,
  })
  destinationNodeUuid: string | null;

  @ApiProperty({
    description: 'NID interno de la pagina, informativo',
    nullable: true,
    type: Number,
  })
  nid: number | null;
}

/**
 * Paginas de los destinos rapidos del nodo Drupal, por entorno y preset.
 *
 * Mapa y no lista: el cliente las busca por clave de preset (`INNOBAR`), que es
 * la misma en los dos lados de la red.
 */
export class DrupalPresetTargetsResponseDto {
  @ApiProperty({
    description: 'Paginas de pruebas, por preset',
    type: 'object',
    additionalProperties: {
      $ref: '#/components/schemas/DrupalPresetTargetDto',
    },
  })
  SANDBOX: Readonly<Record<DrupalPresetKey, DrupalPresetTargetDto>>;

  @ApiProperty({
    description: 'Paginas del portal, por preset',
    type: 'object',
    additionalProperties: {
      $ref: '#/components/schemas/DrupalPresetTargetDto',
    },
  })
  PRODUCTION: Readonly<Record<DrupalPresetKey, DrupalPresetTargetDto>>;
}
