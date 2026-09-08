import { ApiProperty } from '@nestjs/swagger';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

/**
 * Un paso del pipeline, tal como lo consume el asistente de creacion de flujos.
 *
 * Proyeccion DELIBERADAMENTE PARCIAL de `PipelineNodeConfig`: se omiten
 * `params`, `nextStep`, `onErrorStep` y `retryPolicy`.
 *
 * `params` no es una omision por brevedad, es de seguridad: en un nodo
 * TRIGGER_IMAP contiene `host`, `user` y `passwordEnvKey`, y en un DESTINO_HTTP
 * la URL interna del CMS. Son datos de infraestructura que el selector del
 * asistente no necesita para nada, y devolverlos convertiria un endpoint de
 * listado en una fuga de configuracion hacia el navegador.
 *
 * Los punteros del grafo (`nextStep` / `onErrorStep`) tampoco viajan porque el
 * orden ya esta resuelto: la topologia llega como un arreglo SECUENCIAL y el
 * cliente no tiene que recorrer ningun grafo para pintar un stepper.
 */
export class PipelineStepDto {
  @ApiProperty({
    description: 'Identificador del nodo dentro del pipeline_schema',
    example: 'trigger_imap',
  })
  readonly nodeId: string;

  @ApiProperty({
    enum: NodeType,
    description: 'Tipo de nodo; el frontend resuelve con el su configurador',
    example: NodeType.TRIGGER_IMAP,
  })
  readonly nodeType: NodeType;

  @ApiProperty({
    description: 'Namespace en el que este nodo escribe su resultado',
    example: 'raw_email',
  })
  readonly outputNamespace: string;
}

/**
 * Flujo seleccionable como plantilla en el asistente, con su topologia ordenada.
 *
 * Solo se listan los flujos que YA tienen `configuracion_pipeline`: uno sin
 * esquema esta a medio crear y no sirve como plantilla de la que partir.
 */
export class PipelineSummaryResponseDto {
  @ApiProperty({ description: 'Identificador del flujo (`flujos.id_flujo`)' })
  readonly id: string;

  @ApiProperty({
    description: 'Nombre institucional del flujo',
    example: 'Notiweb - publicacion automatica',
  })
  readonly name: string;

  @ApiProperty({
    description: 'Descripcion legible del proposito del flujo',
    nullable: true,
  })
  readonly description: string | null;

  @ApiProperty({
    description:
      'Habilitacion frente a los disparadores automaticos (Cron, IMAP)',
  })
  readonly active: boolean;

  @ApiProperty({
    type: [PipelineStepDto],
    description:
      'Pasos EN ORDEN DE EJECUCION, recorridos desde `entrypoint` por `nextStep`',
  })
  readonly topology: PipelineStepDto[];
}
