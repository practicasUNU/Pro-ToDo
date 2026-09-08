import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';

/**
 * Plantilla de flujo: el blueprint maestro de una topologia (tabla
 * `plantillas_flujo`).
 *
 * FRONTERA CON `Workflow`: esta entidad describe una topologia BASE que no se
 * ejecuta nunca —no tiene autor, ni estado, ni ejecuciones asociadas—, y de la
 * que el asistente parte para instanciar flujos. `Workflow` es la instancia
 * operativa: tiene autor, se habilita frente a los disparadores y acumula
 * ejecuciones. Antes de la migracion 010 ambas cosas eran la misma fila de
 * `flujos`, asi que editar el flujo del que otros partieron cambiaba la
 * plantilla de facto.
 *
 * Propiedades en ingles y columnas en espanol, igual que `Workflow`,
 * `HtmlTemplate` y `User`. Los tipos y longitudes replican `init.sql` a
 * proposito: con `synchronize: false` TypeORM no altera el esquema, asi que una
 * discrepancia aqui no se corregiria sola.
 */
@Entity('plantillas_flujo')
export class WorkflowTemplate {
  @PrimaryGeneratedColumn('uuid', { name: 'id_plantilla_flujo' })
  id: string;

  /**
   * Nombre unico del blueprint.
   *
   * `VARCHAR(100)` y no 120 como `plantillas_html`: se propone como nombre del
   * flujo que lo instancia, y `flujos.nombre` es `VARCHAR(100)`.
   */
  @Column({ name: 'nombre', type: 'varchar', length: 100, unique: true })
  name: string;

  /** `TEXT` y no `VARCHAR(255)`: documenta la topologia entera. */
  @Column({ name: 'descripcion', type: 'text', nullable: true })
  description: string | null;

  /**
   * Disponibilidad de la plantilla en el selector del asistente.
   *
   * Es la marca del borrado LOGICO, igual que en `HtmlTemplate`: una plantilla
   * retirada desaparece del selector pero su fila sigue existiendo, porque los
   * flujos que la instanciaron apuntan a ella y su trazabilidad depende de eso.
   */
  @Column({ name: 'activo', type: 'boolean', default: true })
  active: boolean;

  /**
   * Grafo declarativo base, en el mismo formato que `flujos.configuracion_pipeline`.
   *
   * NO nullable, a diferencia de `Workflow.pipelineSchema`: un flujo sin esquema
   * es un borrador legitimo del asistente, pero una plantilla sin topologia no
   * es una plantilla —no habria nada que clonar.
   */
  @Column({ name: 'configuracion_pipeline', type: 'jsonb' })
  pipelineSchema: PipelineSchema;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  createdAt: Date;
}
