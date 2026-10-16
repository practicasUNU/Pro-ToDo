import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { WorkflowStatus } from '@modules/workflows/enums/workflow-status.enum';
import { WorkflowTemplate } from '@modules/workflow-templates/entities/workflow-template.entity';

import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';

/**
 * Flujo declarado en el panel de control (tabla `flujos`).
 *
 * Mapea la tabla que ya define `init.sql`, con propiedades en ingles y columnas
 * en espanol, igual que `User`, `RefreshToken` y `FsmExecution`.
 *
 * FRONTERA CON `ejecuciones_flujo`: esta entidad describe la PLANTILLA del
 * trabajo —su topologia y si esta habilitado—, nunca su ciclo de vida. El
 * `currentState` (EN_PROCESO, EXITOSO, DESCARTADO...) vive exclusivamente en
 * `FsmExecution`, porque un mismo flujo acumula muchas ejecuciones historicas y
 * una columna de estado aqui solo podria reflejar una de ellas.
 *
 * `status` NO rompe esa frontera pese a compartir la palabra PAUSADO: sigue
 * respondiendo a "este flujo se puede disparar", solo que con tres respuestas
 * en vez de dos. La tercera -"no, porque hay una ejecucion detenida esperando
 * un reintento"- es una propiedad de la PLANTILLA en este instante, y es lo que
 * decide si el sondeo lo inscribe; cual sea esa ejecucion y como acabe sigue
 * siendo asunto exclusivo de `FsmExecution`.
 *
 * Los tipos y longitudes replican `init.sql` a proposito: con
 * `synchronize: false` TypeORM no altera el esquema, asi que una discrepancia
 * aqui no se corregiria sola — se convertiria en una mentira en el codigo.
 */
@Entity('flujos')
export class Workflow {
  @PrimaryGeneratedColumn('uuid', { name: 'id_flujo' })
  id: string;

  @Column({ name: 'nombre', type: 'varchar', length: 100 })
  name: string;

  @Column({ name: 'descripcion', type: 'varchar', length: 255, nullable: true })
  description: string | null;

  /**
   * Habilitacion del flujo frente a los disparadores AUTOMATICOS (Cron, IMAP).
   *
   * El despacho manual de `execute-test` la ignora a proposito: probar un flujo
   * antes de habilitarlo es justo el caso de uso del Camino B.
   *
   * Nace INACTIVO (migracion 040), al reves que el `DEFAULT TRUE` del booleano
   * al que sustituye: un flujo que se armase solo empezaria a consumir el buzon
   * corporativo sin que nadie hubiera revisado su configuracion. El codigo ya
   * desmentia aquel defecto, porque `createWorkflow` forzaba `false`.
   */
  @Column({
    name: 'status',
    type: 'enum',
    enum: WorkflowStatus,
    default: WorkflowStatus.INACTIVO,
  })
  status: WorkflowStatus;

  /**
   * Grafo declarativo que recorre el `FsmEngineService`.
   *
   * Nullable porque el asistente de creacion guarda el flujo antes de terminar
   * de configurar sus nodos: un flujo sin esquema existe, pero no se puede
   * disparar. `WorkflowsService` lo comprueba antes de crear la ejecucion.
   */
  @Column({ name: 'configuracion_pipeline', type: 'jsonb', nullable: true })
  pipelineSchema: PipelineSchema | null;

  /**
   * Plantilla (`plantillas_flujo`) de la que se instancio este flujo.
   *
   * NULLABLE por dos motivos distintos: los flujos anteriores a la migracion 010
   * no nacieron de ningun maestro, y el asistente debe seguir pudiendo crear uno
   * desde cero. Un `NOT NULL` habria obligado a inventar una plantilla para las
   * filas historicas.
   *
   * Es trazabilidad, no dependencia: el flujo lleva su propia copia del grafo en
   * `pipelineSchema`, asi que editar la plantilla despues NO altera los flujos
   * que ya salieron de ella. Esa independencia es justo el sentido de separar
   * blueprint e instancia.
   */
  @Column({ name: 'id_plantilla_origen', type: 'uuid', nullable: true })
  templateId: string | null;

  /**
   * Relacion hacia el maestro, para poder mostrar su nombre en el catalogo.
   *
   * SIN lado inverso (`@OneToMany` en `WorkflowTemplate`) a proposito: nadie
   * necesita navegar plantilla -> flujos, y declararlo cerraria un ciclo de
   * imports entre las dos entidades.
   */
  @ManyToOne(() => WorkflowTemplate, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'id_plantilla_origen' })
  template: WorkflowTemplate | null;

  @Column({ name: 'id_usuario_creador', type: 'uuid' })
  createdById: string;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  createdAt: Date;
}
