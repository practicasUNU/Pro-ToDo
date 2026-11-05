import { Injectable, Logger } from '@nestjs/common';

/**
 * Lo que el dominio necesita pedirle a los disparadores automaticos, sin
 * conocer quien los implementa.
 *
 * Existe para romper un ciclo de modulos real: `NodesModule` importa
 * `WorkflowsModule` porque los disparadores despachan via `WorkflowsService`,
 * asi que la dependencia inversa —`WorkflowsService` inyectando el sondeo para
 * pararlo— cerraria el circulo. Con este puerto la flecha sigue yendo en un solo
 * sentido: el implementador se registra hacia arriba, y el dominio habla contra
 * una interfaz que no sabe nada de IMAP, de cron ni de `SchedulerRegistry`.
 *
 * El nombre `FlowPollingPort` es historico: nacio cuando el unico implementador
 * era el sondeo IMAP. Hoy tambien lo implementa `CronSchedulingService`, que no
 * sondea nada. Se conserva porque renombrarlo tocaria media docena de ficheros
 * sin cambiar ni una linea de comportamiento.
 */
export interface FlowPollingPort {
  /** Destruye el temporizador en memoria asociado al flujo. Idempotente. */
  stopPollingForFlow(flowId: string): void;

  /**
   * Reinscribe los temporizadores tras un cambio que el disparador debe ver ya.
   *
   * Es una reconciliacion completa y no un alta puntual: quien la invoca sabe
   * que algo cambio, no CON QUE quedo el flujo, y resolver eso es justo el
   * trabajo del implementador.
   */
  refreshPolling(): Promise<void>;
}

/**
 * Punto de encuentro entre el dominio de flujos y los disparadores automaticos.
 *
 * Vive en `CommonModule` —global— por el mismo criterio que
 * `HybridLoggerService`: es infraestructura transversal que no pertenece al
 * dominio de ningun modulo concreto, y estar ahi permite que `WorkflowsService`
 * lo inyecte sin importar `NodesModule`.
 *
 * Mantiene un CONJUNTO de puertos, no uno solo. La version anterior guardaba un
 * unico puntero con semantica de "el ultimo registro gana", que era correcta
 * mientras `ImapPollingService` fuese el unico implementador; al aparecer
 * `CronSchedulingService` ese modelo dejaria al sondeo IMAP dado de baja en
 * silencio segun el orden de arranque de los modulos, sin ningun sintoma mas
 * que unos buzones que dejan de mirarse.
 *
 * Sin implementadores registrados, todas las operaciones son un no-op
 * silencioso. No es un fallo degradado: con las banderas de disparo apagadas no
 * hay ningun temporizador que parar, y en las pruebas unitarias del dominio el
 * coordinador puede quedarse vacio a proposito.
 */
@Injectable()
export class FlowPollingCoordinator {
  private readonly logger = new Logger(FlowPollingCoordinator.name);

  private readonly ports = new Set<FlowPollingPort>();

  /**
   * Inscribe un implementador. Lo llaman `ImapPollingService.onModuleInit` y
   * `CronSchedulingService.onModuleInit`.
   *
   * Al ser un `Set`, registrar dos veces la MISMA referencia no duplica el
   * despacho. Lo que si duplicaria es registrar dos literales distintos, y por
   * eso cada implementador retiene el objeto que inscribio para darlo de baja.
   */
  public register(port: FlowPollingPort): void {
    this.ports.add(port);
  }

  /**
   * Da de baja a un implementador concreto.
   *
   * La llaman los `onModuleDestroy`. Sin ella, una recarga del `--watch` de Nest
   * dejaria aqui una referencia a un servicio muerto —cuyo mapa de temporizadores
   * esta vacio, asi que toda parada seria un no-op fantasma— conviviendo con la
   * instancia nueva.
   */
  public unregister(port: FlowPollingPort): void {
    this.ports.delete(port);
  }

  /**
   * Corta el disparo automatico de un flujo inmediatamente, en todos los puertos.
   *
   * No propaga: se invoca desde la desactivacion de un flujo, y esa operacion ya
   * esta persistida cuando llegamos aqui. Fallar ahora convertiria una limpieza
   * de memoria fallida en un 500 sobre un cambio que la base de datos ya acepto.
   * Y el `try/catch` es POR PUERTO: un implementador roto no puede impedir que
   * el otro pare su propio temporizador.
   */
  public stopPollingForFlow(flowId: string): void {
    // Se itera una copia: un puerto puede darse de baja durante su propio
    // despacho (recarga del `--watch`), y mutar el `Set` mientras se recorre es
    // justo la clase de fallo que no deja rastro en ningun log.
    for (const port of [...this.ports]) {
      try {
        port.stopPollingForFlow(flowId);
      } catch (error) {
        this.logger.error(
          `No se pudo detener el disparo del flujo "${flowId}" en uno de los puertos: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  /**
   * Fuerza una reconciliacion en todos los puertos.
   *
   * Tampoco propaga, y por el mismo motivo: la reconciliacion periodica de cada
   * implementador volvera a intentarlo por su cuenta en el siguiente ciclo.
   *
   * En paralelo y no en serie: las promesas ya vienen protegidas uno a uno, asi
   * que ninguna rechaza y `Promise.all` no puede cortocircuitar. Encadenarlas
   * solo lograria que un puerto lento retrasase la reconciliacion del otro.
   */
  public async refreshPolling(): Promise<void> {
    await Promise.all(
      [...this.ports].map(async (port) => {
        try {
          await port.refreshPolling();
        } catch (error) {
          this.logger.error(
            `No se pudo reconciliar uno de los puertos de disparo automatico: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }),
    );
  }
}
