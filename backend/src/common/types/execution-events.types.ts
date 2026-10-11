import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';

/**
 * Nombres de los eventos que el motor publica hacia la interfaz.
 *
 * `as const` y no un `enum`: estas cadenas son el contrato de cable que el
 * cliente de Socket.io escribe literalmente en sus `socket.on(...)`. Un enum
 * obligaria al frontend a replicarlo para poder nombrarlas, y lo que se replica
 * a mano se desincroniza.
 */
export const EXECUTION_EVENT = {
  FLOW_PAUSED: 'flow:paused',
  FLOW_RESUMED: 'flow:resumed',
  NODE_ERROR: 'node:error',
} as const;

/** Union de los nombres de evento, derivada para que no haya que mantenerla. */
export type ExecutionEventName =
  (typeof EXECUTION_EVENT)[keyof typeof EXECUTION_EVENT];

/**
 * Lo que todo evento de ejecucion lleva siempre.
 *
 * `flowId` viaja ADEMAS de `executionId` aunque sea derivable: es la clave de la
 * sala (`flow_${flowId}`), asi que el emisor lo necesita en la mano y obligar al
 * gateway a consultarlo pondria una lectura a PostgreSQL en la ruta de cada
 * evento.
 *
 * `emittedAt` es una cadena ISO y no un `Date`. Cruza un socket, de modo que
 * acabara serializado igualmente; declararlo `Date` solo lograria que el tipo
 * del backend mintiese sobre lo que el navegador recibe.
 */
export interface ExecutionEventBase {
  readonly executionId: string;
  readonly flowId: string;
  readonly emittedAt: string;
}

/**
 * El motor detuvo la ejecucion conservando el cursor: es reanudable (CU-09).
 *
 * Los tres campos de causa son opcionales porque no toda pausa la provoca un
 * nodo. El circuit breaker de transiciones y el cursor inexistente paran el
 * bucle ANTES de ejecutar nada, y ahi no hay severidad, ni mensaje, ni archivo
 * que senalar.
 */
export interface FlowPausedEvent extends ExecutionEventBase {
  /** Nodo en el que quedo el cursor; es el que reintentara CU-09. */
  readonly activeCursor: string;
  readonly severity?: NodeErrorSeverity;
  readonly errorMessage?: string;
  readonly logFilePath?: string | null;
}

/** Un operador relanzo la ejecucion sobre la misma fila (CU-09). */
export interface FlowResumedEvent extends ExecutionEventBase {
  /** Nodo desde el que arranca el reintento. */
  readonly activeCursor: string;
  /** Quien pulso reanudar, para la traza de la interfaz. */
  readonly resumedBy: string;
}

/**
 * Un nodo termino sin exito. NO implica que el flujo se haya detenido: un
 * `LEVE` con reintentos emite esto y sigue adelante.
 *
 * `attempt` es 1-based —"intento 1 de 3"— porque es como se lee en una
 * interfaz; el contador crudo de `retryState` arranca en cero y mostraria
 * "intento 0" en el primer fallo.
 */
export interface NodeErrorEvent extends ExecutionEventBase {
  readonly nodeId: string;
  readonly severity: NodeErrorSeverity;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Ruta del `execution-*.log` con la traza, o `null` si no se pudo escribir. */
  readonly logFilePath: string | null;
  readonly attempt: number;
}
