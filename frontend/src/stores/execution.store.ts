import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as fsmExecutionsService from '@services/fsm-executions.service';
import { joinFlowRoom, leaveFlowRoom } from '@services/socket-events.service';

import { ExecutionState } from '@/types/execution';

import type {
  DiscardExecutionResult,
  ExecutionDetail,
  FlowCompletedEvent,
  FlowDiscardedEvent,
  ExecutionListQuery,
  ExecutionSummary,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
  RoomAck,
  WorkflowExecutionResult,
} from '@/types/execution';

/**
 * Trazas de nodo retenidas en memoria.
 *
 * Un flujo con reintentos puede emitir decenas de eventos por minuto, y esta
 * lista alimenta una vista: sin techo, una pestana abierta toda la jornada
 * acumula hasta quedarse sin memoria. Doscientas cubren de sobra lo que cabe en
 * pantalla y lo que alguien va a desplazar hacia atras.
 */
const MAX_NODE_EVENTS = 200;

/**
 * Estado reactivo de las ejecuciones del motor FSM.
 *
 * NO conoce Socket.io. Expone manejadores (`handleFlowPaused`, ...) que alguien
 * de fuera engancha al canal —hoy `useExecutionSocket`—, y esa frontera es
 * deliberada: mantiene el store en la capa de logica de negocio
 * (`frontend-architecture.md` §2.1), evita que importe el transporte, y permite
 * probarlo entero sin levantar un socket.
 */
export const useExecutionStore = defineStore('execution', () => {
  const executions = ref<ExecutionSummary[]>([]);
  const activeExecution = ref<ExecutionDetail | ExecutionSummary | null>(null);
  const nodeEvents = ref<NodeErrorEvent[]>([]);
  const joinedFlowIds = ref<Set<string>>(new Set());
  const isLoading = ref(false);
  const isResuming = ref(false);
  const isDiscarding = ref(false);

  const activeCursor = computed<string | null>(() => activeExecution.value?.activeCursor ?? null);

  const currentState = computed<ExecutionState | null>(() => activeExecution.value?.state ?? null);

  const isPaused = computed<boolean>(() => currentState.value === ExecutionState.PAUSADO);

  const isRunning = computed<boolean>(() => currentState.value === ExecutionState.EN_PROCESO);

  /**
   * Ultima ejecucion conocida de cada flujo, indexada por `flowId`.
   *
   * Lo consume la tabla de flujos para pintar el estado de cada fila. Se deriva
   * una sola vez por cambio en lugar de que cada celda recorra `executions`,
   * que convertiria el pintado en cuadratico sobre el catalogo.
   *
   * "Ultima" se decide por `startedAt`: un flujo puede acumular ejecuciones y
   * la fila debe reflejar la vigente, no la primera que devolvio la API.
   */
  const executionByFlowId = computed<Map<string, ExecutionSummary>>(() => {
    const index = new Map<string, ExecutionSummary>();

    for (const execution of executions.value) {
      const current = index.get(execution.flowId);

      if (current === undefined || execution.startedAt >= current.startedAt) {
        index.set(execution.flowId, execution);
      }
    }

    return index;
  });

  /** Traza mas reciente; `nodeEvents` se mantiene en orden descendente. */
  const lastNodeError = computed<NodeErrorEvent | null>(() => nodeEvents.value[0] ?? null);

  /**
   * ¿El evento habla de la ejecucion que el usuario tiene abierta?
   *
   * Un socket puede estar en varias salas a la vez, de modo que aqui llegan
   * eventos de flujos que no se estan mirando. Mezclar las trazas de dos
   * ejecuciones en la misma lista es peor que no mostrar ninguna: el operador
   * leeria como propios unos fallos que no lo son.
   */
  const belongsToActive = (executionId: string): boolean =>
    activeExecution.value?.executionId === executionId;

  /**
   * Sustituye la fila del listado por una version parcheada.
   *
   * Reemplaza el objeto entero (`{ ...previo, ...parche }`) en vez de asignar
   * sobre el existente: el payload que llega del backend se trata como
   * inmutable (`frontend-quasar.md` §3), y mutarlo en sitio impide ademas que
   * Vue detecte el cambio en una lista reemplazada por referencia.
   */
  const patchSummary = (
    executionId: string,
    patch: Partial<ExecutionSummary>,
    seed?: Pick<ExecutionSummary, 'flowId' | 'startedAt'>,
  ): void => {
    const isKnown = executions.value.some((execution) => execution.executionId === executionId);

    if (isKnown) {
      executions.value = executions.value.map((execution) =>
        execution.executionId === executionId ? { ...execution, ...patch } : execution,
      );
    } else if (seed !== undefined) {
      // La tabla de flujos sigue salas de flujos que quiza nunca listaron una
      // ejecucion: sin esta rama, el primer `flow:paused` de una ejecucion
      // recien nacida no pintaria nada y la fila quedaria mintiendo.
      executions.value = [
        ...executions.value,
        {
          executionId,
          flowId: seed.flowId,
          state: ExecutionState.EN_PROCESO,
          activeCursor: null,
          logFilePath: null,
          failureReason: null,
          startedAt: seed.startedAt,
          updatedAt: seed.startedAt,
          ...patch,
        },
      ];
    }

    if (belongsToActive(executionId) && activeExecution.value !== null) {
      activeExecution.value = { ...activeExecution.value, ...patch };
    }
  };

  /** El motor detuvo la ejecucion: queda reanudable (CU-09). */
  const handleFlowPaused = (event: FlowPausedEvent): void => {
    patchSummary(
      event.executionId,
      {
        state: ExecutionState.PAUSADO,
        activeCursor: event.activeCursor,
        ...(event.errorMessage !== undefined ? { failureReason: event.errorMessage } : {}),
        // Solo si el evento trae ruta: un `null` incondicional borraria una
        // ruta anterior perfectamente valida, que es la misma precaucion que
        // toma `pauseAt` en el backend.
        ...(event.logFilePath !== undefined && event.logFilePath !== null
          ? { logFilePath: event.logFilePath }
          : {}),
      },
      { flowId: event.flowId, startedAt: event.emittedAt },
    );
  };

  /** Alguien relanzo la ejecucion sobre la misma fila. */
  const handleFlowResumed = (event: FlowResumedEvent): void => {
    patchSummary(
      event.executionId,
      {
        state: ExecutionState.EN_PROCESO,
        activeCursor: event.activeCursor,
        // El motivo del fallo anterior deja de ser cierto en cuanto se
        // reintenta; el backend tambien lo limpia en `prepareResume`.
        failureReason: null,
      },
      { flowId: event.flowId, startedAt: event.emittedAt },
    );
  };

  /**
   * Un operador renuncio a reanudarla: la ejecucion queda cerrada.
   *
   * El cursor se anula porque la fila lo perdio: `DESCARTADO` es terminal y
   * conservarlo ofreceria un reintento imposible. Quien quiera saber donde se
   * detuvo lo lee del evento (`lastCursor`), no de la fila.
   */
  const handleFlowDiscarded = (event: FlowDiscardedEvent): void => {
    patchSummary(
      event.executionId,
      { state: ExecutionState.DESCARTADO, activeCursor: null },
      { flowId: event.flowId, startedAt: event.emittedAt },
    );
  };

  /**
   * La ejecucion alcanzo un estado terminal sin cursor.
   *
   * El estado llega en el evento y no se deduce aqui: EXITOSO, OMITIDO y
   * FALLIDO comparten evento a proposito, y reconstruirlo en el cliente seria
   * una segunda fuente de verdad sobre lo que ya decidio el motor.
   */
  const handleFlowCompleted = (event: FlowCompletedEvent): void => {
    patchSummary(
      event.executionId,
      {
        state: event.finalState,
        activeCursor: null,
        ...(event.failureReason !== undefined ? { failureReason: event.failureReason } : {}),
      },
      { flowId: event.flowId, startedAt: event.emittedAt },
    );
  };

  /**
   * Un nodo termino sin exito. NO implica que el flujo se haya detenido: un
   * LEVE con reintentos emite esto y sigue adelante.
   */
  const handleNodeError = (event: NodeErrorEvent): void => {
    if (!belongsToActive(event.executionId)) {
      return;
    }

    nodeEvents.value = [event, ...nodeEvents.value].slice(0, MAX_NODE_EVENTS);
  };

  /** Pagina de ejecuciones. Sin contexto acumulado: eso lo trae el detalle. */
  const fetchExecutions = async (query: ExecutionListQuery = {}): Promise<void> => {
    isLoading.value = true;

    try {
      const page = await fsmExecutionsService.fetchExecutions(query);
      executions.value = page.items;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Abre una ejecucion concreta.
   *
   * Vacia `nodeEvents` porque la lista pertenece a la ejecucion activa:
   * conservarla al cambiar de ejecucion mostraria las trazas de la anterior
   * bajo la cabecera de la nueva.
   */
  const fetchExecution = async (executionId: string): Promise<void> => {
    isLoading.value = true;

    try {
      activeExecution.value = await fsmExecutionsService.fetchExecution(executionId);
      nodeEvents.value = [];
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Reintento manual (CU-09). Reutiliza la misma fila.
   *
   * La excepcion se propaga: el 409 (ya no esta PAUSADO), el 400 (su nodo
   * desaparecio del esquema) y el 429 (motor saturado) necesitan mensajes
   * distintos, y quien los decide es el componente.
   */
  const resumeExecution = async (executionId: string): Promise<WorkflowExecutionResult> => {
    isResuming.value = true;

    try {
      const result = await fsmExecutionsService.resumeExecution(executionId);

      patchSummary(executionId, {
        state: result.status,
        activeCursor: result.activeCursor,
        failureReason: null,
      });

      return result;
    } finally {
      isResuming.value = false;
    }
  };

  /**
   * Cierre manual de una ejecucion detenida (CU-09).
   *
   * La excepcion se propaga igual que en `resumeExecution`: el 409 de «ya no
   * esta PAUSADO» necesita un mensaje propio, y quien lo decide es el
   * componente.
   *
   * Solo se parchea la EJECUCION. El flujo que el backend acaba de desactivar
   * viaja en la misma respuesta, pero su fila pertenece a `workflows.store`, y
   * repintarla desde aqui crearia un segundo dueno de ese estado: ya lo hace
   * la mutacion `crud:mutation` que el backend difunde.
   */
  const discardExecution = async (executionId: string): Promise<DiscardExecutionResult> => {
    isDiscarding.value = true;

    try {
      const result = await fsmExecutionsService.discardExecution(executionId);

      patchSummary(executionId, {
        state: result.execution.state,
        activeCursor: result.execution.activeCursor,
        failureReason: result.execution.failureReason,
      });

      return result;
    } finally {
      isDiscarding.value = false;
    }
  };

  /** Deja constancia de las salas ocupadas, para poder abandonarlas despues. */
  const setJoinedFlows = (flowIds: readonly string[]): void => {
    joinedFlowIds.value = new Set(flowIds);
  };

  /**
   * Entra en la sala de un flujo. Idempotente y acumulativa.
   *
   * El store importa aqui un servicio de SOCKET, no el transporte HTTP: la
   * prohibicion de `frontend-architecture.md` §2.1 apunta a Axios y a `@boot`,
   * y `socket-events.service` es una capa de servicio del proyecto igual que
   * `fsm-executions.service`. Los nombres de evento siguen sin aparecer aqui.
   *
   * Se sostienen VARIAS salas a la vez porque la tabla de flujos sigue a todas
   * sus filas en paralelo; el tope real lo pone `MAX_ROOMS_PER_SOCKET` en el
   * gateway, que responde `{ ok: false }` al rebasarlo.
   *
   * El identificador se apunta SOLO con acuse afirmativo: el gateway rechaza un
   * UUID mal formado, un flujo inexistente y el exceso de salas, y apuntar una
   * sala en la que no se esta haria que la re-suscripcion tras reconectar
   * insistiera en un destino inexistente.
   */
  const joinFlow = async (flowId: string): Promise<RoomAck> => {
    if (joinedFlowIds.value.has(flowId)) {
      return { ok: true };
    }

    const ack = await joinFlowRoom(flowId);

    if (ack.ok) {
      // Se reemplaza el Set entero: mutarlo en sitio no dispara la reactividad
      // de Vue sobre un `ref` que envuelve una coleccion nativa.
      joinedFlowIds.value = new Set(joinedFlowIds.value).add(flowId);
    }

    return ack;
  };

  /** Abandona la sala de un flujo, si se estaba en ella. Idempotente. */
  const leaveFlow = async (flowId: string): Promise<void> => {
    if (!joinedFlowIds.value.has(flowId)) {
      return;
    }

    await leaveFlowRoom(flowId);

    const remaining = new Set(joinedFlowIds.value);
    remaining.delete(flowId);
    joinedFlowIds.value = remaining;
  };

  /** Abandona todas las salas ocupadas. Pensado para `onBeforeUnmount`. */
  const leaveAllFlows = async (): Promise<void> => {
    const occupied = [...joinedFlowIds.value];

    joinedFlowIds.value = new Set();

    await Promise.all(occupied.map((flowId) => leaveFlowRoom(flowId)));
  };

  return {
    executions,
    activeExecution,
    nodeEvents,
    joinedFlowIds,
    isLoading,
    isResuming,
    isDiscarding,
    activeCursor,
    currentState,
    isPaused,
    isRunning,
    lastNodeError,
    handleFlowPaused,
    handleFlowResumed,
    handleFlowDiscarded,
    handleFlowCompleted,
    handleNodeError,
    fetchExecutions,
    fetchExecution,
    resumeExecution,
    discardExecution,
    executionByFlowId,
    setJoinedFlows,
    joinFlow,
    leaveFlow,
    leaveAllFlows,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useExecutionStore, import.meta.hot));
}
