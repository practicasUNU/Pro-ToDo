import { Injectable, Logger } from '@nestjs/common';

import type { CrudMutationPayload } from '@common/types/crud-events.types';

/**
 * Lo que un servicio de dominio necesita contar, sin conocer por donde sale.
 *
 * Mismo patron y mismo motivo que `ExecutionEventPort`, pero aqui el ciclo que
 * evita es mas concreto: `NotificationsModule` importa `AuthModule`, que a su
 * vez importa `UsersModule`, de modo que inyectar el gateway en
 * `UsersService` cerraria una dependencia circular. Con este puerto la flecha
 * va en un solo sentido y los servicios no importan ningun modulo nuevo,
 * porque `CommonModule` es global.
 *
 * SINCRONO y `void` por la misma razon que el puerto de ejecuciones: `emit` de
 * Socket.io no espera acuse, asi que prometer una entrega que el transporte no
 * garantiza solo serviria para mentir, e invitaria a esperar la red dentro de
 * una transaccion de base de datos.
 */
export interface CrudEventPort {
  emitCrudMutation(payload: CrudMutationPayload): void;
}

/**
 * Punto de encuentro entre los servicios CRUD y los canales de notificacion.
 *
 * Mantiene un CONJUNTO de puertos y no un puntero unico, por el mismo criterio
 * que `ExecutionEventsCoordinator`: "el ultimo registro gana" dejaria al
 * anterior dado de baja en silencio el dia que aparezca un segundo canal.
 *
 * Sin implementadores registrados todo es un no-op silencioso, lo que permite
 * inyectar la clase real en las pruebas de los servicios en vez de un doble.
 */
@Injectable()
export class CrudEventsCoordinator {
  private readonly logger = new Logger(CrudEventsCoordinator.name);

  private readonly ports = new Set<CrudEventPort>();

  /** Inscribe un canal. Lo llama `NotificationGateway.onModuleInit`. */
  public registerPort(port: CrudEventPort): void {
    this.ports.add(port);
  }

  /**
   * Da de baja un canal.
   *
   * Cada implementador se registra a si mismo (`this`) para poder retirarse con
   * la misma referencia cuando Nest recarga en modo `--watch`.
   */
  public unregisterPort(port: CrudEventPort): void {
    this.ports.delete(port);
  }

  /**
   * Reparte la mutacion entre los canales inscritos.
   *
   * Itera sobre una COPIA porque un puerto puede darse de baja durante su
   * propio despacho, y el `try/catch` es POR PUERTO para que un canal roto no
   * impida al resto recibir. Los errores se registran y se tragan: una
   * notificacion fallida jamas debe deshacer una escritura ya confirmada en
   * PostgreSQL.
   */
  public dispatch(payload: CrudMutationPayload): void {
    for (const port of [...this.ports]) {
      try {
        port.emitCrudMutation(payload);
      } catch (error) {
        this.logger.error(
          `Un canal fallo al difundir ${payload.entity}/${payload.action} (${payload.id}).`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
