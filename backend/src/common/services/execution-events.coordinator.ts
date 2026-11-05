import { Injectable, Logger } from '@nestjs/common';

import { ExecutionState } from '@core/fsm/types/fsm.enums';

import type {
  ExecutionUpdatedEvent,
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeCompletedEvent,
  NodeErrorEvent,
  NodeStartedEvent,
} from '@common/types/execution-events.types';

/**
 * Lo que el motor necesita contar al mundo, sin conocer por donde sale.
 *
 * Mismo patron y mismo motivo que `FlowPollingPort`: `@core` no puede importar
 * `@modules`, y el unico implementador —`NotificationGateway`— vive en
 * `@modules/notifications`. Con este puerto la flecha va en un solo sentido: el
 * gateway se inscribe hacia arriba y el motor habla contra una interfaz que no
 * sabe nada de Socket.io, de salas ni de JWT.
 *
 * Todos los metodos son SINCRONOS y devuelven `void`. No es descuido: se invocan
 * desde `pauseAt` y `logNodeOutcome`, que estan en la ruta critica del bucle de
 * la FSM. Devolver una promesa invitaria a esperarla, y eso acoplaria la
 * latencia del motor a la de la red. Ademas seria una promesa vacia: `emit` de
 * Socket.io no espera acuse de nadie, asi que prometer una entrega que el
 * transporte no garantiza solo serviria para mentir.
 */
export interface ExecutionEventPort {
  emitFlowPaused(event: FlowPausedEvent): void;
  emitFlowResumed(event: FlowResumedEvent): void;
  emitFlowDiscarded(event: FlowDiscardedEvent): void;
  emitFlowCompleted(event: FlowCompletedEvent): void;
  emitNodeError(event: NodeErrorEvent): void;
  emitNodeStarted(event: NodeStartedEvent): void;
  emitNodeCompleted(event: NodeCompletedEvent): void;
  emitExecutionUpdated(event: ExecutionUpdatedEvent): void;
}

/**
 * Punto de encuentro entre el motor FSM y los canales de notificacion.
 *
 * Vive en `CommonModule` —global— por el mismo criterio que
 * `FlowPollingCoordinator`: lo consumen `FsmEngineService` (`@core`) y
 * `ExecutionsService` (`@modules/workflows`), que no comparten modulo, y lo
 * implementa un tercero que no conoce ninguno de los dos.
 *
 * Mantiene un CONJUNTO de puertos y no un puntero unico. Hoy solo hay un
 * implementador, pero la semantica de "el ultimo registro gana" es justo la que
 * deja al anterior dado de baja en silencio el dia que aparezca un segundo
 * canal —un webhook, una cola— sin mas sintoma que unos eventos que dejan de
 * llegar.
 *
 * Sin implementadores registrados todo es un no-op silencioso. No es un modo
 * degradado: en las pruebas unitarias del motor el coordinador se queda vacio a
 * proposito, y eso permite inyectar la clase real en vez de un doble.
 */
@Injectable()
export class ExecutionEventsCoordinator {
  private readonly logger = new Logger(ExecutionEventsCoordinator.name);

  private readonly ports = new Set<ExecutionEventPort>();

  /**
   * Inscribe un canal. Lo llama `NotificationGateway.onModuleInit`.
   *
   * Al ser un `Set`, registrar dos veces la MISMA referencia no duplica la
   * emision. Lo que si duplicaria es inscribir dos literales distintos, y por
   * eso cada implementador se registra a si mismo (`this`) para poder darse de
   * baja con la misma referencia.
   */
  public register(port: ExecutionEventPort): void {
    this.ports.add(port);
  }

  /**
   * Da de baja un canal. Lo llama `onModuleDestroy`.
   *
   * Sin ella, una recarga del `--watch` de Nest dejaria aqui un gateway muerto
   * —cuyo servidor de Socket.io ya esta cerrado— conviviendo con la instancia
   * nueva: cada evento se emitiria dos veces, una de ellas al vacio.
   */
  public unregister(port: ExecutionEventPort): void {
    this.ports.delete(port);
  }

  public emitFlowPaused(event: FlowPausedEvent): void {
    this.dispatch('flow:paused', (port) => port.emitFlowPaused(event));
    this.emitExecutionUpdated({
      ...this.baseOf(event),
      state: ExecutionState.PAUSADO,
      activeCursor: event.activeCursor,
    });
  }

  public emitFlowResumed(event: FlowResumedEvent): void {
    this.dispatch('flow:resumed', (port) => port.emitFlowResumed(event));
    this.emitExecutionUpdated({
      ...this.baseOf(event),
      state: ExecutionState.EN_PROCESO,
      activeCursor: event.activeCursor,
    });
  }

  public emitFlowDiscarded(event: FlowDiscardedEvent): void {
    this.dispatch('flow:discarded', (port) => port.emitFlowDiscarded(event));
    this.emitExecutionUpdated({
      ...this.baseOf(event),
      state: ExecutionState.DESCARTADO,
      activeCursor: null,
    });
  }

  public emitFlowCompleted(event: FlowCompletedEvent): void {
    this.dispatch('flow:completed', (port) => port.emitFlowCompleted(event));
    this.emitExecutionUpdated({
      ...this.baseOf(event),
      state: event.finalState,
      activeCursor: null,
    });
  }

  /**
   * Resumen global de cambio de estado para el historial de ejecuciones.
   *
   * Publico porque el motor lo emite tambien a mano donde no hay otro evento
   * del que derivarlo (`abortExecutionsForFlow`, que cierra filas por SQL).
   */
  public emitExecutionUpdated(event: ExecutionUpdatedEvent): void {
    this.dispatch('execution:updated', (port) =>
      port.emitExecutionUpdated(event),
    );
  }

  public emitNodeError(event: NodeErrorEvent): void {
    this.dispatch('node:error', (port) => port.emitNodeError(event));
  }

  /**
   * Los dos del ciclo de vida del nodo se despachan igual que los demas, pero
   * se invocan desde el CENTRO del bucle de la FSM y no desde un cierre. El
   * aislamiento por puerto de `dispatch` deja de ser una precaucion y pasa a ser
   * el unico motivo por el que un canal roto no aborta una transicion en curso.
   */
  public emitNodeStarted(event: NodeStartedEvent): void {
    this.dispatch('node:started', (port) => port.emitNodeStarted(event));

    // Solo la PRIMERA vuelta del bucle: es cuando la fila pasa a EN_PROCESO
    // (alta nueva o reanudacion). Derivarlo de cada nodo difundiria al
    // namespace entero el trafico que `node:started` reserva a la sala.
    if (event.transition === 1 && event.attempt === 1) {
      this.emitExecutionUpdated({
        ...this.baseOf(event),
        state: ExecutionState.EN_PROCESO,
        activeCursor: event.nodeId,
      });
    }
  }

  public emitNodeCompleted(event: NodeCompletedEvent): void {
    this.dispatch('node:completed', (port) => port.emitNodeCompleted(event));
  }

  /** Los tres campos comunes, sin arrastrar el resto del payload de origen. */
  private baseOf(event: {
    readonly executionId: string;
    readonly flowId: string;
    readonly emittedAt: string;
  }): Pick<ExecutionUpdatedEvent, 'executionId' | 'flowId' | 'emittedAt'> {
    return {
      executionId: event.executionId,
      flowId: event.flowId,
      emittedAt: event.emittedAt,
    };
  }

  /**
   * Reparte un evento a todos los puertos sin dejar que ninguno rompa el bucle.
   *
   * El `try/catch` es POR PUERTO y no alrededor del recorrido: un canal roto no
   * puede impedir que el otro reciba. Y no propaga NADA hacia arriba, que es la
   * razon de ser de esta capa — quien llama es el motor FSM a mitad de una
   * transicion, y una notificacion fallida no puede convertirse en una
   * ejecucion fallida.
   *
   * Se itera una copia: un puerto puede darse de baja durante su propio
   * despacho (recarga del `--watch`), y mutar el `Set` mientras se recorre es
   * justo la clase de fallo que no deja rastro en ningun log.
   */
  private dispatch(
    eventName: string,
    deliver: (port: ExecutionEventPort) => void,
  ): void {
    for (const port of [...this.ports]) {
      try {
        deliver(port);
      } catch (error) {
        this.logger.error(
          `No se pudo emitir "${eventName}" por uno de los canales: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
