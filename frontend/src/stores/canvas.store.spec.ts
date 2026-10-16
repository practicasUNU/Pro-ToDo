import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from './canvas.store';

import { ExecutionState } from '@/types/execution';
import { WorkflowStatus, NodeType } from '@/types/pipeline';

import type {
  ExecutionDetail,
  FlowCompletedEvent,
  FlowPausedEvent,
  NodeCompletedEvent,
  NodeStartedEvent,
} from '@/types/execution';
import type { AssembledPipelineSchema, WorkflowDetail } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflows.service', () => ({
  fetchWorkflow: vi.fn(),
}));

vi.mock('@services/fsm-executions.service', () => ({
  fetchActiveExecution: vi.fn(),
}));

// El store de ejecucion habla con Socket.io al entrar y salir de sala: se
// neutraliza el transporte, no el store, para seguir probando la delegacion.
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
  leaveFlowRoom: vi.fn().mockResolvedValue({ ok: true }),
}));

const workflowsService = await import('@services/workflows.service');
const executionsService = await import('@services/fsm-executions.service');
const socketEvents = await import('@services/socket-events.service');
const fetchWorkflow = vi.mocked(workflowsService.fetchWorkflow);
const fetchActiveExecution = vi.mocked(executionsService.fetchActiveExecution);
const leaveFlowRoom = vi.mocked(socketEvents.leaveFlowRoom);

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
const OTHER_FLOW_ID = 'a2b3c4d5-e6f7-4809-9b0c-1d2e3f4a5b6c';
const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';

const buildSchema = (): AssembledPipelineSchema => ({
  flowId: FLOW_ID,
  name: 'Pipeline de prueba',
  version: '1.0.0',
  entrypoint: 'nodo_a',
  nodes: {
    nodo_a: {
      nodeId: 'nodo_a',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'nodo_b',
      onErrorStep: 'nodo_alerta',
      params: {},
    },
    nodo_b: {
      nodeId: 'nodo_b',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: null,
      onErrorStep: null,
      params: { modelo: 'claude' },
    },
    // Colgado SOLO del `onErrorStep`: no esta en el camino nominal.
    nodo_alerta: {
      nodeId: 'nodo_alerta',
      nodeType: NodeType.DESTINO_SMTP,
      outputNamespace: 'smtp_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

const buildWorkflow = (): WorkflowDetail => ({
  id: FLOW_ID,
  name: 'Notiweb - publicacion automatica',
  description: null,
  status: WorkflowStatus.ACTIVO,
  activeExecutionId: null,
  executionState: null,
  templateId: null,
  topology: [],
  pipelineSchema: buildSchema(),
});

const buildExecution = (overrides: Partial<ExecutionDetail> = {}): ExecutionDetail => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  state: ExecutionState.EN_PROCESO,
  activeCursor: 'nodo_b',
  logFilePath: null,
  failureReason: null,
  startedAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:05.000Z',
  context: { raw_email: { asunto: 'Licitacion' } },
  retryState: {},
  ...overrides,
});

const buildStarted = (overrides: Partial<NodeStartedEvent> = {}): NodeStartedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-15T08:00:01.000Z',
  nodeId: 'nodo_b',
  nodeType: NodeType.PROCESADOR_IA,
  stepIndex: 1,
  totalSteps: 2,
  transition: 2,
  attempt: 1,
  ...overrides,
});

const buildCompleted = (overrides: Partial<NodeCompletedEvent> = {}): NodeCompletedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-15T08:00:03.000Z',
  nodeId: 'nodo_b',
  nodeType: NodeType.PROCESADOR_IA,
  stepIndex: 1,
  totalSteps: 2,
  transition: 2,
  durationMs: 2000,
  attempts: 1,
  halted: false,
  ...overrides,
});

describe('useCanvasStore · supervision visual de un flujo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchWorkflow.mockResolvedValue(buildWorkflow());
    fetchActiveExecution.mockResolvedValue(null);
  });

  describe('1. Carga del flujo y su topologia', () => {
    it('1.1 deberia proyectar los nodos siguiendo nextStep, no el orden del mapa', async () => {
      // 1. Arrange
      const store = useCanvasStore();

      // 2. Act
      await store.loadCanvas(FLOW_ID);

      // 3. Assert: `nodo_alerta` NO esta, porque solo cuelga de un `onErrorStep`.
      expect(store.orderedSteps.map((step) => step.nodeId)).toEqual(['nodo_a', 'nodo_b']);
      expect(store.contingencySteps.map((step) => step.nodeId)).toEqual(['nodo_alerta']);
    });

    it('1.2 deberia dejar todo en espera cuando no hay ejecucion viva', async () => {
      // 1. Arrange
      const store = useCanvasStore();

      // 2. Act
      await store.loadCanvas(FLOW_ID);

      // 3. Assert
      expect(store.statusOf('nodo_a')).toBe('IDLE');
      expect(store.executionState).toBeNull();
    });

    it('1.3 deberia sembrar los estados a partir del checkpoint', async () => {
      // 1. Arrange: el namespace escrito es la unica prueba de que un nodo
      //    corrio; el cursor hereda el estado de la ejecucion.
      fetchActiveExecution.mockResolvedValue(buildExecution());
      const store = useCanvasStore();

      // 2. Act
      await store.loadCanvas(FLOW_ID);

      // 3. Assert
      expect(store.statusOf('nodo_a')).toBe('COMPLETED');
      expect(store.statusOf('nodo_b')).toBe('RUNNING');
    });

    it('1.4 deberia marcar el cursor como pausado cuando la ejecucion lo esta', async () => {
      // 1. Arrange
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.PAUSADO, failureReason: 'Timeout del LLM' }),
      );
      const store = useCanvasStore();

      // 2. Act
      await store.loadCanvas(FLOW_ID);

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('PAUSED');
      expect(store.isPaused).toBe(true);
      expect(store.activeCursor).toBe('nodo_b');
    });
  });

  describe('2. Ciclo de vida del nodo por el canal', () => {
    it('2.1 deberia encender el nodo al recibir node:started', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act
      store.handleNodeStarted(buildStarted());

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('RUNNING');
    });

    it('2.2 deberia marcarlo completado al recibir node:completed', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      // 2. Act
      store.handleNodeCompleted(buildCompleted());

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('COMPLETED');
    });

    it('2.3 deberia IGNORAR los eventos de otro flujo', async () => {
      // 1. Arrange: la suscripcion es unica y global, y la tabla de `/flujos`
      //    mantiene abiertas las salas de todos los flujos a la vez.
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act
      store.handleNodeStarted(buildStarted({ flowId: OTHER_FLOW_ID }));

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('IDLE');
    });
  });

  describe('3. Desenlace: cierre del nodo en vuelo', () => {
    it('3.1 deberia congelar el cursor al recibir flow:paused', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      const paused: FlowPausedEvent = {
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-15T08:00:04.000Z',
        activeCursor: 'nodo_b',
        severity: 'GRAVE',
        errorMessage: 'Tiempo agotado.',
        errorCode: 'ERR_LLM_TIMEOUT',
      };

      // 2. Act
      store.handleFlowPaused(paused);

      // 3. Assert: es el UNICO cierre del nodo en vuelo, porque el motor no
      //    emite ningun `node:aborted`.
      expect(store.statusOf('nodo_b')).toBe('PAUSED');
    });

    it('3.2 deberia apagar los nodos en vuelo al cerrarse con exito', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      const completed: FlowCompletedEvent = {
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-15T08:00:06.000Z',
        finalState: ExecutionState.EXITOSO,
      };

      // 2. Act
      store.handleFlowCompleted(completed);

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('COMPLETED');
    });

    it('3.3 deberia marcar fallido el nodo en vuelo ante un cierre no exitoso', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      const completed: FlowCompletedEvent = {
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-15T08:00:06.000Z',
        finalState: ExecutionState.FALLIDO,
        failureReason: 'La estrategia se rompio.',
      };

      // 2. Act
      store.handleFlowCompleted(completed);

      // 3. Assert
      expect(store.statusOf('nodo_b')).toBe('FAILED');
    });
  });

  describe('4. Seleccion e inspeccion', () => {
    it('4.1 deberia exponer el paso seleccionado con sus params', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act
      store.selectNode('nodo_b');

      // 3. Assert
      expect(store.selectedStep?.params).toEqual({ modelo: 'claude' });
    });

    it('4.2 deberia exponer el contexto inmutable de la ejecucion', async () => {
      // 1. Arrange
      fetchActiveExecution.mockResolvedValue(buildExecution());
      const store = useCanvasStore();

      // 2. Act
      await store.loadCanvas(FLOW_ID);

      // 3. Assert
      expect(store.executionContext.raw_email).toEqual({ asunto: 'Licitacion' });
    });

    it('4.3 deberia limpiar la seleccion', async () => {
      // 1. Arrange
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.selectNode('nodo_b');

      // 2. Act
      store.clearSelection();

      // 3. Assert
      expect(store.selectedStep).toBeNull();
    });
  });

  describe('5. Ciclo de vida de la vista', () => {
    it('5.1 deberia abandonar la sala y vaciar el canvas al desmontar', async () => {
      // 1. Arrange: sin la baja, el canvas seguiria recibiendo la animacion de
      //    un flujo que el operador ya no esta mirando.
      fetchActiveExecution.mockResolvedValue(buildExecution());
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      await store.observeFlow(FLOW_ID);

      // 2. Act
      await store.stopObserving(FLOW_ID);

      // 3. Assert
      expect(leaveFlowRoom).toHaveBeenCalledWith(FLOW_ID);
      expect(store.workflow).toBeNull();
      expect(store.orderedSteps).toEqual([]);
      expect(store.selectedStep).toBeNull();
    });
  });

  describe('6. Aristas y bifurcaciones del grafo', () => {
    it('6.1 deberia emparejar cada paso nominal con el siguiente', async () => {
      // 1. Arrange 📐
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️ & 3. Assert 🎯: dos pasos nominales, UNA arista.
      expect(store.nominalEdges).toEqual([
        expect.objectContaining({ fromNodeId: 'nodo_a', toNodeId: 'nodo_b' }),
      ]);
    });

    it('6.2 deberia colocar la ruta en la columna de quien la declara', async () => {
      // 1. Arrange 📐: `nodo_a` declara `onErrorStep: nodo_alerta` y es el
      //    primer paso, asi que su columna es la 0.
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.forkSlots).toEqual([
        expect.objectContaining({
          fromNodeId: 'nodo_a',
          toNodeId: 'nodo_alerta',
          column: 0,
          depth: 0,
          placement: 'card',
        }),
      ]);
    });

    it('6.3 deberia distinguir la cadena incondicional de la ruta selectiva', async () => {
      // 1. Arrange 📐: `null` significa "atrapa cualquier fallo"; un arreglo,
      //    solo los codigos que enumera. El componente no debe inspeccionar la
      //    union por su cuenta.
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.forkSlots[0]?.catchErrors).toBeNull();

      // 1. Arrange 📐 (segunda mitad): misma topologia, ruta selectiva.
      const schema = buildSchema();
      fetchWorkflow.mockResolvedValue({
        ...buildWorkflow(),
        pipelineSchema: {
          ...schema,
          nodes: {
            ...schema.nodes,
            nodo_a: {
              ...schema.nodes.nodo_a!,
              onErrorStep: { targetNode: 'nodo_alerta', catchErrors: ['ERR_A'] },
            },
          },
        },
      });

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.forkSlots[0]?.catchErrors).toEqual(['ERR_A']);
    });

    it('6.4 deberia marcar como rejoin un destino del camino nominal', async () => {
      // 1. Arrange 📐: ese nodo YA tiene tarjeta arriba; dibujarle otra romperia
      //    la biyeccion entre `nodeId` y tarjeta.
      const schema = buildSchema();
      fetchWorkflow.mockResolvedValue({
        ...buildWorkflow(),
        pipelineSchema: {
          ...schema,
          nodes: {
            ...schema.nodes,
            nodo_a: { ...schema.nodes.nodo_a!, onErrorStep: 'nodo_b' },
          },
        },
      });
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.forkSlots[0]?.placement).toBe('rejoin');
    });

    it('6.5 deberia marcar como missing un puntero a un nodo inexistente', async () => {
      // 1. Arrange 📐: un esquema roto debe verse, no desaparecer.
      const schema = buildSchema();
      fetchWorkflow.mockResolvedValue({
        ...buildWorkflow(),
        pipelineSchema: {
          ...schema,
          nodes: {
            ...schema.nodes,
            nodo_a: { ...schema.nodes.nodo_a!, onErrorStep: 'no_existe' },
          },
        },
      });
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.forkSlots[0]).toEqual(
        expect.objectContaining({ placement: 'missing', target: null }),
      );
    });

    it('6.6 NO deberia dar por recorrida una rama cuyo destino sigue en espera', async () => {
      // 1. Arrange 📐: el origen COMPLETED no sirve de prueba aqui. Un nodo que
      //    termino bien es justo el que NO desvio.
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.forkSlots[0]?.isTraversed).toBe(false);

      // 2. Act ⚙️ (segunda mitad): el destino se enciende.
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_alerta' }));

      // 3. Assert 🎯
      expect(store.forkSlots[0]?.isTraversed).toBe(true);
    });

    it('6.7 deberia dejar fuera de los huerfanos a los destinos ya colocados', async () => {
      // 1. Arrange 📐: `nodo_alerta` cuelga de una ruta, asi que NO es huerfano
      //    aunque no este en el camino nominal.
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.contingencySteps.map((step) => step.nodeId)).toEqual(['nodo_alerta']);
      expect(store.unreachableSteps).toEqual([]);
    });
  });

  describe('7. Elegibilidad para reanudar desde un paso (CU-09 extendido)', () => {
    /** Flujo cargado con una ejecucion PAUSADO en `nodo_b`. */
    const loadPaused = async (overrides = {}) => {
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.PAUSADO, ...overrides }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      return store;
    };

    it('7.1 NO deberia ofrecer nada sin ejecucion pausada', async () => {
      // 1. Arrange 📐: con el flujo corriendo no hay nada que reanudar.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(buildExecution());

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_a')).toBe(false);
      expect(store.isResumableFrom('nodo_b')).toBe(false);
    });

    it('7.2 deberia ofrecer el propio cursor', async () => {
      // 1. Arrange 📐: es donde se detuvo, y la reanudacion de siempre.
      const store = await loadPaused();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_b')).toBe(true);
    });

    it('7.3 deberia ofrecer un paso YA RECORRIDO', async () => {
      // 1. Arrange 📐: `nodo_a` escribio `raw_email`, que esta en el contexto.
      //    Esa es la unica prueba de que llego a ejecutarse.
      const store = await loadPaused();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_a')).toBe(true);
    });

    it('7.4 NO deberia ofrecer un paso que nunca se ejecuto', async () => {
      // 1. Arrange 📐: el satelite no corrio, asi que `smtp_result` no esta en
      //    el contexto. Saltar ahi dejaria sin datos a los pasos intermedios.
      const store = await loadPaused();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_alerta')).toBe(false);
    });

    it('7.5 SI deberia ofrecer un satelite de contingencia que llego a correr', async () => {
      // 1. Arrange 📐: es justo donde reanudar a mano resulta mas util, y por
      //    eso la pregunta va al CONTEXTO y no al indice en la topologia, que
      //    deja fuera a los satelites.
      const store = await loadPaused({
        context: { raw_email: { asunto: 'X' }, smtp_result: { message_id: 'm-1' } },
      });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_alerta')).toBe(true);
    });

    it('7.6 NO deberia ofrecer un nodo que no existe en el esquema', async () => {
      // 1. Arrange 📐
      const store = await loadPaused();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isResumableFrom('nodo_fantasma')).toBe(false);
    });
  });
});
