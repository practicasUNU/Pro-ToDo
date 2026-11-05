import { Injectable, Logger } from '@nestjs/common';

import type { PricingUpdatedPayload } from '@common/types/pricing-events.types';

/**
 * Lo que `PricingService` necesita difundir sin conocer por donde sale.
 *
 * Mismo patron que `SessionEventPort`: `NotificationsModule` importa
 * `AuthModule`, de modo que inyectar el gateway en un servicio de dominio
 * arriesga un ciclo de modulos. SINCRONO y `void` porque `emit` de Socket.io no
 * espera acuse.
 */
export interface PricingEventPort {
  emitPricingUpdated(payload: PricingUpdatedPayload): void;
}

/**
 * Punto de encuentro entre `PricingService` y los canales de aviso.
 *
 * Conjunto de puertos y no puntero unico, por el mismo criterio que los demas
 * coordinadores. Sin puertos inscritos todo es un no-op silencioso, lo que
 * permite inyectar la clase real en las pruebas.
 */
@Injectable()
export class PricingEventsCoordinator {
  private readonly logger = new Logger(PricingEventsCoordinator.name);

  private readonly ports = new Set<PricingEventPort>();

  /** Inscribe un canal. Lo llama `NotificationGateway.onModuleInit`. */
  public registerPort(port: PricingEventPort): void {
    this.ports.add(port);
  }

  /** Da de baja un canal (recargas del `--watch`). */
  public unregisterPort(port: PricingEventPort): void {
    this.ports.delete(port);
  }

  /**
   * Reparte el aviso. Se llama DESPUES del `COMMIT`: un socket caido jamas
   * debe deshacer una tarifa ya escrita, asi que los errores se registran y se
   * tragan, con `try/catch` por puerto para que uno roto no silencie al resto.
   */
  public dispatch(payload: PricingUpdatedPayload): void {
    for (const port of [...this.ports]) {
      try {
        port.emitPricingUpdated(payload);
      } catch (error) {
        this.logger.error(
          `Un canal fallo al avisar de la tarifa ${payload.aiProvider}/${payload.aiModel}.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
