import { ApiProperty } from '@nestjs/swagger';

import { PipelineSummaryResponseDto } from './pipeline-summary-response.dto';

/**
 * Un flujo con su `configuracion_pipeline` COMPLETA, `params` incluidos.
 *
 * Es la contrapartida deliberada de `PipelineSummaryResponseDto`, que los
 * elimina. La diferencia no es de detalle sino de PROPOSITO, y por eso son dos
 * DTO y no un parametro opcional del listado:
 *
 * - El listado alimenta un SELECTOR. Enumera flujos para elegir uno, y para eso
 *   no necesita el host del buzon ni la clave de entorno de nadie; devolverlos
 *   convertiria una pantalla de consulta en una fuga de configuracion.
 * - Este detalle alimenta el FORMULARIO QUE LOS EDITA. Sin `params` no hay nada
 *   que hidratar: el asistente no podria mostrar el filtro de asunto que el
 *   operador quiere cambiar, y guardar reescribiria el grafo con los valores en
 *   blanco del formulario.
 *
 * Sigue sin viajar ningun secreto: `passwordEnvKey` es el NOMBRE de la variable
 * de entorno, nunca la contrasena, que solo el backend resuelve en ejecucion
 * (`security-and-scope.md` §0.1). Es el mismo trato que ya recibe
 * `WorkflowTemplateDetailResponseDto`.
 */
export class WorkflowDetailResponseDto extends PipelineSummaryResponseDto {
  @ApiProperty({
    description:
      'Grafo completo del pipeline con los `params` de cada nodo. Nulo en un flujo a medio crear',
    nullable: true,
  })
  readonly pipelineSchema: Record<string, unknown> | null;
}
