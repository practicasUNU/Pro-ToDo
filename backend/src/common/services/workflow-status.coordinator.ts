import { Injectable, Logger } from '@nestjs/common';

/**
 * Lo que el motor necesita decirle al flujo, sin conocer quien lo persiste.
 *
 * Mismo patron y mismo motivo que `FlowPollingPort` y `ExecutionEventPort`:
 * `@core` no puede importar `@modules`, y el unico implementador
 * -`WorkflowsService`- vive alli porque es el dueño del repositorio de
 * `Workflow`. Con este puerto la flecha va en un solo sentido.
 *
 * NO se fusiona con `FlowPollingPort` aunque las dos fronteras se parezcan, y
 * hay tres motivos:
 *
 * 1. `WorkflowsService` ya es CONSUMIDOR de `FlowPollingCoordinator`
 *    (`releaseDeactivatedFlow` despacha `stopPollingForFlow`). Inscribirse
 *    ademas como puerto en aquel `Set` le devolveria sus propios despachos.
 * 2. Aquel puerto es sincrono y `void` porque solo toca temporizadores en
 *    memoria; este escribe en PostgreSQL y por tanto devuelve una promesa.
 * 3. Aquel existe porque `NodesModule` importa `WorkflowsModule`; este, porque
 *    `@core` no puede importar `@modules`. Son dos fronteras distintas y
 *    fundirlas haria ilegible el porque de cada una.
 */
export interface WorkflowStatusPort {
  /**
   * Pone el flujo en PAUSADO y libera lo que eso implique.
   *
   * Debe ser IDEMPOTENTE y no propagar: quien llama es el motor a mitad de una
   * transicion, con la ejecucion ya persistida como PAUSADO. Un fallo aqui deja
   * el flujo mal etiquetado, que es molesto; propagarlo convertiria una pausa
   * reanudable en una excepcion sin checkpoint, que es mucho peor.
   */
  pauseFlow(flowId: string, reason: string): Promise<void>;
}

/**
 * Punto de encuentro entre el motor FSM y el dueño del estado del flujo.
 *
 * Vive en `CommonModule` -global- por el mismo criterio que sus tres hermanos:
 * lo consume `FsmEngineService` (`@core`) y lo implementa `WorkflowsService`
 * (`@modules/workflows`), que no comparten modulo.
 *
 * Sin implementadores inscritos es un no-op silencioso, igual que
 * `ExecutionEventsCoordinator`: eso permite inyectar la clase real en las
 * pruebas unitarias del motor en vez de un doble.
 */
@Injectable()
export class WorkflowStatusCoordinator {
  private readonly logger = new Logger(WorkflowStatusCoordinator.name);

  private readonly ports = new Set<WorkflowStatusPort>();

  /** Inscribe al dueño del estado. Lo llama `WorkflowsService.onModuleInit`. */
  public register(port: WorkflowStatusPort): void {
    this.ports.add(port);
  }

  /**
   * Da de baja al implementador. Sin ella, una recarga del `--watch` de Nest
   * dejaria aqui un servicio muerto -con su repositorio ya cerrado- conviviendo
   * con la instancia nueva.
   */
  public unregister(port: WorkflowStatusPort): void {
    this.ports.delete(port);
  }

  /**
   * Pide a quien corresponda que marque el flujo como PAUSADO.
   *
   * Se ESPERA a que terminen todos los puertos, a diferencia de los eventos de
   * notificacion: esto es una escritura en la base de datos y el llamante
   * (`pauseAt`) emite justo despues el `flow:paused` que la interfaz usara para
   * repintar. Sin el `await`, el cliente podria leer la fila antes de que
   * cambiase y pintar "Activo" sobre una ejecucion detenida.
   *
   * El `try/catch` es POR PUERTO y no propaga NADA: ver el TSDoc del puerto.
   */
  public async pauseFlow(flowId: string, reason: string): Promise<void> {
    for (const port of [...this.ports]) {
      try {
        await port.pauseFlow(flowId, reason);
      } catch (error) {
        this.logger.error(
          `No se pudo marcar como PAUSADO el flujo "${flowId}": ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }
}
