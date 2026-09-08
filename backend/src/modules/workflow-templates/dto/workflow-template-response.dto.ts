import { ApiProperty } from '@nestjs/swagger';

import { PipelineStepDto } from '@modules/workflows/dto/pipeline-summary-response.dto';

/**
 * Plantilla de flujo tal como la consume el LISTADO: el selector del asistente y
 * la tabla administrativa.
 *
 * Reutiliza `PipelineStepDto` en lugar de declarar su propio paso: es la misma
 * proyeccion parcial del nodo, y con ella el frontend usa un unico tipo para
 * pintar el stepper venga de una plantilla o de un flujo.
 *
 * El listado NO expone `pipelineSchema`, por el mismo criterio de
 * `PipelineSummaryResponseDto`: los `params` de un TRIGGER_IMAP llevan `host`,
 * `user` y `passwordEnvKey`, y el selector no necesita nada de eso para dibujar
 * la secuencia de pasos. Quien si lo necesita es el editor administrativo, y
 * para eso esta `WorkflowTemplateDetailResponseDto`.
 */
export class WorkflowTemplateResponseDto {
  @ApiProperty({
    description:
      'Identificador de la plantilla (`plantillas_flujo.id_plantilla_flujo`)',
  })
  readonly id: string;

  @ApiProperty({
    description: 'Nombre unico del blueprint',
    example: 'Notiweb - correo a CMS',
  })
  readonly name: string;

  @ApiProperty({ description: 'Proposito de la topologia', nullable: true })
  readonly description: string | null;

  @ApiProperty({
    description: 'Disponibilidad en el selector del asistente (borrado logico)',
  })
  readonly active: boolean;

  @ApiProperty({
    type: [PipelineStepDto],
    description:
      'Pasos EN ORDEN DE EJECUCION, recorridos desde `entrypoint` por `nextStep`',
  })
  readonly topology: PipelineStepDto[];
}

/**
 * Plantilla con su grafo completo, para el editor administrativo.
 *
 * Separado del listado a proposito: `pipelineSchema` es el objeto que el CRUD
 * edita, asi que ahi si tiene que viajar, pero devolverlo en el listado
 * expondria la configuracion de cada nodo de cada plantilla en una sola
 * peticion que el asistente hace en cada arranque.
 */
export class WorkflowTemplateDetailResponseDto extends WorkflowTemplateResponseDto {
  @ApiProperty({
    description:
      'Grafo declarativo base, tal como se persiste en la columna jsonb',
    type: 'object',
    additionalProperties: true,
  })
  readonly pipelineSchema: Record<string, unknown>;
}
