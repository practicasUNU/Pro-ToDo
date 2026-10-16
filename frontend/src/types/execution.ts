/**
 * Replica de los contratos que expone `ExecutionsController` del backend
 * (`backend/src/modules/workflows/dto/`) y del canal WebSocket del
 * `NotificationGateway`.
 *
 * Se escriben a mano y no se generan: el backend no publica su esquema en un
 * paquete compartido. La contrapartida es que cualquier cambio alla hay que
 * traerlo aqui, y por eso cada bloque nombra el archivo del que procede.
 */

/**
 * Estados de una ejecucion. Copia literal de
 * `backend/src/core/fsm/types/fsm.enums.ts`.
 *
 * Son SIETE. Dos se olvidan con facilidad: `OMITIDO` no es un fallo —el buzon
 * no traia correos nuevos, o el asunto no casaba con el filtro— pero tampoco un
 * exito, y pintarlo como tal haria que cualquier recuento midiese sobre todo
 * buzones vacios; `DESCARTADO` es la renuncia explicita de un operador sobre
 * una PAUSADO, y confundirlo con `FALLIDO` haria crecer el recuento de
 * incidencias justo cuando alguien resuelve una.
 */
import type { CrudMutationPayload } from '@/types/crud-events';
import type { NodeType, PipelineSummary } from '@/types/pipeline';

export enum ExecutionState {
  INACTIVO = 'INACTIVO',
  EN_PROCESO = 'EN_PROCESO',
  PAUSADO = 'PAUSADO',
  EXITOSO = 'EXITOSO',
  OMITIDO = 'OMITIDO',
  FALLIDO = 'FALLIDO',
  DESCARTADO = 'DESCARTADO',
}

/** Severidad de un fallo de nodo. Copia de `NodeErrorSeverity` del motor. */
export type NodeErrorSeverity = 'LEVE' | 'GRAVE' | 'URGENTE';

/**
 * Fila del listado. Replica `ExecutionSummaryResponseDto`.
 *
 * Deliberadamente SIN el contexto acumulado: el backend lo omite del `select`
 * del listado porque es un `jsonb` que puede llevar correos enteros con
 * adjuntos en base64. Si algun dia aparece aqui, es que alguien rompio esa
 * garantia alla.
 */
export interface ExecutionSummary {
  readonly executionId: string;
  readonly flowId: string;
  readonly state: ExecutionState;
  readonly activeCursor: string | null;
  readonly logFilePath: string | null;
  readonly failureReason: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** Pagina del listado. Replica `ExecutionPageResponseDto`. */
export interface ExecutionPage {
  readonly items: ExecutionSummary[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Vista de detalle: el resumen mas el checkpoint. Replica `ExecutionDetailResponseDto`. */
export interface ExecutionDetail extends ExecutionSummary {
  readonly context: Record<string, Record<string, unknown>>;
  readonly retryState: Record<string, unknown>;
}

/** Filtros de `GET /executions`. Replica `ListExecutionsQueryDto`. */
export interface ExecutionListQuery {
  readonly flowId?: string;
  readonly state?: ExecutionState;
  readonly limit?: number;
  readonly offset?: number;
}

/** Desenlace de una reanudacion. Replica `WorkflowExecutionResponseDto`. */
export interface WorkflowExecutionResult {
  readonly executionId: string;
  readonly workflowId: string;
  readonly status: ExecutionState;
  readonly activeCursor: string | null;
  readonly context: Record<string, Record<string, unknown>>;
}

/**
 * Desenlace de un descarte. Replica `DiscardExecutionResponseDto`.
 *
 * Trae las DOS filas que el descarte toca: cerrar una ejecucion detenida retira
 * ademas su flujo de los disparadores automaticos.
 */
export interface DiscardExecutionResult {
  readonly execution: ExecutionSummary;
  readonly workflow: PipelineSummary;
}

// --- Canal WebSocket (`backend/src/common/types/execution-events.types.ts`) ---

/** Nombres de evento, identicos a los del backend. */
export const EXECUTION_EVENT = {
  FLOW_PAUSED: 'flow:paused',
  FLOW_RESUMED: 'flow:resumed',
  FLOW_DISCARDED: 'flow:discarded',
  FLOW_COMPLETED: 'flow:completed',
  NODE_ERROR: 'node:error',
  NODE_STARTED: 'node:started',
  NODE_COMPLETED: 'node:completed',
} as const;

export interface ExecutionEventBase {
  readonly executionId: string;
  readonly flowId: string;
  readonly emittedAt: string;
}

export interface FlowPausedEvent extends ExecutionEventBase {
  readonly activeCursor: string;
  readonly severity?: NodeErrorSeverity;
  readonly errorMessage?: string;
  readonly logFilePath?: string | null;
  /** Opcional: el motor solo lo conoce si quien despacha se lo pasa. */
  readonly flowName?: string;
  /**
   * Tipo del nodo bloqueado. Ausente en las pausas que ocurren ANTES de
   * ejecutar nodo alguno (circuit breaker, cursor inexistente).
   */
  readonly nodeType?: string;
  readonly errorCode?: string;
  /**
   * Intentos reales consumidos antes de rendirse.
   *
   * Lo declara la estrategia cuando agota su presupuesto interno; si no, es el
   * contador del motor. Ausente en las pausas previas a ejecutar nodo alguno.
   */
  readonly attempts?: number;
  /** Causa raiz tecnica, mas larga que `errorMessage`. */
  readonly errorDetail?: string;
  /**
   * La pausa la pidio un nodo `PAUSA_FLOW`, no un fallo.
   *
   * Cambia por completo lo que hay que decir: no hay incidencia, no hay
   * severidad y nadie tiene que corregir nada antes de reanudar. Sin esta marca
   * el aviso cae a `GRAVE` y presenta una suspension deliberada con el lenguaje
   * de una averia, porque el resto del payload es indistinguible.
   */
  readonly isProgrammedPause?: boolean;
  /** Motivo declarado por el nodo. Solo en pausas programadas. */
  readonly pauseReason?: string;
  /**
   * Nodo donde OCURRIO la pausa, que no siempre es el del cursor.
   *
   * En una pausa por fallo coinciden. En una programada no: el nodo de pausa ya
   * se ejecuto y el cursor apunta al paso SIGUIENTE, porque reanudar volviendo
   * a entrar en la pausa seria un bucle. Pintar el cursor marcaria como
   * detenido un nodo que nunca arranco.
   */
  readonly pausedStepId?: string;
}

/** Un operador renuncio a reanudar: cierre manual de una PAUSADO. */
export interface FlowDiscardedEvent extends ExecutionEventBase {
  readonly discardedBy: string;
  /** Paso donde estaba detenida; la fila acaba de perderlo. */
  readonly lastCursor: string;
  readonly workflowDeactivated: boolean;
}

/**
 * La ejecucion alcanzo un estado terminal sin cursor que reintentar.
 *
 * Un solo evento para todos los desenlaces: el tono del aviso lo decide
 * `finalState`, de modo que la pausa —que SI es reanudable— queda fuera y
 * conserva su propio evento.
 */
export interface FlowCompletedEvent extends ExecutionEventBase {
  readonly finalState: ExecutionState;
  readonly flowName?: string;
  readonly failureReason?: string | null;
}

export interface FlowResumedEvent extends ExecutionEventBase {
  readonly activeCursor: string;
  /**
   * Quien reanudo, identificado Y nombrado.
   *
   * Era el UUID suelto, y el aviso lo imprimia tal cual: "reanudado por
   * 3f1c2b64-8a5e-...". El correo ya viajaba en el JWT, asi que el dato legible
   * estaba a mano y se tiraba.
   */
  readonly resumedBy: { readonly id: string; readonly email: string };
  /**
   * Paso que el operador eligio, cuando no reanudo desde donde se detuvo.
   *
   * Es lo que permite reiniciar las cajas posteriores al punto elegido: sin el,
   * conservan el `COMPLETADO` del intento anterior y mienten sobre lo que se va
   * a reejecutar.
   */
  readonly targetStepId?: string;
  /** Nodo donde estaba detenida, para poder borrar su marca de pausa. */
  readonly previousCursor?: string;
  /** La orden llego por correo entrante y no desde la interfaz. */
  readonly isEmailResume?: boolean;
}

export interface NodeErrorEvent extends ExecutionEventBase {
  readonly nodeId: string;
  readonly severity: NodeErrorSeverity;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly logFilePath: string | null;
  readonly attempt: number;
}

/** Acuse de las suscripciones a sala. */
/**
 * Lo que comparten los dos eventos del ciclo de vida de un nodo.
 *
 * Replica exacta de `NodeLifecycleEventBase` del backend
 * (`@common/types/execution-events.types.ts`).
 */
interface NodeLifecycleEvent extends ExecutionEventBase {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  /**
   * Posicion en la topologia ESTATICA (0-based), o `null` si el nodo solo
   * cuelga de un `onErrorStep` y por tanto no esta en el camino nominal.
   */
  readonly stepIndex: number | null;
  readonly totalSteps: number;
  /** Ordinal real de la vuelta del bucle (1-based): ordena la serie. */
  readonly transition: number;
}

/** El motor va a invocar la estrategia de un nodo. Llega UNO POR INTENTO. */
export interface NodeStartedEvent extends NodeLifecycleEvent {
  readonly attempt: number;
}

/** La estrategia de un nodo resolvio con exito. Solo en el camino feliz. */
export interface NodeCompletedEvent extends NodeLifecycleEvent {
  /** Reloj de pared del nodo completo: incluye reintentos y esperas. */
  readonly durationMs: number;
  readonly attempts: number;
  readonly halted: boolean;
}

export interface RoomAck {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Mapas de eventos del socket.
 *
 * Existen para tipar `Socket<ServerToClientEvents, ClientToServerEvents>`: con
 * ellos `socket.on('flow:paused', (event) => ...)` infiere el payload sin
 * anotarlo, y un nombre de evento mal escrito es un error de compilacion en vez
 * de un listener que no se dispara nunca.
 */
export interface ServerToClientEvents {
  'flow:paused': (event: FlowPausedEvent) => void;
  'flow:resumed': (event: FlowResumedEvent) => void;
  'flow:discarded': (event: FlowDiscardedEvent) => void;
  'flow:completed': (event: FlowCompletedEvent) => void;
  'node:error': (event: NodeErrorEvent) => void;
  'node:started': (event: NodeStartedEvent) => void;
  'node:completed': (event: NodeCompletedEvent) => void;
  // Familia aparte —mutaciones de tablas maestras—, pero comparte socket, y el
  // mapa tipado tiene que conocerla o `socket.on` la rechaza en compilacion.
  'crud:mutation': (payload: CrudMutationPayload) => void;
}

export interface ClientToServerEvents {
  'flow:subscribe': (payload: { flowId: string }, ack: (response: RoomAck) => void) => void;
  'flow:unsubscribe': (payload: { flowId: string }, ack: (response: RoomAck) => void) => void;
}

/** Manejadores que un consumidor entrega para escuchar el canal. */
export interface ExecutionEventHandlers {
  onFlowPaused?: (event: FlowPausedEvent) => void;
  onFlowResumed?: (event: FlowResumedEvent) => void;
  onFlowDiscarded?: (event: FlowDiscardedEvent) => void;
  onFlowCompleted?: (event: FlowCompletedEvent) => void;
  onNodeError?: (event: NodeErrorEvent) => void;
  onNodeStarted?: (event: NodeStartedEvent) => void;
  onNodeCompleted?: (event: NodeCompletedEvent) => void;
}
