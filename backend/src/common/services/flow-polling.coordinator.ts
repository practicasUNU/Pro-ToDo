import { Injectable, Logger } from '@nestjs/common';

/**
 * Lo que el dominio necesita pedirle al sondeo, sin conocer quien lo implementa.
 *
 * Existe para romper un ciclo de modulos real: `NodesModule` importa
 * `WorkflowsModule` porque `ImapPollingService` despacha via `WorkflowsService`,
 * asi que la dependencia inversa —`WorkflowsService` inyectando el sondeo para
 * pararlo— cerraria el circulo. Con este puerto la flecha sigue yendo en un solo
 * sentido: el implementador se registra hacia arriba, y el dominio habla contra
 * una interfaz que no sabe nada de IMAP ni de `SchedulerRegistry`.
 */
export interface FlowPollingPort {
  /** Destruye el temporizador en memoria asociado al flujo. Idempotente. */
  stopPollingForFlow(flowId: string): void;

  /**
   * Reinscribe los temporizadores tras un cambio que el sondeo debe ver ya.
   *
   * Es una reconciliacion completa y no un alta puntual: quien la invoca sabe
   * que algo cambio, no CON QUE quedo el flujo, y resolver eso es justo el
   * trabajo del implementador.
   */
  refreshPolling(): Promise<void>;
}

/**
 * Punto de encuentro entre el dominio de flujos y el sondeo IMAP.
 *
 * Vive en `CommonModule` —global— por el mismo criterio que
 * `HybridLoggerService`: es infraestructura transversal que no pertenece al
 * dominio de ningun modulo concreto, y estar ahi permite que `WorkflowsService`
 * lo inyecte sin importar `NodesModule`.
 *
 * Sin implementador registrado, todas las operaciones son un no-op silencioso.
 * No es un fallo degradado: con `IMAP_POLLING_ENABLED != "true"` no hay ningun
 * temporizador que parar, y en las pruebas unitarias del dominio el coordinador
 * puede quedarse vacio a proposito.
 */
@Injectable()
export class FlowPollingCoordinator {
  private readonly logger = new Logger(FlowPollingCoordinator.name);

  private port: FlowPollingPort | null = null;

  /**
   * Inscribe al implementador. Lo llama `ImapPollingService.onModuleInit`.
   *
   * El ultimo registro gana: en produccion solo hay un sondeo, y en las pruebas
   * conviene poder sustituirlo sin arrastrar el anterior.
   */
  public register(port: FlowPollingPort): void {
    this.port = port;
  }

  /**
   * Da de baja al implementador actual.
   *
   * La llama `ImapPollingService.onModuleDestroy`. Sin ella, una recarga del
   * `--watch` de Nest dejaria aqui una referencia a un servicio muerto.
   */
  public unregister(): void {
    this.port = null;
  }

  /**
   * Corta el sondeo de un flujo inmediatamente.
   *
   * No propaga: se invoca desde la desactivacion de un flujo, y esa operacion ya
   * esta persistida cuando llegamos aqui. Fallar ahora convertiria una limpieza
   * de memoria fallida en un 500 sobre un cambio que la base de datos ya acepto.
   */
  public stopPollingForFlow(flowId: string): void {
    if (this.port === null) {
      return;
    }

    try {
      this.port.stopPollingForFlow(flowId);
    } catch (error) {
      this.logger.error(
        `No se pudo detener el sondeo del flujo "${flowId}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Fuerza una reconciliacion del sondeo.
   *
   * Tampoco propaga, y por el mismo motivo: la reconciliacion periodica del
   * propio sondeo volvera a intentarlo por su cuenta en el siguiente ciclo.
   */
  public async refreshPolling(): Promise<void> {
    if (this.port === null) {
      return;
    }

    try {
      await this.port.refreshPolling();
    } catch (error) {
      this.logger.error(
        `No se pudo reconciliar el sondeo IMAP: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
