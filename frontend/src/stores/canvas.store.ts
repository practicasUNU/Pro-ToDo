import { computed, ref } from 'vue';
import { acceptHMRUpdate, defineStore } from 'pinia';

import { fetchActiveExecution, fetchExecution } from '@services/fsm-executions.service';
import { fetchWorkflow } from '@services/workflows.service';
import { useExecutionStore } from '@stores/execution.store';
import { ExecutionState } from '@/types/execution';
import { ERROR_CONTEXT_NAMESPACE } from '@/types/pipeline';
import { errorRouteTarget } from '@/utils/pipeline-assembler';

import type {
  ExecutionDetail,
  ExecutionEventBase,
  FlowCompletedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeCompletedEvent,
  NodeErrorEvent,
  NodeStartedEvent,
} from '@/types/execution';
import type { CrudAction } from '@/types/crud-events';
import type { AssembledPipelineNode, PipelineSummary, WorkflowDetail } from '@/types/pipeline';

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
   * Todos los nodos del esquema: camino nominal mas satelites.
   *
   * Lo que el PINTADO necesita, frente a `orderedSteps`, que es lo que necesita
   * el ORDEN. Un satelite no tiene posicion en la topologia —a el solo se llega
   * por `onErrorStep`— pero si tiene namespace, y el namespace es lo unico que
   * prueba que un nodo corrio.
   *
   * El nominal va primero para que, ante un `nodeId` repetido, mande el mismo
   * orden que ya aplica el resto del store.
   */
  const allSteps = computed<AssembledPipelineNode[]>(() => [
    ...orderedSteps.value,
    ...contingencySteps.value,
  ]);

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

  /**
   * Columna del camino nominal a la que cuelga cada satelite.
   *
   * Es el INDICE que `resetAfterIndex` decia no tener. No vive en la topologia
   * —`buildOrderedTopology` ignora `onErrorStep`— pero si en el lienzo: un
   * satelite se dibuja en la columna del paso que lo declara, y esa columna lo
   * situa en el tiempo tan bien como un indice nominal. Con ella se puede
   * responder "¿esta esta rama por delante del cursor?", que es lo que hace
   * falta para apagarla al reanudar hacia atras.
   *
   * Se deriva de `forkSlots` en vez de repetir su recorrido, que ya resuelve lo
   * dificil: seguir `onErrorStep`, recursar hasta `MAX_FORK_DEPTH` y cortar
   * ciclos. Solo se leen campos ESTRUCTURALES; los estados de `forkSlots` no se
   * miran, porque este mapa es justo lo que se consulta para calcularlos.
   *
   * Unicamente los `placement === 'card'`: un `rejoin` ya es un nodo nominal
   * con su propio indice, y un `duplicate` apunta a una tarjeta colocada antes.
   */
  const satelliteAnchors = computed<Map<string, number>>(() => {
    const anchors = new Map<string, number>();

    for (const slot of forkSlots.value) {
      if (slot.placement === 'card') {
        anchors.set(slot.toNodeId, slot.column);
      }
    }

    return anchors;
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
   * Si la ejecucion se detuvo por un fallo tecnico y no por decision de un nodo.
   *
   * `error_context` lo siembra el MOTOR justo antes de desviar por `onErrorStep`
   * y describe UN fallo concreto. Su presencia es lo que separa las dos clases
   * de pausa, que se pintan en sitios distintos: la tecnica marca el cursor —el
   * paso que hay que reintentar— y la deliberada marca el nodo de pausa.
   *
   * Se comprueba que ademas tenga contenido: un namespace vacio no prueba nada.
   */
  const hasTechnicalFailure = (execution: ExecutionDetail): boolean => {
    const errorContext = execution.context[ERROR_CONTEXT_NAMESPACE];

    return errorContext !== undefined && Object.keys(errorContext).length > 0;
  };

  /**
   * Nodo donde un `PAUSA_FLOW` detuvo el flujo, segun el contexto acumulado.
   *
   * Se BUSCA la clave en vez de leer `context.pause_context` por su nombre: el
   * `outputNamespace` es propiedad del nodo en el esquema, no de su tipo, asi
   * que un `PAUSA_FLOW` reconfigurado publicaria en otro sitio y la vista
   * dejaria de encontrarlo en silencio. El motor escribe `pausedAtStepId` sea
   * cual sea el namespace, y esa clave es lo que se busca.
   */
  const resolveProgrammedPauseStep = (execution: ExecutionDetail): string | null => {
    for (const namespace of Object.values(execution.context)) {
      const pausedAt = namespace.pausedAtStepId;

      if (typeof pausedAt === 'string' && pausedAt !== '') {
        return pausedAt;
      }
    }

    return null;
  };

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

    return node !== undefined && Object.hasOwn(executionContext.value, node.outputNamespace);
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
   * Adelanta sobre la ejecucion observada lo que acaba de contar un evento.
   *
   * SE REEMPLAZA EL OBJETO, nunca se muta un campo: el payload que viene del
   * backend se trata como inmutable en la interfaz
   * (`architecture-patterns.md` §3), y ademas un reemplazo deja un valor
   * estable por fotograma para los `computed` que cuelgan de el.
   *
   * Existe porque `executionState` —y con el la insignia de la cabecera— se
   * derivaba SOLO de la carga REST: los manejadores de socket pintaban las
   * cajas pero no tocaban el estado global, de modo que un flujo pasaba de
   * «Activo» a «Exitoso» ante los ojos del operador sin que la cabecera se
   * enterase hasta un F5.
   *
   * NO crea la ejecucion si no hay ninguna: es para parches PARCIALES, y
   * completar los huecos con valores de relleno escribiria un checkpoint
   * inventado. De crearla se encarga `ensureObservedExecution`.
   */
  const patchObservedExecution = (patch: Partial<ExecutionDetail>): void => {
    if (observedExecution.value === null) {
      return;
    }

    observedExecution.value = { ...observedExecution.value, ...patch };
  };

  /**
   * Trae el contexto real de la ejecucion que un evento acaba de presentar.
   *
   * Corre EN SEGUNDO PLANO y nadie la espera: lo que el operador necesita ver de
   * inmediato ya lo pinto la semilla sintetica. Esto repone `context` y
   * `retryState`, que no viajan en ningun evento y sin los cuales
   * `isResumableFrom` no puede ofrecer un solo paso al que volver —el boton de
   * reanudacion selectiva quedaria inerte sobre una ejecucion legitimamente
   * pausada—.
   *
   * SE COMPRUEBA AL VOLVER que se sigue observando la misma ejecucion. La
   * respuesta puede llegar despues de que el canvas haya cambiado de flujo o de
   * intento, y fusionarla a ciegas resucitaria el contexto de una ejecucion que
   * ya nadie mira.
   *
   * El fallo se traga a proposito: es un relleno, no el camino critico. Un corte
   * de red aqui deja la vista exactamente como estaba antes de esta mejora, no
   * peor, y el siguiente evento o una recarga la completan.
   */
  const hydrateObservedExecution = async (executionId: string): Promise<void> => {
    try {
      const detail = await fetchExecution(executionId);

      if (observedExecution.value?.executionId !== executionId) {
        return;
      }

      patchObservedExecution({
        context: detail.context,
        retryState: detail.retryState,
        startedAt: detail.startedAt,
        logFilePath: detail.logFilePath,
      });

      // Se resiembra porque el historico acaba de llegar: hasta ahora el mapa
      // solo tenia lo que los eventos habian contado, y los nodos que corrieron
      // ANTES de que el canvas se enganchara no habian dejado rastro alguno.
      nodeStatuses.value = buildStatuses(
        detail.context,
        resolveCutoffNode(observedExecution.value),
      );
    } catch {
      // Sin traza al usuario: no ha perdido nada que tuviera antes.
    }
  };

  /**
   * Garantiza que hay una ejecucion observada antes de aplicar un evento.
   *
   * EL DEFECTO QUE ARREGLA. Las cajas se pintaban igualmente —la guarda de los
   * manejadores es `belongsToCanvas`, que solo mira el flujo—, pero la CABECERA
   * no: `patchObservedExecution` se rendia en cuanto `observedExecution` era
   * `null`, y eso es exactamente lo que ocurre cuando el operador deja el canvas
   * abierto sobre un flujo en espera y el disparador arranca una ejecucion que
   * la carga REST no llego a ver. Resultado: los nodos encendiendose uno tras
   * otro bajo una insignia que seguia diciendo «Activo (En espera de trigger)».
   *
   * La semilla es SINTETICA y deliberadamente incompleta: `context` y
   * `retryState` vacios, porque un evento no los trae y rellenarlos con otra
   * cosa seria inventarlos. `hydrateObservedExecution` los repone enseguida.
   *
   * Tambien cubre el RELEVO de ejecucion: si el evento habla de otra distinta a
   * la observada —el flujo volvio a dispararse mientras la vista seguia
   * abierta—, se sustituye en vez de parchear sobre el intento viejo.
   */
  const ensureObservedExecution = (
    event: ExecutionEventBase,
    state: ExecutionState,
    activeCursor: string | null = null,
  ): void => {
    if (observedExecution.value?.executionId === event.executionId) {
      return;
    }

    observedExecution.value = {
      executionId: event.executionId,
      flowId: event.flowId,
      state,
      activeCursor,
      logFilePath: null,
      failureReason: null,
      startedAt: event.emittedAt,
      updatedAt: event.emittedAt,
      // Sin consulta todavia: el socket no informa de alertas.
      hasAlerts: false,
      context: {},
      retryState: {},
    };

    void hydrateObservedExecution(event.executionId);
  };

  /**
   * Devuelve al estado de espera todo el tramo que queda por delante del corte.
   *
   * EL DEFECTO QUE ARREGLA. `FsmEngineService.prepareResume` purga
   * `error_context` y nada mas: los namespaces de los nodos POSTERIORES
   * sobreviven a una reanudacion selectiva, y la siembra los lee como prueba de
   * que corrieron. Tras reanudar desde `procesador_ia`, un `pausa_flow` del
   * intento anterior seguia pintandose en verde al recargar la pagina,
   * describiendo un trabajo que el flujo va a volver a hacer.
   *
   * El corte NO se incluye: su estado lo decide quien resuelve el corte
   * —`PAUSED` si ahi esta detenida, `RUNNING` si esta corriendo—, y
   * sobreescribirlo aqui borraria justo la marca que el operador busca.
   *
   * ALCANZA TAMBIEN A LOS SATELITES, al contrario de lo que esta funcion hacia
   * antes. El argumento de entonces —"no hay indice con el que compararlo"— era
   * falso: `satelliteAnchors` da la columna nominal de la que cuelga cada rama
   * de error, y con ella la pregunta "¿esta por delante del corte?" tiene
   * respuesta. Sin esto, reanudar desde un paso anterior dejaba el satelite del
   * intento previo en verde, afirmando un trabajo que el flujo va a rehacer —y
   * que quiza no rehaga, porque la rama de error solo se toma si el nodo vuelve
   * a fallar.
   *
   * El ancla se compara con `>=` y no con `>`: la rama cuelga del nodo del
   * corte, que es justamente el que va a VOLVER a ejecutarse, de modo que su
   * desvio todavia no se ha tomado en este intento. El propio nodo del corte si
   * queda excluido, por lo dicho arriba.
   */
  const resetAfterIndex = (statuses: Map<string, CanvasNodeStatus>, cutoffIndex: number): void => {
    for (const step of orderedSteps.value.slice(cutoffIndex + 1)) {
      statuses.set(step.nodeId, 'IDLE');
    }

    for (const [nodeId, column] of satelliteAnchors.value) {
      if (column >= cutoffIndex) {
        statuses.set(nodeId, 'IDLE');
      }
    }
  };

  /**
   * Nodo que marca hasta donde ha llegado de verdad la ejecucion.
   *
   * Tres casos y una prioridad, que es la misma que aplica el pintado:
   *
   * 1. `PAUSADO` con `error_context`: el fallo VIVO manda, y el nodo detenido
   *    es el cursor y nadie mas.
   * 2. `PAUSADO` sin fallo tecnico: la pausa fue DELIBERADA, y el nodo detenido
   *    es el que dejo `pausedAtStepId`. El cursor apunta al paso SIGUIENTE
   *    —reanudar entrando otra vez en la pausa seria un bucle—, asi que no es
   *    el corte y queda por delante de el.
   * 3. `EN_PROCESO`: el corte es el cursor, que es lo que se esta ejecutando.
   *
   * Un estado TERMINAL (`EXITOSO`, `FALLIDO`, `OMITIDO`, `DESCARTADO`) no tiene
   * corte: la ejecucion ya no va a avanzar, y el historico completo es
   * exactamente lo que hay que ensenar.
   */
  const resolveCutoffNode = (
    execution: ExecutionDetail,
  ): { nodeId: string; status: CanvasNodeStatus } | null => {
    if (execution.state === ExecutionState.PAUSADO) {
      if (!hasTechnicalFailure(execution)) {
        const pausedAt = resolveProgrammedPauseStep(execution);

        if (pausedAt !== null) {
          return { nodeId: pausedAt, status: 'PAUSED' };
        }
      }

      return execution.activeCursor === null
        ? null
        : { nodeId: execution.activeCursor, status: 'PAUSED' };
    }

    if (execution.state === ExecutionState.EN_PROCESO) {
      return execution.activeCursor === null
        ? null
        : { nodeId: execution.activeCursor, status: 'RUNNING' };
    }

    return null;
  };

  /**
   * Construye el mapa de estados ENTERO a partir del contexto y del corte.
   *
   * UNICO ALGORITMO DE PINTADO del canvas, y que sea uno solo es el arreglo.
   * Antes habia dos —este, para rehidratar tras un F5, y un parcheo a mano
   * dentro de `handleFlowResumed` para el canvas vivo— y no coincidian: al
   * reanudar HACIA ADELANTE, aquel apagaba el nodo de pausa a `IDLE` mientras
   * este lo pintaba `COMPLETED`, de modo que recargar la pagina cambiaba el
   * dibujo sin que el flujo hubiera cambiado. Con una sola funcion, los dos
   * caminos convergen por construccion y no por disciplina.
   *
   * Tres fases, en este orden, porque cada una corrige a la anterior:
   *
   * 1. HISTORICO: un nodo cuenta como completado si dejo su `outputNamespace`
   *    en el contexto, que es la unica prueba de que corrio. NO se da por
   *    completado todo lo anterior al corte: una ruta `onErrorStep` puede haber
   *    SALTADO pasos intermedios, y pintarlos en verde afirmaria un trabajo que
   *    no ocurrio.
   *    Se recorre TODO el esquema y no solo `orderedSteps`. Aquel sale de
   *    `buildOrderedTopology`, que sigue `nextStep` y nunca `onErrorStep`, de
   *    modo que un satelite como `ocr_ia` no aparecia en esta fase: corria, se
   *    ponia verde por el `node:completed` en vivo y volvia a «En espera» en
   *    cuanto algo repintaba el mapa entero —`handleFlowResumed` lo hace—.
   *    Ademas contradecia a `isResumableFrom`, que SI mira el contexto: el
   *    boton de reanudar aparecia sobre una tarjeta pintada como no ejecutada.
   * 2. CORTE: el nodo donde la ejecucion esta detenida, corriendo o a punto de
   *    reanudarse.
   * 3. PURGA: todo lo que queda por delante del corte vuelve a `IDLE`, pese al
   *    historico. Sin esta fase el contexto de un intento anterior pintaba como
   *    hecho un trabajo que el flujo todavia tiene que rehacer.
   *
   * @param context Namespaces acumulados de la ejecucion.
   * @param cutoff Nodo de corte con el estado que le corresponde, o `null` si
   *        la ejecucion ya no va a avanzar y vale el historico completo.
   */
  const buildStatuses = (
    context: Record<string, Record<string, unknown>>,
    cutoff: { nodeId: string; status: CanvasNodeStatus } | null,
  ): Map<string, CanvasNodeStatus> => {
    const statuses = new Map<string, CanvasNodeStatus>();

    // --- 1. Historico.
    //
    // `Object.hasOwn` y no `!== undefined`, que es lo que usa `isResumableFrom`
    // para la misma pregunta: la clave escrita es la prueba de que el nodo
    // corrio, aunque lo que dejara fuera `undefined`.
    for (const step of allSteps.value) {
      if (Object.hasOwn(context, step.outputNamespace)) {
        statuses.set(step.nodeId, 'COMPLETED');
      }
    }

    if (cutoff === null) {
      return statuses;
    }

    // --- 2. Corte.
    statuses.set(cutoff.nodeId, cutoff.status);

    // --- 3. Purga de lo que queda por delante.
    const cutoffIndex = orderedSteps.value.findIndex((step) => step.nodeId === cutoff.nodeId);

    // Un corte fuera del camino nominal —un satelite de contingencia— no
    // tiene indice con el que purgar. Se marca igual (fase 2) y el resto
    // conserva su historico: no hay un "despues" que definir.
    if (cutoffIndex !== -1) {
      resetAfterIndex(statuses, cutoffIndex);
    }

    return statuses;
  };

  /**
   * Siembra el estado de las cajas a partir del checkpoint cargado por REST.
   *
   * Sin ejecucion viva todo queda en `IDLE`. Con ella, delega en
   * `buildStatuses`, que es el mismo pintor que usa la reanudacion en vivo.
   */
  const seedStatuses = (execution: ExecutionDetail | null): void => {
    nodeStatuses.value =
      execution === null
        ? new Map<string, CanvasNodeStatus>()
        : buildStatuses(execution.context, resolveCutoffNode(execution));
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
   * Vuelve a leer el estado real y repinta, sin velo de carga.
   *
   * SE INVOCA AL RECONECTAR EL SOCKET. Las salas viven en el servidor y mueren
   * con la conexion: el boot vuelve a entrar en ellas, pero los eventos
   * ocurridos DURANTE el corte no se reenvian a nadie. Sin esta lectura, un
   * micro-corte dejaba el canvas congelado en la ultima foto que recibio —nodos
   * en marcha que ya terminaron, una pausa que nadie pinto— hasta que el
   * operador recargaba a mano.
   *
   * NO TOCA `isLoading` a proposito: encender el velo por una reconciliacion de
   * fondo produciria justo el parpadeo que se quiere evitar, y ademas
   * desmontaria el canvas durante la peticion.
   *
   * El caso que obliga a la segunda lectura: `fetchActiveExecution` solo busca
   * estados VIVOS, asi que una ejecucion que termino durante el corte vuelve
   * como «no hay ninguna». Quedarse ahi dejaria las cajas del intento anterior
   * encendidas para siempre; se pide esa ejecucion por su identificador para
   * enterarse de COMO acabo.
   */
  const syncCurrentExecution = async (): Promise<void> => {
    const current = workflow.value;

    if (current === null) {
      return;
    }

    const observedId = observedExecution.value?.executionId ?? null;
    const live = await fetchActiveExecution(current.id);

    if (live === null && observedId !== null) {
      observedExecution.value = await fetchExecution(observedId);
    } else {
      observedExecution.value = live;
    }

    seedStatuses(observedExecution.value);
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

    // ANTES de parchear: si el flujo arranco con la vista ya abierta, la carga
    // REST no vio ninguna ejecucion y el parche de abajo se rendiria.
    ensureObservedExecution(event, ExecutionState.EN_PROCESO, event.nodeId);

    patchStatus(event.nodeId, 'RUNNING');

    // No existe ningun `flow:started` en el canal: el primer `node:started` ES
    // el arranque observable de la ejecucion. Sin esto, la cabecera se quedaba
    // en «Activo (En espera de trigger)» mientras las cajas ya se encendian una
    // tras otra.
    patchObservedExecution({
      state: ExecutionState.EN_PROCESO,
      activeCursor: event.nodeId,
    });
  };

  const handleNodeCompleted = (event: NodeCompletedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    // Por el mismo motivo que en `handleNodeStarted`, y era el unico de los
    // manejadores del canvas que no lo hacia: un `node:completed` que se
    // adelante a la carga REST pintaba la tarjeta verde pero dejaba
    // `observedExecution` en `null`, y con el la cabecera y `isResumableFrom`.
    ensureObservedExecution(event, ExecutionState.EN_PROCESO, event.nodeId);

    patchStatus(event.nodeId, 'COMPLETED');
  };

  /**
   * Pinta en rojo el nodo que acaba de fallar.
   *
   * El canvas NO escuchaba este evento, y era el unico de los siete del canal
   * que no llegaba hasta aqui. La consecuencia es que una tarjeta que fallaba
   * se quedaba girando en «Procesando» —el `RUNNING` que le puso su
   * `node:started`— hasta que apareciera un evento de FLUJO. Con un reintento
   * de por medio eso son decenas de segundos describiendo un trabajo que ya se
   * sabe roto.
   *
   * NO se toca el cursor ni el estado de la ejecucion: un error no decide por
   * si solo como termina el flujo. Puede reintentarse, desviarse por
   * `onErrorStep` o pausar la ejecucion, y de eso informan los eventos que
   * vienen detras. Por eso tampoco se llama a `ensureObservedExecution`: este
   * evento no afirma que la ejecucion siga viva.
   *
   * Un `LEVE` que se reintenta volvera a `RUNNING` con el siguiente
   * `node:started`, y asi debe ser: la tarjeta cuenta lo que esta pasando
   * ahora, no un veredicto definitivo.
   */
  const handleNodeError = (event: NodeErrorEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    patchStatus(event.nodeId, 'FAILED');
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

    ensureObservedExecution(event, ExecutionState.PAUSADO, event.activeCursor);

    // `pausedStepId` y no `activeCursor`: en una pausa programada el cursor
    // apunta al paso SIGUIENTE —reanudar entrando otra vez en la pausa seria un
    // bucle—, de modo que marcarlo senalaria un nodo que nunca arranco. El
    // motor emite siempre la clave, cayendo al cursor cuando no hay nada que
    // distinguir, asi que aqui no hace falta ramificar por tipo de pausa.
    const pausedAt = event.pausedStepId ?? event.activeCursor;
    const next = new Map(nodeStatuses.value);

    next.set(pausedAt, 'PAUSED');

    // El cursor queda en espera, no detenido: es el que correra al reanudar.
    if (pausedAt !== event.activeCursor) {
      next.set(event.activeCursor, 'IDLE');
    }

    nodeStatuses.value = next;

    // `activeCursor` y no `pausedAt`: es el cursor lo que el backend tiene
    // persistido, y la rehidratacion tras un F5 tiene que coincidir con lo que
    // se pinta ahora.
    patchObservedExecution({
      state: ExecutionState.PAUSADO,
      activeCursor: event.activeCursor,
    });
  };

  /**
   * Devuelve las cajas a su sitio cuando alguien relanza la ejecucion.
   *
   * SIN ESTO el canvas se queda congelado en la foto del intento anterior: el
   * nodo pausado sigue en ambar —nadie vuelve a tocarlo, porque con una
   * reanudacion selectiva ya no es el cursor— y los pasos posteriores conservan
   * su `COMPLETADO`, afirmando un trabajo que esta a punto de rehacerse.
   *
   * SE REPINTA ENTERO con `buildStatuses` en vez de parchear el mapa anterior, y
   * ese es el arreglo del defecto. El parcheo apagaba a `IDLE` el nodo que venia
   * marcado como pausado, sin preguntarse si habia corrido: al reanudar HACIA
   * ADELANTE, el `PAUSA_FLOW` —que si se ejecuto, y dejo su `pausedAtStepId` en
   * el contexto— quedaba en gris como si nunca hubiera arrancado, mientras que
   * recargar la pagina lo pintaba en verde. Reconstruir desde el contexto da la
   * misma respuesta que la rehidratacion porque es, literalmente, el mismo
   * codigo.
   *
   * El destino queda en `RUNNING` y no en espera: `flow:resumed` se emite justo
   * ANTES de entrar al motor, de modo que ese paso esta a punto de arrancar en
   * el mismo tick. Es optimismo deliberado —el `node:started` que llega detras
   * lo confirma, y un desenlace distinto lo corrige— a cambio de que el operador
   * vea de inmediato que su reanudacion surtio efecto.
   *
   * Se ejecuta en TODOS los clientes de la sala, que es lo que evita tener que
   * recargar para ver el estado real.
   */
  const handleFlowResumed = (event: FlowResumedEvent): void => {
    if (!belongsToCanvas(event.flowId)) {
      return;
    }

    ensureObservedExecution(event, ExecutionState.EN_PROCESO);

    const target = event.targetStepId ?? event.activeCursor;

    nodeStatuses.value = buildStatuses(executionContext.value, {
      nodeId: target,
      status: 'RUNNING',
    });

    // La ejecucion vuelve a estar viva. Sin esto, `executionState` seguia
    // diciendo `PAUSADO` hasta la siguiente recarga: la cabecera mentia y
    // `isResumableFrom` dejaba el boton de reanudar encendido sobre una
    // ejecucion que ya estaba corriendo.
    patchObservedExecution({
      state: ExecutionState.EN_PROCESO,
      activeCursor: target,
    });
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

    ensureObservedExecution(event, event.finalState);

    const resolved: CanvasNodeStatus =
      event.finalState === ExecutionState.EXITOSO ? 'COMPLETED' : 'FAILED';
    const next = new Map(nodeStatuses.value);

    for (const [nodeId, status] of next) {
      if (status === 'RUNNING') {
        next.set(nodeId, resolved);
      }
    }

    nodeStatuses.value = next;

    // El cursor se anula igual que lo hace el motor al cerrar el checkpoint:
    // una ejecucion terminada no tiene paso activo, y dejarlo puesto mantendria
    // encendido el boton de reanudar sobre algo que ya no se puede reanudar.
    patchObservedExecution({
      state: event.finalState,
      activeCursor: null,
    });
  };

  /**
   * Aplica al flujo que el canvas mira la mutacion CRUD que acaba de difundirse.
   *
   * La via por la que la cabecera se entera de una AUTODESACTIVACION. Cuando
   * una ejecucion con `executionPolicy.stopOnFirstSuccess` cierra bien, el
   * backend pone el flujo en `INACTIVO` y publica la mutacion por el canal
   * `crud:mutation` que ya mantiene al dia la tabla de flujos. Sin engancharse
   * a el, la insignia del canvas seguia diciendo «Activo» sobre un flujo cuyo
   * sondeo ya se habia desmontado, y nada lo desmentia hasta un F5.
   *
   * Se reutiliza ese canal en vez de emitir un evento nuevo: la informacion ya
   * viaja, completa y con el resumen recien guardado.
   *
   * La guarda por `id` no es cosmetica: `useCrudSocket` encamina TODAS las
   * mutaciones de flujos, y sin ella la desactivacion de un flujo ajeno
   * repintaria la cabecera de este.
   */
  const applyWorkflowMutation = (
    action: CrudAction,
    item: PipelineSummary | undefined,
    id: string,
  ): void => {
    if (workflow.value === null || workflow.value.id !== id) {
      return;
    }

    if (action === 'DELETED') {
      workflow.value = null;
      observedExecution.value = null;
      nodeStatuses.value = new Map();
      selectedNodeId.value = null;

      return;
    }

    if (item === undefined) {
      return;
    }

    // Fusion y no sustitucion: lo que viaja por el canal es el RESUMEN del
    // flujo, que no lleva `pipelineSchema`. Reemplazar el objeto entero dejaria
    // el canvas sin topologia que pintar.
    workflow.value = { ...workflow.value, ...item };
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
    syncCurrentExecution,
    handleNodeStarted,
    handleNodeCompleted,
    handleNodeError,
    handleFlowPaused,
    handleFlowResumed,
    handleFlowCompleted,
    applyWorkflowMutation,
    selectNode,
    clearSelection,
    observeFlow,
    stopObserving,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCanvasStore, import.meta.hot));
}
