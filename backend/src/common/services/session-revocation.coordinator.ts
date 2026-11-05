import { Injectable, Logger } from '@nestjs/common';

/**
 * Lo que un servicio de dominio necesita para cerrar las sesiones de alguien,
 * sin conocer como se almacenan.
 *
 * Existe por la misma frontera de modulos que los puertos de eventos, pero con
 * un motivo adicional: `RefreshTokenService` vive en `AuthModule`, que importa
 * `UsersModule`, y ni siquiera figura en sus `exports`. Inyectarlo en
 * `UsersService` cerraria el ciclo `Auth -> Users -> Auth`, que es justo lo que
 * el proyecto evita con coordinadores en `CommonModule` (global).
 *
 * ASINCRONO, a diferencia de los puertos de eventos: aqui no se difunde nada,
 * se ESCRIBE en `tokens_sesion`. Quien lo llama tiene que poder esperar a que
 * la revocacion este confirmada antes de responder, o anunciaria un cierre de
 * sesion que todavia no ha ocurrido.
 */
export interface SessionRevocationPort {
  revokeAllForUser(userId: string): Promise<void>;
}

/**
 * Punto de encuentro entre los servicios de dominio y el almacen de sesiones.
 *
 * Reparte entre todos los puertos inscritos, igual que los otros dos
 * coordinadores, y sin implementadores es un no-op silencioso.
 */
@Injectable()
export class SessionRevocationCoordinator {
  private readonly logger = new Logger(SessionRevocationCoordinator.name);

  private readonly ports = new Set<SessionRevocationPort>();

  /** Inscribe un almacen. Lo llama `RefreshTokenService.onModuleInit`. */
  public registerPort(port: SessionRevocationPort): void {
    this.ports.add(port);
  }

  /** Da de baja un almacen, con la misma referencia con la que se inscribio. */
  public unregisterPort(port: SessionRevocationPort): void {
    this.ports.delete(port);
  }

  /**
   * Revoca las sesiones vivas del usuario en todos los almacenes inscritos.
   *
   * A DIFERENCIA de los coordinadores de eventos, aqui los fallos SE PROPAGAN.
   * Una revocacion que no llega a escribirse deja sesiones abiertas que el
   * sistema cree cerradas, y tragarse ese error convertiria un fallo de
   * seguridad en un silencio. El llamante decide si aborta o sigue.
   */
  public async revokeAllForUser(userId: string): Promise<void> {
    for (const port of [...this.ports]) {
      await port.revokeAllForUser(userId);
    }

    this.logger.log(`Sesiones revocadas para el usuario ${userId}.`);
  }
}
