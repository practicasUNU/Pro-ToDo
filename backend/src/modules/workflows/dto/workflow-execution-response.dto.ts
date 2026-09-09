import { ApiProperty } from '@nestjs/swagger';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

/**
 * Resultado de un despacho manual.
 *
 * Se devuelve el `executionId` incluso cuando el estado final no es EXITOSO: es
 * la clave con la que el operador localiza el checkpoint en `ejecuciones_flujo`
 * y sus alertas asociadas para el reintento de CU-09.
 */
export class WorkflowExecutionResponseDto {
  @ApiProperty({ description: 'Fila de `ejecuciones_flujo` que se creo' })
  readonly executionId: string;

  @ApiProperty({
    description:
      'Flujo de `flujos` que se despacho. Se devuelve para que el cliente no dependa del id que envio en la ruta',
  })
  readonly workflowId: string;

  @ApiProperty({
    enum: ExecutionState,
    description: 'Estado en el que el motor dejo la ejecucion',
  })
  readonly status: ExecutionState;

  @ApiProperty({
    description:
      'Nodo en el que quedo el cursor. Nulo cuando la ejecucion completo el grafo; con PAUSADO o FALLIDO es el nodo culpable',
    nullable: true,
  })
  readonly activeCursor: string | null;

  @ApiProperty({
    description:
      'Volcado de `contexto_acumulado`: los namespaces que dejaron los nodos ejecutados, incluido `rendered_html.compiled_markup`',
  })
  readonly context: Record<string, Record<string, unknown>>;
}
