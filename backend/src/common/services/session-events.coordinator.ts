import { Injectable, Logger } from '@nestjs/common';

import type { UserModifiedPayload } from '@common/types/session-events.types';

/**
 * Lo que un servicio de dominio necesita contarle a UNA persona, sin conocer
 * por donde sale.
 *
 * Mismo patron y mismo motivo que `CrudEventPort`: `NotificationsModule`
 * importa `AuthModule`, que a su vez importa `UsersModule`, de modo que
 * inyectar el gateway en `UsersService` cerraria una dependencia circular. Con
 * este puerto la flecha va en un solo sentido y `UsersService` no importa
 * ningun modulo nuevo, porque `CommonModule` es global.
 *
 * SINCRONO y `void` por la misma razon que los otros dos puertos: `emit` de
 * Socket.io no espera acuse, asi que prometer una entrega que el transporte no
 * garantiza solo serviria para mentir, e invitaria a esperar la red dentro de
 * una transaccion de base de datos.
 */
export interface SessionEventPort {
  emitUserModified(payload: UserModifiedPayload): void;
}

/**
 * Punto de encuentro entre los servicios de dominio y los canales de aviso
 * personal.
 *
 * Mantiene un CONJUNTO de puertos y no un puntero unico, por el mismo criterio
 * que los otros dos coordinadores: "el ultimo registro gana" dejaria al
 * anterior dado de baja en silencio el dia que aparezca un segundo canal.
 *
 * Sin implementadores registrados todo es un no-op silencioso, lo que permite
 * inyectar la clase real en las pruebas de los servicios en vez de un doble.
 */
@Injectable()
export class SessionEventsCoordinator {
  private readonly logger = new Logger(SessionEventsCoordinator.name);

  private readonly ports = new Set<SessionEventPort>();

  /** Inscribe un canal. Lo llama `NotificationGateway.onModuleInit`. */
  public registerPort(port: SessionEventPort): void {
    this.ports.add(port);
  }

  /**
   * Da de baja un canal.
   *
   * Cada implementador se registra a si mismo (`this`) para poder retirarse con
   * la misma referencia cuando Nest recarga en modo `--watch`.
   */
  public unregisterPort(port: SessionEventPort): void {
    this.ports.delete(port);
  }

  /**
   * Reparte el aviso entre los canales inscritos.
   *
   * Itera sobre una COPIA porque un puerto puede darse de baja durante su
   * propio despacho, y el `try/catch` es POR PUERTO para que un canal roto no
   * impida al resto recibir. Los errores se registran y se tragan: el aviso es
   * la cortesia, no la medida de seguridad —esa es `token_version`, que ya
   * esta escrita en PostgreSQL cuando esto corre—, asi que un socket caido
   * jamas debe deshacer la escritura.
   */
  public dispatch(payload: UserModifiedPayload): void {
    for (const port of [...this.ports]) {
      try {
        port.emitUserModified(payload);
      } catch (error) {
        this.logger.error(
          `Un canal fallo al avisar de la modificacion del usuario ${payload.userId}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
