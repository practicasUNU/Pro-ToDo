import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as fsmExecutionsService from '@services/fsm-executions.service';
import { joinFlowRoom, leaveFlowRoom } from '@services/socket-events.service';

import { ExecutionState } from '@/types/execution';

import type {
  ExecutionDetail,
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
  const joinedFlowId = ref<string | null>(null);
  const isLoading = ref(false);
  const isResuming = ref(false);

  const activeCursor = computed<string | null>(
    () => activeExecution.value?.activeCursor ?? null,
  );

  const currentState = computed<ExecutionState | null>(
    () => activeExecution.value?.state ?? null,
  );

  const isPaused = computed<boolean>(
    () => currentState.value === ExecutionState.PAUSADO,
  );

  const isRunning = computed<boolean>(
    () => currentState.value === ExecutionState.EN_PROCESO,
  );

  /** Traza mas reciente; `nodeEvents` se mantiene en orden descendente. */
  const lastNodeError = computed<NodeErrorEvent | null>(
    () => nodeEvents.value[0] ?? null,
  );

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
  ): void => {
    executions.value = executions.value.map((execution) =>
      execution.executionId === executionId
        ? { ...execution, ...patch }
        : execution,
    );

    if (belongsToActive(executionId) && activeExecution.value !== null) {
      activeExecution.value = { ...activeExecution.value, ...patch };
    }
  };

  /** El motor detuvo la ejecucion: queda reanudable (CU-09). */
  const handleFlowPaused = (event: FlowPausedEvent): void => {
    patchSummary(event.executionId, {
      state: ExecutionState.PAUSADO,
      activeCursor: event.activeCursor,
      ...(event.errorMessage !== undefined
        ? { failureReason: event.errorMessage }
        : {}),
      // Solo si el evento trae ruta: un `null` incondicional borraria una ruta
      // anterior perfectamente valida, que es la misma precaucion que toma
      // `pauseAt` en el backend.
      ...(event.logFilePath !== undefined && event.logFilePath !== null
        ? { logFilePath: event.logFilePath }
        : {}),
    });
  };

  /** Alguien relanzo la ejecucion sobre la misma fila. */
  const handleFlowResumed = (event: FlowResumedEvent): void => {
    patchSummary(event.executionId, {
      state: ExecutionState.EN_PROCESO,
      activeCursor: event.activeCursor,
      // El motivo del fallo anterior deja de ser cierto en cuanto se reintenta;
      // el backend tambien lo limpia en `prepareResume`.
      failureReason: null,
    });
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
  const fetchExecutions = async (
    query: ExecutionListQuery = {},
  ): Promise<void> => {
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
      activeExecution.value =
        await fsmExecutionsService.fetchExecution(executionId);
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
  const resumeExecution = async (
    executionId: string,
  ): Promise<WorkflowExecutionResult> => {
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

  /** Deja constancia de la sala ocupada, para poder abandonarla despues. */
  const setJoinedFlow = (flowId: string | null): void => {
    joinedFlowId.value = flowId;
  };

  /**
   * Entra en la sala de un flujo, abandonando la anterior. Idempotente.
   *
   * El store importa aqui un servicio de SOCKET, no el transporte HTTP: la
   * prohibicion de `frontend-architecture.md` §2.1 apunta a Axios y a `@boot`,
   * y `socket-events.service` es una capa de servicio del proyecto igual que
   * `fsm-executions.service`. Los nombres de evento siguen sin aparecer aqui.
   *
   * `joinedFlowId` se fija SOLO con acuse afirmativo: el gateway rechaza un
   * UUID mal formado y el tope `MAX_ROOMS_PER_SOCKET` devolviendo
   * `{ ok: false }`, y apuntar una sala en la que no se esta haria que la
   * re-suscripcion tras reconectar insistiera en un destino inexistente.
   */
  const joinFlow = async (flowId: string): Promise<RoomAck> => {
    if (joinedFlowId.value === flowId) {
      return { ok: true };
    }

    if (joinedFlowId.value !== null) {
      await leaveFlowRoom(joinedFlowId.value);
      joinedFlowId.value = null;
    }

    const ack = await joinFlowRoom(flowId);

    if (ack.ok) {
      joinedFlowId.value = flowId;
    }

    return ack;
  };

  /** Abandona la sala actual, si habia alguna. Idempotente. */
  const leaveFlow = async (): Promise<void> => {
    if (joinedFlowId.value === null) {
      return;
    }

    await leaveFlowRoom(joinedFlowId.value);
    joinedFlowId.value = null;
  };

  return {
    executions,
    activeExecution,
    nodeEvents,
    joinedFlowId,
    isLoading,
    isResuming,
    activeCursor,
    currentState,
    isPaused,
    isRunning,
    lastNodeError,
    handleFlowPaused,
    handleFlowResumed,
    handleNodeError,
    fetchExecutions,
    fetchExecution,
    resumeExecution,
    setJoinedFlow,
    joinFlow,
    leaveFlow,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useExecutionStore, import.meta.hot));
}
