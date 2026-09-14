import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { LogNodo } from '@modules/logs/entities/log-nodo.entity';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/**
 * Severidades que generan alerta operativa.
 *
 * Se DERIVA de `NodeErrorSeverity` en vez de reescribir la lista: si algun dia
 * cambian las severidades del motor, esto deja de compilar en lugar de divergir
 * en silencio de la escala que si usa el resto del sistema.
 *
 * `LEVE` queda fuera a proposito: es el fallo que cierra sin pausar porque se
 * reintenta solo en el siguiente sondeo —el timeout IMAP es el caso tipico—, y
 * una alerta por cada uno llenaria la bandeja de avisos que nadie tiene que
 * atender. Ese caso ya queda registrado en `logs_nodo` como `ADVERTENCIA`.
 *
 * El estrechamiento es del DOMINIO, no de la tabla: la columna sigue siendo
 * `enum_nivel_error` y admite los tres valores a nivel SQL.
 */
export type AlertLevel = Exclude<NodeErrorSeverity, 'LEVE'>;

/**
 * Incidencia que alguien debe atender (`alertas_error`).
 *
 * Es la senal, no el caudal. `LogNodo` registra CADA nodo ejecutado —incluidos
 * los cientos que terminan bien—, de modo que un fallo grave enterrado ahi no
 * es accionable: nadie revisa un caudal continuo buscando la aguja. Esta tabla
 * recoge solo lo que exige intervencion humana y anade lo unico que el caudal no
 * puede tener: una marca de atendida (`resuelto`).
 *
 * `HybridLoggerService` es su unico escritor, y la crea en la misma llamada que
 * persiste la traza.
 *
 * Los tipos y longitudes replican `init.sql` a proposito: con
 * `synchronize: false` TypeORM no altera el esquema, asi que una discrepancia
 * aqui no se corregiria sola — se convertiria en una mentira en el codigo.
 */
@Entity('alertas_error')
export class AlertaError {
  @PrimaryGeneratedColumn('uuid', { name: 'id_alerta_error' })
  id: string;

  /**
   * Ejecucion en la que se produjo el fallo.
   *
   * `ON DELETE CASCADE` en la clave ajena: purgar `ejecuciones_flujo` arrastra
   * sus alertas y no deja huerfanas.
   */
  @Column({ name: 'id_ejecucion', type: 'uuid' })
  executionId: string;

  /**
   * Traza de `logs_nodo` que origino esta alerta.
   *
   * NULLABLE a proposito, y no por comodidad: si la escritura de la traza falla,
   * la alerta se registra igual y sin vinculo. Perder el aviso de un fallo
   * URGENTE porque no se pudo anotar el log seria el peor canje posible, y es
   * justo cuando algo va mal cuando la alerta mas importa.
   *
   * Se declara como columna plana ADEMAS de la relacion de abajo para poder
   * escribirla sin cargar antes el `LogNodo` entero.
   */
  @Column({ name: 'id_log_nodo', type: 'uuid', nullable: true })
  logNodeId: string | null;

  /**
   * La misma traza, navegable.
   *
   * `SET NULL` y no `CASCADE`: borrar la ejecucion ya se lleva esta fila por
   * `executionId`. La diferencia aparece el dia que se pode `logs_nodo` por
   * retencion; con `CASCADE` desapareceria de paso una alerta sin resolver.
   */
  @ManyToOne(() => LogNodo, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'id_log_nodo' })
  logNode?: LogNodo;

  /**
   * Severidad del fallo.
   *
   * El decorador declara los TRES valores del tipo de PostgreSQL porque eso es
   * lo que la columna acepta; la propiedad se estrecha a `AlertLevel` porque eso
   * es lo que el dominio escribe.
   */
  @Column({
    name: 'nivel',
    type: 'enum',
    enum: ['URGENTE', 'GRAVE', 'LEVE'],
    enumName: 'enum_nivel_error',
  })
  level: AlertLevel;

  /**
   * Descripcion legible del fallo.
   *
   * Recoge el `customMessage` de la ruta de error cuando el nodo lo declara para
   * ese codigo: el motor ya lo resuelve antes de registrar la traza, asi que
   * aqui llega el texto que el operador debe leer.
   */
  @Column({ name: 'mensaje_error', type: 'text', nullable: true })
  errorMessage: string | null;

  /** Marca de atendida. Es el filtro de la bandeja de alertas. */
  @Column({ name: 'resuelto', type: 'boolean', default: false })
  resolved: boolean;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  createdAt: Date;
}
