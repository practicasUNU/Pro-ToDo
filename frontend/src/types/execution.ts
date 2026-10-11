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
 * Son SEIS. `OMITIDO` es el que se olvida: no es un fallo —el buzon no traia
 * correos nuevos, o el asunto no casaba con el filtro— pero tampoco un exito,
 * y pintarlo como tal haria que cualquier recuento midiese sobre todo buzones
 * vacios.
 */
export enum ExecutionState {
  INACTIVO = 'INACTIVO',
  EN_PROCESO = 'EN_PROCESO',
  PAUSADO = 'PAUSADO',
  EXITOSO = 'EXITOSO',
  OMITIDO = 'OMITIDO',
  FALLIDO = 'FALLIDO',
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

// --- Canal WebSocket (`backend/src/common/types/execution-events.types.ts`) ---

/** Nombres de evento, identicos a los del backend. */
export const EXECUTION_EVENT = {
  FLOW_PAUSED: 'flow:paused',
  FLOW_RESUMED: 'flow:resumed',
  NODE_ERROR: 'node:error',
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
}

export interface FlowResumedEvent extends ExecutionEventBase {
  readonly activeCursor: string;
  readonly resumedBy: string;
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
  'node:error': (event: NodeErrorEvent) => void;
}

export interface ClientToServerEvents {
  'flow:subscribe': (
    payload: { flowId: string },
    ack: (response: RoomAck) => void,
  ) => void;
  'flow:unsubscribe': (
    payload: { flowId: string },
    ack: (response: RoomAck) => void,
  ) => void;
}

/** Manejadores que un consumidor entrega para escuchar el canal. */
export interface ExecutionEventHandlers {
  onFlowPaused?: (event: FlowPausedEvent) => void;
  onFlowResumed?: (event: FlowResumedEvent) => void;
  onNodeError?: (event: NodeErrorEvent) => void;
}
