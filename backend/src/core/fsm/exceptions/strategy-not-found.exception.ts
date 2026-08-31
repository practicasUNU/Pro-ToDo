/**
 * No hay ninguna estrategia registrada para el tipo de nodo solicitado.
 *
 * Es un error de configuracion, no un fallo transitorio: reintentar no lo
 * arregla. `FsmEngineService` lo aisla como cualquier otra excepcion de nodo y
 * lo normaliza a un `NodeResult` de nivel URGENTE, de modo que la ejecucion
 * queda en PAUSADO en vez de tumbar el proceso.
 */
export class StrategyNotFoundException extends Error {
  constructor(public readonly nodeType: string) {
    super(
      `No hay ninguna estrategia registrada para el tipo de nodo "${nodeType}".`,
    );
    this.name = 'StrategyNotFoundException';
  }
}
