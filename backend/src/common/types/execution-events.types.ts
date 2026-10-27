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
  NODE_STARTED: 'node:started',
  NODE_COMPLETED: 'node:completed',
  EXECUTION_UPDATED: 'execution:updated',
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
 * La fila de `ejecuciones_flujo` cambio de estado.
 *
 * Resumen MINIMO y global (namespace entero): es lo que necesita el historial
 * de ejecuciones para repintar una fila sin F5, aunque quien lo mira no este
 * suscrito a la sala del flujo. Lo deriva `ExecutionEventsCoordinator` de los
 * eventos de cierre, pausa, reanudacion y descarte, y del primer nodo de cada
 * vuelta del bucle; el motor solo lo emite a mano en los abortos por SQL.
 */
export interface ExecutionUpdatedEvent extends ExecutionEventBase {
  readonly state: ExecutionState;
  /** Nodo del cursor, o `null` en los estados terminales. */
  readonly activeCursor: string | null;
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
  /**
   * La pausa la pidio un nodo `PAUSA_FLOW`, no un fallo.
   *
   * Cambia por completo lo que la interfaz debe decir: no hay incidencia que
   * diagnosticar, no hay severidad y nadie tiene que corregir nada antes de
   * reanudar. Sin esta marca, el cliente presenta una suspension deliberada con
   * el mismo lenguaje de alarma que una caida, porque el resto del payload es
   * indistinguible —ambas dejan la ejecucion en PAUSADO con cursor vivo—.
   */
  readonly isProgrammedPause?: boolean;
  /** Motivo declarado por el nodo que pidio la pausa. Solo en pausas programadas. */
  readonly pauseReason?: string;
  /**
   * Nodo donde OCURRIO la pausa, que no siempre es el del cursor.
   *
   * En una pausa por FALLO los dos coinciden: el nodo que se rompio es el que
   * se reintentara. En una pausa PROGRAMADA no: el nodo de pausa ya se ejecuto
   * y el cursor apunta al paso siguiente, porque reanudar volviendo a entrar en
   * la pausa seria un bucle del que CU-09 no podria salir.
   *
   * Sin esta clave el cliente solo tiene `activeCursor`, y marcaria como
   * detenido un nodo que nunca llego a arrancar mientras el que de verdad se
   * ejecuto aparece completado. Se emite SIEMPRE —cayendo al cursor cuando no
   * hay nada que distinguir— para que el consumidor no tenga que ramificar.
   */
  readonly pausedStepId?: string;
}

/** Un operador relanzo la ejecucion sobre la misma fila (CU-09). */
export interface FlowResumedEvent extends ExecutionEventBase {
  /** Nodo desde el que arranca el reintento. */
  readonly activeCursor: string;
  /**
   * Quien reanudo, identificado Y nombrado.
   *
   * Era un `string` con el UUID, y el cliente lo imprimia tal cual en el aviso:
   * "reanudado por 3f1c2b64-8a5e-...". El correo ya viajaba en
   * `AuthenticatedUser` desde el JWT, asi que el dato legible estaba a mano y
   * se tiraba. El identificador se conserva porque es lo estable —un correo se
   * puede editar— y es con lo que se cruza la traza.
   */
  readonly resumedBy: { readonly id: string; readonly email: string };
  /**
   * Paso que el operador eligio, cuando no reanudo desde donde se detuvo.
   *
   * `activeCursor` dice desde donde ARRANCA la FSM y este desde donde lo pidio
   * una persona; coinciden salvo que el destino elegido se rechace. El cliente
   * lo necesita aparte para reiniciar las cajas del canvas posteriores al
   * punto elegido, que conservan el estado del intento anterior y mentirian
   * sobre lo que se va a reejecutar.
   */
  readonly targetStepId?: string;
  /** Nodo en el que estaba detenida, para poder limpiar su marca de pausa. */
  readonly previousCursor?: string;
  /**
   * La reanudacion llego por correo entrante y no por la interfaz.
   *
   * Cambia lo que el cliente anuncia: nadie esta mirando la pantalla cuando
   * ocurre, asi que el aviso tiene que decir de donde salio la orden.
   */
  readonly isEmailResume?: boolean;
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

/**
 * Lo que comparten los dos eventos del ciclo de vida de un nodo.
 *
 * `nodeId` y no `stepId`: un paso del pipeline no tiene mas identidad que su
 * clave en `PipelineSchema.nodes`, que es como ya lo nombra `NodeErrorEvent`.
 * Tampoco viaja un nombre legible, porque `PipelineNodeConfig` no tiene `name`:
 * la etiqueta la deriva el cliente de su propio catalogo de tipos, que es
 * presentacion y le corresponde.
 */
interface NodeLifecycleEventBase extends ExecutionEventBase {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  /**
   * Posicion del nodo en la topologia ESTATICA (0-based), o `null` si no es
   * alcanzable siguiendo `nextStep` desde el `entrypoint` —el caso de un nodo
   * de contingencia que solo cuelga de un `onErrorStep`.
   *
   * Sale de `buildOrderedTopology` y NO del contador de transiciones del bucle:
   * el consumidor ya tiene pintada esa misma proyeccion y lo que necesita es
   * "ilumina la caja numero 3 de las que ya tienes". Con el contador, una
   * reanudacion desde el quinto nodo anunciaria "paso 1", porque el bucle
   * arranca de cero sea cual sea el cursor de partida.
   *
   * `null` y no `-1`: un indice fuera de rango se pinta como caja valida en el
   * primer `array[index]` descuidado, mientras que el nulo obliga a decidir.
   */
  readonly stepIndex: number | null;
  /** Longitud de esa topologia: permite un "paso 3 de 7" sin otra consulta. */
  readonly totalSteps: number;
  /**
   * Ordinal REAL de esta vuelta del bucle (1-based).
   *
   * Distinto de `stepIndex` y complementario: es la clave de orden de la serie.
   * Con nodos de milisegundos y entregas por socket, es lo unico que deja
   * descartar llegadas desordenadas y entender un ciclo de recuperacion
   * `A -> B -> A`, donde el mismo `stepIndex` aparece dos veces.
   */
  readonly transition: number;
}

/**
 * El motor va a invocar la estrategia de un nodo.
 *
 * Se emite UNA VEZ POR INTENTO y no por nodo, igual que `NodeErrorEvent` y que
 * la fila de traza: con una sola emision inicial, un nodo que reintenta se
 * quedaria pintado como fallido durante el backoff, que es justo cuando el
 * operador necesita ver que sigue vivo.
 */
export interface NodeStartedEvent extends NodeLifecycleEventBase {
  /** 1-based, misma semantica que `NodeErrorEvent.attempt`. */
  readonly attempt: number;
}

/**
 * La estrategia de un nodo resolvio con exito.
 *
 * No existe el simetrico para el fallo: ese hueco ya lo cubre `NodeErrorEvent`,
 * y un `node:completed` con `success: false` obligaria a todo consumidor a
 * discriminar dentro del manejador del camino feliz.
 */
export interface NodeCompletedEvent extends NodeLifecycleEventBase {
  /**
   * Reloj de pared del nodo COMPLETO: incluye los reintentos y sus esperas.
   *
   * Es deliberadamente mayor que la `duracion_ms` que guarda `log_nodos`, que
   * mide cada invocacion por separado. Aqui interesa cuanto estuvo la caja
   * encendida en la pantalla.
   */
  readonly durationMs: number;
  /** Intentos consumidos hasta salir bien; `1` si fue a la primera. */
  readonly attempts: number;
  /** El nodo pidio parada ordenada (`NodeResult.halt`): el flujo acaba OMITIDO. */
  readonly halted: boolean;
}
