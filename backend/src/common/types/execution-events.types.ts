import type { ExecutionState } from '@core/fsm/types/fsm.enums';
import type { NodeErrorSeverity } from '@core/fsm/types/node-strategy.types';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';

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
  FLOW_DISCARDED: 'flow:discarded',
  FLOW_COMPLETED: 'flow:completed',
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
  /**
   * Nombre legible del flujo. Opcional porque el motor solo lo conoce si quien
   * despacha se lo pasa (`ExecuteWorkflowOptions.flowName`); sin el, la interfaz
   * cae a un identificador abreviado.
   */
  readonly flowName?: string;
  /** Tipo del nodo que quedo bloqueado: dice QUE hay que mirar, no solo donde. */
  readonly nodeType?: NodeType;
  /**
   * Codigo del fallo (`ERR_TEMPLATE_PENDING_VARS`, ...). Es el contrato que ya
   * leen las rutas `onErrorStep`, y el unico dato del aviso que lleva al
   * operador a un sitio concreto en vez de a una descripcion.
   */
  readonly errorCode?: string;
  /**
   * Intentos reales que consumio el nodo antes de rendirse.
   *
   * Lo declara la estrategia cuando agota su propio presupuesto; si no, es el
   * contador de reintentos del motor. Cambia lo que hace quien lee el aviso:
   * un fallo al primer intento invita a reanudar, y uno tras agotar tres dice
   * que insistir ahora mismo no va a servir.
   */
  readonly attempts?: number;
  /** Causa raiz tecnica (`NodeErrorDetail.description`), mas larga que el mensaje. */
  readonly errorDetail?: string;
}

/** Un operador relanzo la ejecucion sobre la misma fila (CU-09). */
export interface FlowResumedEvent extends ExecutionEventBase {
  /** Nodo desde el que arranca el reintento. */
  readonly activeCursor: string;
  /** Quien pulso reanudar, para la traza de la interfaz. */
  readonly resumedBy: string;
}

/**
 * Un operador renuncio a reanudar una ejecucion detenida: cierre manual.
 *
 * Es el contrapunto de `FlowResumedEvent` y la segunda salida de una PAUSADO.
 */
export interface FlowDiscardedEvent extends ExecutionEventBase {
  /** Quien pulso descartar, para la traza de la interfaz. */
  readonly discardedBy: string;
  /**
   * Paso en el que estaba detenida antes de descartarla.
   *
   * Viaja en el evento porque la fila lo acaba de perder: el descarte anula
   * `paso_actual`, de modo que quien reciba esto despues no puede consultarlo.
   */
  readonly lastCursor: string;
  /** El flujo padre quedo retirado de los disparadores automaticos. */
  readonly workflowDeactivated: boolean;
}

/**
 * La ejecucion alcanzo un estado TERMINAL sin cursor que reintentar.
 *
 * Un solo evento para los tres desenlaces en vez de tres eventos distintos: el
 * cliente decide el tono leyendo `finalState`, y tres nombres obligarian a tres
 * `socket.on` que hacen lo mismo. La pausa queda fuera a proposito —es
 * reanudable y ya tiene su propio evento.
 */
export interface FlowCompletedEvent extends ExecutionEventBase {
  /** `EXITOSO`, `OMITIDO`, `FALLIDO` o `DESCARTADO`. */
  readonly finalState: ExecutionState;
  readonly flowName?: string;
  /** Motivo persistido en `motivo_fallo`, o `null` si no hubo. */
  readonly failureReason?: string | null;
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
