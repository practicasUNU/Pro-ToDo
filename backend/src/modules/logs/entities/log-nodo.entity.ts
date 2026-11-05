import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/**
 * Desenlace de un nodo, en la escala del tipo `enum_estado_nodo`.
 *
 * Son los valores que `init.sql` declaro para esta tabla, y NO los del motor
 * (`EXITOSO`/`FALLIDO`): cambiar los valores de un enum en PostgreSQL obliga a
 * recrear el tipo y reescribir la columna, y estos tres ya cubren el dominio.
 *
 * `ADVERTENCIA` no es un adorno: es el desenlace de un fallo LEVE, que cierra la
 * ejecucion sin pausarla porque se reintenta solo en el siguiente sondeo. Quien
 * lea la traza tiene que poder distinguirlo de un `ERROR` que espera a alguien.
 */
export enum NodeLogStatus {
  OK = 'OK',
  ERROR = 'ERROR',
  ADVERTENCIA = 'ADVERTENCIA',
}

/**
 * Traza relacional de la ejecucion de un nodo (`logs_nodo`).
 *
 * Es la mitad en base de datos del registro hibrido: la otra es el volcado que
 * `HybridLoggerService` escribe en disco, y `ruta_archivo_log` es lo que une las
 * dos. Existe por separado del fichero porque una traza consultable con SQL es
 * lo que permite responder "cuanto tarda este nodo" o "cuantas veces fallo hoy"
 * sin abrir un `.log` del servidor.
 *
 * Los tipos y longitudes replican `init.sql` a proposito: con
 * `synchronize: false` TypeORM no altera el esquema, asi que una discrepancia
 * aqui no se corregiria sola — se convertiria en una mentira en el codigo.
 *
 * La fila se borra en cascada con su ejecucion (`ON DELETE CASCADE` en la clave
 * ajena), de modo que purgar `ejecuciones_flujo` arrastra su traza y no deja
 * huerfanas.
 */
@Entity('logs_nodo')
export class LogNodo {
  @PrimaryGeneratedColumn('uuid', { name: 'id_log_nodo' })
  id: string;

  @Column({ name: 'id_ejecucion', type: 'uuid' })
  executionId: string;

  /**
   * `nodeId` del `pipeline_schema`, NO una clave ajena.
   *
   * El nodo es un objeto del JSONB, y `nodos` es el catalogo de TIPOS, no una
   * tabla de instancias donde buscar esta fila. Nullable porque un fallo puede
   * ocurrir antes de que el motor resuelva en que nodo estaba.
   */
  @Column({ name: 'id_nodo', type: 'varchar', length: 50, nullable: true })
  nodeId: string | null;

  @Column({ name: 'tipo_nodo', type: 'varchar', length: 50, nullable: true })
  nodeType: string | null;

  @Column({
    name: 'estado_nodo',
    type: 'enum',
    enum: NodeLogStatus,
    enumName: 'enum_estado_nodo',
  })
  status: NodeLogStatus;

  /** Nula cuando el nodo termino con exito: un exito no tiene severidad. */
  @Column({
    name: 'nivel_severidad',
    type: 'enum',
    enum: ['URGENTE', 'GRAVE', 'LEVE'],
    enumName: 'enum_nivel_error',
    nullable: true,
  })
  severity: NodeErrorSeverity | null;

  /**
   * Codigo estable del fallo. Se guarda aparte del mensaje porque es lo que
   * compara el `catchErrors` de `onErrorStep`: el mensaje se puede reescribir,
   * el codigo es contrato.
   */
  @Column({
    name: 'codigo_error',
    type: 'varchar',
    length: 100,
    nullable: true,
  })
  errorCode: string | null;

  @Column({ name: 'mensaje', type: 'text', nullable: true })
  message: string | null;

  /** Duracion de la invocacion de la estrategia, medida por el motor. */
  @Column({ name: 'tiempo_ejecucion_ms', type: 'int', nullable: true })
  durationMs: number | null;

  /**
   * Codigo HTTP de la respuesta, para los nodos que hablan por red.
   *
   * Sin poblar todavia: lo estrenara `DESTINO_DRUPAL`, que aun no tiene
   * estrategia. La columna ya existia en `init.sql` y se mapea para que la
   * entidad describa la tabla entera y no una parte.
   */
  @Column({ name: 'codigo_respuesta_http', type: 'smallint', nullable: true })
  httpStatusCode: number | null;

  /** Fichero de Winston donde quedo la traza completa de esta misma ejecucion. */
  @Column({
    name: 'ruta_archivo_log',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  logFilePath: string | null;

  @CreateDateColumn({ name: 'fecha_creacion', type: 'timestamp' })
  createdAt: Date;
}
