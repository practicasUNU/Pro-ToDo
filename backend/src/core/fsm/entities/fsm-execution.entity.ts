import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

/**
 * Checkpoint persistente de una ejecucion del motor FSM.
 *
 * Mapea la tabla `ejecuciones_flujo` que ya define `init.sql` en lugar de crear
 * una tabla paralela: `logs_nodo` y `alertas_error` tienen claves foraneas
 * apuntandole, y duplicarla habria dejado dos fuentes de verdad para el mismo
 * concepto. De ahi que las propiedades esten en ingles y las columnas en
 * espanol, igual que en `User` y `RefreshToken`.
 *
 * MUTEX DE EJECUCION: `idx_flujo_activo` es un indice unico PARCIAL — solo
 * aplica mientras `estado = 'EN_PROCESO'`. Con el, la propia base de datos
 * garantiza que un flujo no tenga dos ejecuciones vivas a la vez, sin depender
 * de un bloqueo en memoria que se perderia al escalar a varios procesos. Los
 * estados terminales quedan fuera del indice, asi que un flujo puede acumular
 * todas las ejecuciones historicas que haga falta.
 *
 * OJO: con `synchronize: false`, TypeORM NO crea este indice. El decorador es
 * declarativo; el indice real lo crea `db/migrations/006-fsm-execution-mutex.sql`.
 */
@Entity('ejecuciones_flujo')
@Index('idx_flujo_activo', ['flowId'], {
  unique: true,
  where: "estado = 'EN_PROCESO'",
})
export class FsmExecution {
  @PrimaryGeneratedColumn('uuid', { name: 'id_ejecucion' })
  executionId: string;

  @Column({ name: 'id_flujo', type: 'uuid' })
  flowId: string;

  @Column({
    name: 'estado',
    type: 'enum',
    enum: ExecutionState,
    enumName: 'enum_estado',
    default: ExecutionState.INACTIVO,
  })
  currentState: ExecutionState;

  /** `nodeId` del paso en curso. Nulo mientras la ejecucion esta INACTIVO. */
  @Column({ name: 'paso_actual', type: 'varchar', length: 50, nullable: true })
  activeCursor: string | null;

  /**
   * Volcado de `StatePayloadContext.getAllContext()`: los namespaces acumulados
   * por los nodos ya ejecutados. Es lo que permite reanudar desde el cursor sin
   * repetir el trabajo previo.
   */
  @Column({ name: 'contexto_acumulado', type: 'jsonb', default: {} })
  contextPayload: Record<string, Record<string, unknown>>;

  /** Intentos consumidos por nodo, para contrastarlos con su `RetryPolicy`. */
  @Column({ name: 'retry_state', type: 'jsonb', default: {} })
  retryState: Record<string, unknown>;

  /**
   * Ruta del volcado forense asociado a un fallo catastrofico.
   *
   * Es el eslabon entre los dos destinos de la persistencia hibrida
   * (`architecture-patterns.md` §4): el stack trace y el payload viven en disco
   * —demasiado voluminosos para una columna— y aqui queda la referencia que
   * permite encontrarlos. `null` mientras no haya habido un fallo URGENTE, y
   * tambien cuando lo hubo pero el volcado a disco no pudo escribirse.
   */
  @Column({
    name: 'ruta_archivo_log',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  logFilePath: string | null;

  /**
   * Motivo legible del fallo cuando NO lo explica un volcado forense.
   *
   * Complementa a `logFilePath`, no lo sustituye: aquel apunta al stack trace de
   * un fallo tecnico, y este describe un fallo que ningun nodo provoco. El caso
   * que lo motiva es la desactivacion del flujo padre —una decision del
   * operador, sin excepcion que volcar—, tras la cual las ejecuciones vivas se
   * cierran como FALLIDO y sin esta columna serian indistinguibles de una averia
   * cuyo log se hubiera perdido.
   *
   * `null` en toda ejecucion que no ha fallado y en la que si lo hizo por la via
   * tecnica, donde el detalle vive en el fichero.
   */
  @Column({
    name: 'motivo_fallo',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  failureReason: string | null;

  @CreateDateColumn({ name: 'fecha_inicio', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'fecha_actualizacion', type: 'timestamp' })
  updatedAt: Date;
}
