import { BadRequestException } from '@nestjs/common';

import type { Workflow } from '@modules/workflows/entities/workflow.entity';

/**
 * Clausula de guarda: un flujo sin esquema no se puede despachar.
 *
 * Es un 400 y no un 404: el flujo existe, lo que falta es terminar de
 * configurarlo en el asistente.
 *
 * Vive como funcion libre —y no como metodo privado de `WorkflowsService`—
 * porque la comparten los TRES caminos que llevan al motor: el despacho de
 * pruebas, el automatico y la reanudacion manual de CU-09, que vive en otro
 * servicio. Replicar las cinco lineas crearia dos fuentes de verdad para el
 * mismo 400, y el dia que el mensaje cambie solo cambiaria en una.
 *
 * Mismo criterio que `assertModelPermissions`, su vecino de directorio.
 *
 * @returns El JSON del pipeline, sin tipar: validarlo es trabajo de
 *          `PipelineValidatorService`, que es quien conoce su forma.
 * @throws BadRequestException Si el flujo no tiene `configuracion_pipeline`.
 */
export const requirePipelineSchema = (workflow: Workflow): unknown => {
  if (workflow.pipelineSchema === null) {
    throw new BadRequestException(
      `El flujo "${workflow.name}" (${workflow.id}) no tiene configuracion_pipeline: complete el asistente antes de despacharlo.`,
    );
  }

  return workflow.pipelineSchema;
};
