import { ApiProperty } from '@nestjs/swagger';

import { ExecutionSummaryResponseDto } from './execution-summary-response.dto';
import { PipelineSummaryResponseDto } from './pipeline-summary-response.dto';

/**
 * Resultado del descarte manual de una ejecucion detenida (CU-09).
 *
 * Devuelve las DOS filas que el descarte toca, y no solo la ejecucion: cerrar
 * una pausada retira ademas su flujo de los disparadores automaticos, de modo
 * que un cliente que recibiese unicamente la ejecucion pintaria el flujo como
 * activo hasta la siguiente recarga.
 *
 * Por eso el endpoint responde `200` y no `204`: hay cuerpo que entregar.
 */
export class DiscardExecutionResponseDto {
  @ApiProperty({
    type: ExecutionSummaryResponseDto,
    description: 'La ejecucion ya cerrada, en DESCARTADO y sin cursor',
  })
  readonly execution: ExecutionSummaryResponseDto;

  @ApiProperty({
    type: PipelineSummaryResponseDto,
    description: 'El flujo padre, ya desactivado',
  })
  readonly workflow: PipelineSummaryResponseDto;
}
