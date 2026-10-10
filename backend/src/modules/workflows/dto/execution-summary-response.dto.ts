import { ApiProperty } from '@nestjs/swagger';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

/**
 * Fila de `ejecuciones_flujo` tal como la pinta la tabla de trazabilidad.
 *
 * NO incluye `contexto_acumulado` a proposito: ese `jsonb` acumula lo que
 * publica cada nodo y en un flujo con adjuntos lleva el correo entero en
 * base64. Quien lo necesite pide el detalle, que es una fila y no cincuenta.
 */
export class ExecutionSummaryResponseDto {
  @ApiProperty({ description: 'Fila de `ejecuciones_flujo`' })
  readonly executionId: string;

  @ApiProperty({ description: 'Flujo de `flujos` al que pertenece' })
  readonly flowId: string;

  @ApiProperty({
    enum: ExecutionState,
    description: 'Estado en el que quedo la ejecucion',
  })
  readonly state: ExecutionState;

  @ApiProperty({
    description:
      'Nodo en el que quedo el cursor. Nulo cuando se completo el grafo; con PAUSADO es el nodo que CU-09 reintentaria',
    nullable: true,
  })
  readonly activeCursor: string | null;

  @ApiProperty({
    description:
      'Ruta del ultimo archivo de registro relevante. Apunta al volcado forense (`fsm-*.log`) tras un fallo catastrofico, o a la traza del nodo (`execution-*.log`) cuando la ejecucion quedo PAUSADO',
    nullable: true,
  })
  readonly logFilePath: string | null;

  @ApiProperty({
    description: 'Motivo legible del cierre, cuando no lo explica un volcado',
    nullable: true,
  })
  readonly failureReason: string | null;

  @ApiProperty({
    description: 'Marca de inicio, en ISO 8601',
    format: 'date-time',
  })
  readonly startedAt: string;

  @ApiProperty({
    description: 'Marca de la ultima escritura de checkpoint, en ISO 8601',
    format: 'date-time',
  })
  readonly updatedAt: string;
}

/** Ventana de resultados de `GET /api/executions`. */
export class ExecutionPageResponseDto {
  @ApiProperty({ type: [ExecutionSummaryResponseDto] })
  readonly items: ExecutionSummaryResponseDto[];

  @ApiProperty({
    description:
      'Total de filas que cumplen el filtro, no las de esta pagina: es lo que necesita el paginador para saber cuantas quedan',
  })
  readonly total: number;

  @ApiProperty({ description: 'Tamano de pagina aplicado' })
  readonly limit: number;

  @ApiProperty({ description: 'Filas saltadas desde el inicio' })
  readonly offset: number;
}
