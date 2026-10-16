import { computed, ref } from 'vue';
import { acceptHMRUpdate, defineStore } from 'pinia';

import { fetchActiveExecution } from '@services/fsm-executions.service';
import { fetchWorkflow } from '@services/workflows.service';
import { useExecutionStore } from '@stores/execution.store';
import { ExecutionState } from '@/types/execution';
import { errorRouteTarget } from '@/utils/pipeline-assembler';

import type {
  ExecutionDetail,
  FlowCompletedEvent,
  FlowPausedEvent,
  NodeCompletedEvent,
  NodeStartedEvent,
} from '@/types/execution';
import type { AssembledPipelineNode, WorkflowDetail } from '@/types/pipeline';

/**
 * Como se pinta cada caja del canvas.
 *
 * NO replica `ExecutionState`: aquel describe la EJECUCION entera y este un
 * nodo suelto. Un flujo `EN_PROCESO` tiene un nodo corriendo y el resto en
 * espera, de modo que reutilizar el enum obligaria a inventar significados
 * para `OMITIDO` o `DESCARTADO` a nivel de caja.
 */
export type CanvasNodeStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'PAUSED' | 'FAILED';

/**
 * Por que una bifurcacion NO pinta tarjeta propia.
 *
 * - `card`: su destino se dibuja aqui, en el carril de contingencia.
 * - `rejoin`: apunta a un nodo del camino nominal, que ya tiene tarjeta arriba.
 * - `duplicate`: otro nodo ya coloco ese mismo destino (el alertador es uno por
 *   flujo, y dos pasos pueden desviar hacia el).
 * - `missing`: el puntero apunta a un `nodeId` que no existe en el esquema.
 */
export type CanvasForkPlacement = 'card' | 'rejoin' | 'duplicate' | 'missing';

/** Arista del camino nominal, de un paso al siguiente. */
export interface CanvasEdge {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly isTraversed: boolean;
}

/** Ruta de contingencia ya colocada en una columna del carril. */
export interface CanvasForkSlot {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  /**
   * Codigos que la ruta atrapa.
   *
   * `null` es la forma de cadena, que atrapa CUALQUIER fallo. Un arreglo vacio
   * es una ruta que no se dispara jamas: el backend la guarda sin protestar, y
   * el canvas es el unico sitio donde el operador puede verla.
   */
  readonly catchErrors: readonly string[] | null;
  /** Indice en `orderedSteps` del nodo que DECLARA la ruta: su columna. */
  readonly column: number;
  /** 0 cuelga de la tarjeta nominal; 1 de la tarjeta de contingencia de arriba. */
  readonly depth: number;
  readonly placement: CanvasForkPlacement;
  /** `null` solo cuando `placement` es `missing`. */
  readonly target: AssembledPipelineNode | null;
  /** Todos los nodos que desvian aqui. Solo se rellena en `placement: card`. */
  readonly sourceNodeIds: readonly string[];
  /** El satelite devuelve el flujo al camino nominal, y por que paso. */
  readonly rejoin: { readonly nodeId: string; readonly column: number } | null;
  readonly isTraversed: boolean;
}

/** Tope de anidamiento del carril: `parser -> ocr_ia -> alerta_smtp` y basta. */
const MAX_FORK_DEPTH = 3;

/**
 * Supervision visual de un flujo concreto: SOLO el estado de la vista.
 *
 * Deliberadamente NO posee la ejecucion, ni el cursor, ni el ultimo error: todo
 * eso ya vive en `useExecutionStore`, que es quien escucha el canal y quien
 * ejecuta CU-09. Duplicarlo aqui crearia dos fuentes de verdad que divergen en
 * cuanto una pausa llegue mientras el canvas esta cerrado — el mismo motivo por
 * el que `useFlujoDraftStore` no guarda la configuracion de cada nodo.
 *
 * Lo que si es suyo: el flujo cargado, su topologia proyectada y el mapa de
 * estados por caja, que no significan nada fuera de esta pantalla.
 */
export const useCanvasStore = defineStore('canvas', () => {
  const executionStore = useExecutionStore();

  const workflow = ref<WorkflowDetail | null>(null);
  const nodeStatuses = ref<Map<string, CanvasNodeStatus>>(new Map());
  const selectedNodeId = ref<string | null>(null);
  const isLoading = ref(false);

  /**
   * Ejecucion que el canvas esta observando, cargada por REST.
   *
   * Se guarda aparte de `executionStore.activeExecution` porque aquella sigue
   * al ULTIMO evento recibido, sea del flujo que sea: la tabla de `/flujos`
   * escucha todas las salas a la vez. El canvas necesita la de SU flujo.
   */
  const observedExecution = ref<ExecutionDetail | null>(null);

  /**
   * Nodos en orden de ejecucion, siguiendo `nextStep` desde el `entrypoint`.
   *
   * Replica `buildOrderedTopology` del backend, incluido el `Set` anticiclos:
   * el orden NO puede salir de `Object.values(nodes)`, que es el de escritura
   * del JSON y no el del camino. Un puntero huerfano corta el recorrido y
   * devuelve lo acumulado, para que un esquema roto siga siendo visible.
   */
  const orderedSteps = computed<AssembledPipelineNode[]>(() => {
    const schema = workflow.value?.pipelineSchema;

    if (schema == null) {
      return [];
    }

    const steps: AssembledPipelineNode[] = [];
    const visited = new Set<string>();
    let cursor: string | null = schema.entrypoint;

    while (cursor !== null && !visited.has(cursor)) {
      const node: AssembledPipelineNode | undefined = schema.nodes[cursor];

      if (node === undefined) {
        break;
      }

      visited.add(cursor);
      steps.push(node);
      cursor = node.nextStep;
    }

    return steps;
  });

  /**
   * Nodos de contingencia: existen en el esquema pero no en el camino nominal.
   *
   * Son los destinos de un `onErrorStep` que nadie encadena con `nextStep`, y
   * el canvas los dibuja como derivacion lateral. Sin esto desaparecerian de la
   * vista pese a poder ser justo el nodo que esta corriendo tras un fallo.
   */
  const contingencySteps = computed<AssembledPipelineNode[]>(() => {
    const schema = workflow.value?.pipelineSchema;

    if (schema == null) {
      return [];
    }

    const nominal = new Set(orderedSteps.value.map((step) => step.nodeId));

    return Object.values(schema.nodes).filter((node) => !nominal.has(node.nodeId));
  });

  /**
   * Aristas del camino nominal, una por transicion.
   *
   * Un tramo cuenta como recorrido mirando su ORIGEN: la flecha describe una
   * transicion que ya ocurrio en cuanto el nodo de la izquierda termino, aunque
   * el de la derecha todavia no haya arrancado.
   */
  const nominalEdges = computed<CanvasEdge[]>(() =>
    orderedSteps.value.slice(0, -1).map((step, index) => ({
      fromNodeId: step.nodeId,
      toNodeId: orderedSteps.value[index + 1]?.nodeId ?? '',
      isTraversed: statusOf(step.nodeId) === 'COMPLETED',
    })),
  );

  /**
   * Rutas de contingencia ya colocadas en la columna de quien las declara.
   *
   * Recorre el camino nominal y, por cada `onErrorStep`, decide si su destino
   * merece tarjeta propia o basta una referencia. Despues repite sobre el
   * `onErrorStep` de la tarjeta recien colocada, que es el caso real del
   * satelite de vision: `parser -> ocr_ia -> alerta_smtp`.
   *
   * Un `Set` de colocados garantiza UNA tarjeta por `nodeId` en todo el lienzo
   * y corta de paso cualquier ciclo entre rutas de error.
   */
  const forkSlots = computed<CanvasForkSlot[]>(() => {
    const schema = workflow.value?.pipelineSchema;

    if (schema == null) {
      return [];
    }

    const nominalIndex = new Map(orderedSteps.value.map((step, index) => [step.nodeId, index]));
    const placed = new Set<string>();
    const slots: CanvasForkSlot[] = [];

    /** Nodos del camino nominal que desvian al mismo destino. */
    const declarantsOf = (targetId: string): string[] =>
      orderedSteps.value
        .filter((step) => errorRouteTarget(step.onErrorStep) === targetId)
        .map((step) => step.nodeId);

    const collect = (from: AssembledPipelineNode, column: number, depth: number): void => {
      const toNodeId = errorRouteTarget(from.onErrorStep);

      if (toNodeId === null || depth >= MAX_FORK_DEPTH) {
        return;
      }

      const target = schema.nodes[toNodeId];
      const catchErrors =
        typeof from.onErrorStep === 'object' && from.onErrorStep !== null
          ? from.onErrorStep.catchErrors
          : null;

      const placement: CanvasForkPlacement =
        target === undefined
          ? 'missing'
          : nominalIndex.has(toNodeId)
            ? 'rejoin'
            : placed.has(toNodeId)
              ? 'duplicate'
              : 'card';

      if (placement === 'card') {
        placed.add(toNodeId);
      }

      const rejoinColumn = target?.nextStep == null ? undefined : nominalIndex.get(target.nextStep);

      slots.push({
        fromNodeId: from.nodeId,
        toNodeId,
        catchErrors,
        column,
        depth,
        placement,
        target: target ?? null,
        sourceNodeIds: placement === 'card' ? declarantsOf(toNodeId) : [],
        rejoin:
          placement === 'card' && target?.nextStep != null && rejoinColumn !== undefined
            ? { nodeId: target.nextStep, column: rejoinColumn }
            : null,
        // El origen COMPLETED no sirve aqui: un nodo que termino bien es justo
        // el que NO desvio. La prueba de que la rama se disparo es que su
        // destino se encendio, y al carril solo se llega por la ruta de error.
        isTraversed: placement === 'card' && statusOf(toNodeId) !== 'IDLE',
      });

      if (placement === 'card' && target !== undefined) {
        collect(target, column, depth + 1);
      }
    };

    for (const [column, step] of orderedSteps.value.entries()) {
      collect(step, column, 0);
    }

    return slots;
  });

  /** Indice por columna, para que la plantilla solo haga `.get(i)`. */
  const forkByColumn = computed<Map<number, CanvasForkSlot[]>>(() => {
    const index = new Map<number, CanvasForkSlot[]>();

    for (const slot of forkSlots.value) {
      index.set(slot.column, [...(index.get(slot.column) ?? []), slot]);
    }

    return index;
  });

  /**
   * Nodos del esquema a los que no apunta NADA: ni `nextStep` ni `onErrorStep`.
   *
   * Son un esquema corrupto, y existen en la vista a proposito: al desaparecer
   * el bloque inferior de "Rutas de contingencia" se quedarian invisibles, y un
   * nodo huerfano que nadie ve es un nodo que nadie arregla.
   */
  const unreachableSteps = computed<AssembledPipelineNode[]>(() => {
    const reachable = new Set(forkSlots.value.map((slot) => slot.toNodeId));

    return contingencySteps.value.filter((node) => !reachable.has(node.nodeId));
  });

  /** Paso seleccionado para el panel de inspeccion, o `null`. */
  const selectedStep = computed<AssembledPipelineNode | null>(() => {
    if (selectedNodeId.value === null) {
      return null;
    }

    return workflow.value?.pipelineSchema?.nodes[selectedNodeId.value] ?? null;
  });

  const executionState = computed<ExecutionState | null>(
    () => observedExecution.value?.state ?? null,
  );

  const activeCursor = computed<string | null>(() => observedExecution.value?.activeCursor ?? null);

  const isPaused = computed<boolean>(() => executionState.value === ExecutionState.PAUSADO);

  /** Namespaces ya escritos por los nodos que completaron su trabajo. */
  const executionContext = computed<Record<string, Record<string, unknown>>>(
    () => observedExecution.value?.context ?? {},
  );

  const statusOf = (nodeId: string): CanvasNodeStatus => nodeStatuses.value.get(nodeId) ?? 'IDLE';

  /**
   * Si se puede relanzar la ejecucion detenida desde ESTE nodo (CU-09 extendido).
   *
   * REPLICA EXACTA del criterio que aplica `ExecutionsService.resolveResumeCursor`
   * en el backend, y tiene que serlo: esta funcion decide que tarjetas ensenan
   * el boton, asi que si fuera mas permisiva el operador pulsaria botones que
   * devuelven un 400, y si fuera mas estricta esconderia opciones legitimas.
   *
   * Admite el propio cursor —es donde se detuvo— y cualquier nodo cuyo
   * `outputNamespace` este ya escrito en el contexto, que es la unica prueba de
   * que llego a ejecutarse. Lo que queda fuera son los pasos POSTERIORES:
   * saltar a uno dejaria sin escribir los namespaces intermedios y el flujo
   * reventaria al interpolarlos, con un fallo que el operador leeria como un
   * error del motor y no como la consecuencia de su eleccion.
   *
   * Se pregunta al CONTEXTO y no al indice en la topologia porque esta ultima
   * deja fuera a los satelites de contingencia, que es justo donde reanudar a
   * mano resulta mas util: si el rescate por OCR corrio, se puede volver a el.
   */
  const isResumableFrom = (nodeId: string): boolean => {
    if (!isPaused.value) return false;

    if (nodeId === activeCursor.value) return true;

    const node = workflow.value?.pipelineSchema?.nodes[nodeId];

    return (
      node !== undefined &&
      Object.hasOwn(executionContext.value, node.outputNamespace)
    );
  };

  /**
   * Reescribe el mapa entero en vez de mutarlo entrada a entrada.
   *
   * Un `Map` reactivo de Vue notifica a sus consumidores al mutarlo, pero
   * reemplazarlo deja ademas un valor inmutable por fotograma, que es lo que
   * evita que una transicion CSS arranque a medio repintado.
   */
  const patchStatus = (nodeId: string, status: CanvasNodeStatus): void => {
    const next = new Map(nodeStatuses.value);
    next.set(nodeId, status);
    nodeStatuses.value = next;
  };

  /**
   * Siembra el estado inicial de las cajas a partir del checkpoint.
   *
   * Sin ejecucion viva todo queda en `IDLE`. Con ella, un nodo cuenta como
   * completado si dejo su `outputNamespace` en el contexto —que es la unica
   * prueba de que corrio—, y el cursor hereda el estado de la ejecucion.
   */
  const seedStatuses = (execution: ExecutionDetail | null): void => {
    const seeded = new Map<string, CanvasNodeStatus>();

    if (execution !== null) {
      for (const step of orderedSteps.value) {
        if (execution.context[step.outputNamespace] !== undefined) {
          seeded.set(step.nodeId, 'COMPLETED');
        }
      }

      if (execution.activeCursor !== null) {
        seeded.set(
          execution.activeCursor,
          execution.state === ExecutionState.EN_PROCESO ? 'RUNNING' : 'PAUSED',
        );
      }
    }

    nodeStatuses.value = seeded;
  };

  /** Carga el flujo y su ejecucion viva, y deja el canvas listo para pintar. */
  const loadCanvas = async (flowId: string): Promise<void> => {
    isLoading.value = true;

    try {
      workflow.value = await fetchWorkflow(flowId);
      observedExecution.value = await fetchActiveExecution(flowId);
      seedStatuses(observedExecution.value);
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Descarta lo que no sea del flujo que el canvas esta mirando.
   *
   * La suscripcion a eventos es unica y global (`useExecutionSocket`), y la
   * tabla de flujos mantiene abiertas las salas de TODOS los flujos: sin esta
   * guarda, la ejecucion de un flujo ajeno encenderia cajas de este.
   */
  const belongsToCanvas = (flowId: string): boolean => workflow.value?.id === flowId;

  const handleNodeStarted = (event: NodeStartedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    patchStatus(event.nodeId, 'RUNNING');
  };

  const handleNodeCompleted = (event: NodeCompletedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    patchStatus(event.nodeId, 'COMPLETED');
  };

  /**
   * Congela el canvas en el nodo que provoco la pausa.
   *
   * `flow:paused` es TAMBIEN el cierre del nodo en vuelo: el motor no emite un
   * `node:aborted`, de modo que sin esto la caja se quedaria girando su spinner
   * para siempre. Lo mismo vale para el circuit breaker, que pausa sin que
   * ningun nodo haya fallado.
   */
  const handleFlowPaused = (event: FlowPausedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    patchStatus(event.activeCursor, 'PAUSED');
  };

  /**
   * Apaga el nodo en vuelo al cerrarse la ejecucion.
   *
   * Un desenlace `EXITOSO` da por completadas las cajas que seguian corriendo;
   * cualquier otro —`FALLIDO`, `OMITIDO`, `DESCARTADO`— las deja marcadas como
   * fallidas, porque el trabajo no llego a su fin.
   */
  const handleFlowCompleted = (event: FlowCompletedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    const resolved: CanvasNodeStatus =
      event.finalState === ExecutionState.EXITOSO ? 'COMPLETED' : 'FAILED';
    const next = new Map(nodeStatuses.value);

    for (const [nodeId, status] of next) {
      if (status === 'RUNNING') {
        next.set(nodeId, resolved);
      }
    }

    nodeStatuses.value = next;
  };

  const selectNode = (nodeId: string): void => {
    selectedNodeId.value = nodeId;
  };

  const clearSelection = (): void => {
    selectedNodeId.value = null;
  };

  /**
   * Entra en la sala del flujo delegando en el store de ejecucion.
   *
   * El canvas NO habla con Socket.io: la pertenencia a salas la lleva
   * `useExecutionStore`, que es quien sabe cuales estan ya ocupadas y quien las
   * reengancha tras una reconexion.
   */
  const observeFlow = async (flowId: string): Promise<void> => {
    await executionStore.joinFlow(flowId);
  };

  /** Abandona la sala y deja el canvas vacio. Se invoca al desmontar la vista. */
  const stopObserving = async (flowId: string): Promise<void> => {
    await executionStore.leaveFlow(flowId);

    workflow.value = null;
    observedExecution.value = null;
    nodeStatuses.value = new Map();
    selectedNodeId.value = null;
  };

  return {
    workflow,
    observedExecution,
    nodeStatuses,
    selectedNodeId,
    isLoading,
    orderedSteps,
    contingencySteps,
    nominalEdges,
    forkSlots,
    forkByColumn,
    unreachableSteps,
    selectedStep,
    executionState,
    activeCursor,
    isPaused,
    executionContext,
    statusOf,
    isResumableFrom,
    loadCanvas,
    handleNodeStarted,
    handleNodeCompleted,
    handleFlowPaused,
    handleFlowCompleted,
    selectNode,
    clearSelection,
    observeFlow,
    stopObserving,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCanvasStore, import.meta.hot));
}
