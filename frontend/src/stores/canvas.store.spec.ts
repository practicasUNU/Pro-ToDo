import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from './canvas.store';

import { ExecutionState } from '@/types/execution';
import { NodeType } from '@/types/pipeline';

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
  active: true,
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
});
