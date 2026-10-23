import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from './canvas.store';

import { ExecutionState } from '@/types/execution';
import { WorkflowStatus, NodeType } from '@/types/pipeline';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

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
  fetchExecution: vi.fn(),
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
const fetchExecution = vi.mocked(executionsService.fetchExecution);
const leaveFlowRoom = vi.mocked(socketEvents.leaveFlowRoom);

const FLOW_ID = 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b';
const OTHER_FLOW_ID = 'a2b3c4d5-e6f7-4809-9b0c-1d2e3f4a5b6c';
const EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_EXECUTION_ID = '99999999-8888-4777-8666-555555555555';

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
  ...AUDIT_FIXTURE,
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

/**
 * Topologia de tres pasos que reproduce el caso reportado:
 * `procesador_ia` → `pausa_flow` → `escudo_post_ia`.
 *
 * No se reutiliza `buildSchema`, que solo encadena dos nodos: el defecto
 * necesita un paso DETRAS del de pausa para que haya algo que purgar.
 */
const buildThreeStepSchema = (): AssembledPipelineSchema => ({
  flowId: FLOW_ID,
  name: 'Pipeline con pausa intermedia',
  version: '1.0.0',
  entrypoint: 'procesador_ia',
  nodes: {
    procesador_ia: {
      nodeId: 'procesador_ia',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: 'pausa_flow',
      onErrorStep: null,
      params: {},
    },
    pausa_flow: {
      nodeId: 'pausa_flow',
      nodeType: NodeType.PAUSA_FLOW,
      outputNamespace: 'pause_context',
      nextStep: 'escudo_post_ia',
      onErrorStep: null,
      params: {},
    },
    escudo_post_ia: {
      nodeId: 'escudo_post_ia',
      nodeType: NodeType.ESCUDO_POST_IA,
      outputNamespace: 'validation_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

const buildThreeStepWorkflow = (): WorkflowDetail => ({
  ...buildWorkflow(),
  pipelineSchema: buildThreeStepSchema(),
});

/**
 * Tres pasos nominales con UN satelite colgando de cada uno de los dos
 * primeros, para poder distinguir "por delante" de "por detras" del cursor.
 *
 * `sat_uno` cuelga de la columna 0 y `sat_dos` de la columna 1: al reanudar
 * desde el paso 1 el primero queda detras y el segundo delante.
 */
const buildTwoSatelliteSchema = (): AssembledPipelineSchema => ({
  flowId: FLOW_ID,
  name: 'Pipeline con dos ramas de error',
  version: '1.0.0',
  entrypoint: 'paso_uno',
  nodes: {
    paso_uno: {
      nodeId: 'paso_uno',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'paso_dos',
      onErrorStep: 'sat_uno',
      params: {},
    },
    paso_dos: {
      nodeId: 'paso_dos',
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
      nextStep: 'paso_tres',
      onErrorStep: 'sat_dos',
      params: {},
    },
    paso_tres: {
      nodeId: 'paso_tres',
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
    sat_uno: {
      nodeId: 'sat_uno',
      nodeType: NodeType.DESTINO_SMTP,
      outputNamespace: 'smtp_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
    sat_dos: {
      nodeId: 'sat_dos',
      nodeType: NodeType.PROCESADOR_OCR,
      outputNamespace: 'ocr_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
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

  describe('8. Pausa deliberada y reanudacion en vivo', () => {
    /** Ejecucion detenida por un `PAUSA_FLOW` en `nodo_a`, con el cursor en `nodo_b`. */
    const programmedPause = () =>
      buildExecution({
        state: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        context: {
          raw_email: { asunto: 'Licitacion' },
          pause_context: {
            pausedAtStepId: 'nodo_a',
            resumeStepId: 'nodo_b',
            reason: 'PROGRAMMED_AUTO_PAUSE',
          },
        },
      });

    /**
     * La misma ejecucion, pero detenida por un FALLO TECNICO: el motor sembro
     * `error_context` antes de desviar, y ademas queda el `pause_context` de un
     * `PAUSA_FLOW` que ya se ejecuto con normalidad en un intento anterior.
     */
    const technicalPauseWithStaleContext = () =>
      buildExecution({
        state: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
        context: {
          raw_email: { asunto: 'Licitacion' },
          pause_context: {
            pausedAtStepId: 'nodo_a',
            resumeStepId: 'nodo_b',
            reason: 'PROGRAMMED_AUTO_PAUSE',
          },
          error_context: {
            failed_node_id: 'nodo_b',
            error_code: 'ERR_LLM_MISSING_INPUT_TEXT',
            error_level: 'GRAVE',
          },
        },
      });

    it('8.0 deberia marcar el CURSOR cuando la pausa es por fallo tecnico', async () => {
      // 1. Arrange 📐: era el defecto. La rama de pausa programada ganaba
      //    siempre, de modo que una ejecucion rota en `nodo_b` se pintaba en
      //    ambar sobre el `PAUSA_FLOW` —que se habia ejecutado con normalidad—
      //    y dejaba sin senalar al nodo que de verdad hay que reintentar.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(technicalPauseWithStaleContext());

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯: manda `error_context`, pese a que el contexto tambien
      // trae un `pausedAtStepId`.
      expect(store.statusOf('nodo_b')).toBe('PAUSED');
      expect(store.statusOf('nodo_a')).not.toBe('PAUSED');
    });

    it('8.0bis NO deberia dejarse enganar por un error_context VACIO', async () => {
      // 1. Arrange 📐: un namespace presente pero sin claves no prueba ningun
      //    fallo, y tomarlo por uno taparia la pausa deliberada.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'nodo_b',
          context: {
            error_context: {},
            pause_context: { pausedAtStepId: 'nodo_a', resumeStepId: 'nodo_b' },
          },
        }),
      );

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('nodo_a')).toBe('PAUSED');
      expect(store.statusOf('nodo_b')).toBe('IDLE');
    });

    it('8.1 deberia marcar el NODO DE PAUSA al recargar, no el cursor', async () => {
      // 1. Arrange 📐: aqui no hay evento que escuchar, es lo que se ve al
      //    recargar sobre un flujo ya detenido. Sin leer el contexto, la caja
      //    marcada seria la del cursor —un paso que nunca arranco—.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(programmedPause());

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('nodo_a')).toBe('PAUSED');
      expect(store.statusOf('nodo_b')).toBe('IDLE');
    });

    it('8.2 deberia marcar el nodo de pausa al recibir el evento', async () => {
      // 1. Arrange 📐: el motor emite siempre `pausedStepId`, cayendo al cursor
      //    cuando no hay nada que distinguir, asi que el cliente no ramifica.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(null);

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:00.000Z',
        activeCursor: 'nodo_b',
        pausedStepId: 'nodo_a',
        isProgrammedPause: true,
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_a')).toBe('PAUSED');
      expect(store.statusOf('nodo_b')).toBe('IDLE');
    });

    it('8.3 deberia seguir marcando el cursor en una pausa por FALLO', async () => {
      // 1. Arrange 📐: la contrapartida. Ahi el nodo que se rompio ES el que se
      //    reintentara, y las dos claves coinciden.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(null);

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:00:00.000Z',
        activeCursor: 'nodo_b',
        pausedStepId: 'nodo_b',
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_b')).toBe('PAUSED');
    });

    it('8.4 deberia reiniciar desde el paso elegido al reanudar', async () => {
      // 1. Arrange 📐: los pasos posteriores conservan el COMPLETADO del
      //    intento anterior y mienten sobre lo que se va a reejecutar.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(programmedPause());

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeCompleted(buildCompleted({ nodeId: 'nodo_b' }));

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_a',
        targetStepId: 'nodo_a',
        previousCursor: 'nodo_b',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: el destino arranca en RUNNING —`flow:resumed` se emite
      //    justo antes de entrar al motor— y lo posterior vuelve a la espera.
      expect(store.statusOf('nodo_a')).toBe('RUNNING');
      expect(store.statusOf('nodo_b')).toBe('IDLE');
    });

    it('8.5 deberia CONSERVAR lo completado antes del paso elegido', async () => {
      // 1. Arrange 📐: reanudar desde el segundo paso no deshace el primero.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.PAUSADO, activeCursor: 'nodo_b' }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_b',
        targetStepId: 'nodo_b',
        previousCursor: 'nodo_b',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: `nodo_a` dejo `raw_email` en el contexto y se queda
      //    COMPLETADO; esta por delante del elegido, que arranca en RUNNING.
      expect(store.statusOf('nodo_a')).toBe('COMPLETED');
      expect(store.statusOf('nodo_b')).toBe('RUNNING');
    });

    it('8.6 NO deberia arrastrar a nadie con un satelite como destino', async () => {
      // 1. Arrange 📐: un nodo fuera del camino nominal no define "posterior",
      //    asi que reiniciar "desde el en adelante" no significa nada.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.PAUSADO, activeCursor: 'nodo_b' }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_alerta',
        targetStepId: 'nodo_alerta',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: el satelite se marca, y el camino nominal conserva su
      //    historico porque un nodo fuera de el no define ningun "despues".
      expect(store.statusOf('nodo_a')).toBe('COMPLETED');
      expect(store.statusOf('nodo_alerta')).toBe('RUNNING');
    });

    it('8.7 NO deberia reaccionar a la reanudacion de OTRO flujo', async () => {
      // 1. Arrange 📐: el canal difunde a la sala, pero el store se comparte.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(programmedPause());

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: OTHER_FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_a',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_a')).toBe('PAUSED');
    });
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. `prepareResume` purga `error_context` y
   * nada mas, de modo que los namespaces de los nodos POSTERIORES sobreviven a
   * una reanudacion selectiva. Al recargar la pagina, la siembra los leia como
   * prueba de que habian corrido y pintaba en verde un trabajo que el flujo
   * todavia tenia que rehacer.
   */
  describe('9. Reset topologico al rehidratar', () => {
    it('9.1 deberia marcar el nodo de pausa y dejar el cursor en espera', async () => {
      // 1. Arrange 📐: pausa DELIBERADA en `pausa_flow`; el cursor apunta ya al
      //    paso siguiente, que nunca llego a arrancar.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'escudo_post_ia',
          context: {
            llm_response: { titulo: 'Innovacion en Madrid' },
            pause_context: { pausedAtStepId: 'pausa_flow' },
          },
        }),
      );

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('pausa_flow')).toBe('PAUSED');
      expect(store.statusOf('escudo_post_ia')).toBe('IDLE');
      expect(store.statusOf('procesador_ia')).toBe('COMPLETED');
    });

    it('9.2 deberia ignorar los namespaces posteriores de un intento anterior', async () => {
      // 1. Arrange 📐: el contexto arrastra `pause_context` Y
      //    `validation_result` de la corrida anterior, pero la ejecucion se
      //    reanudo desde `procesador_ia` y los dos van a volver a correr.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.EN_PROCESO,
          activeCursor: 'procesador_ia',
          context: {
            llm_response: { titulo: 'Innovacion en Madrid' },
            pause_context: { pausedAtStepId: 'pausa_flow' },
            validation_result: { ok: true },
          },
        }),
      );

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯: sin la purga, los dos se pintaban en verde pese a que el
      //    motor todavia no habia llegado a ellos.
      expect(store.statusOf('procesador_ia')).toBe('RUNNING');
      expect(store.statusOf('pausa_flow')).toBe('IDLE');
      expect(store.statusOf('escudo_post_ia')).toBe('IDLE');
    });

    it('9.3 deberia conservar el historico completo de una ejecucion cerrada', async () => {
      // 1. Arrange 📐: control negativo. Una ejecucion terminada no tiene corte
      //    y purgar ahi borraria justo lo que hay que ensenar.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.EXITOSO,
          activeCursor: null,
          context: {
            llm_response: {},
            pause_context: { pausedAtStepId: 'pausa_flow' },
            validation_result: { ok: true },
          },
        }),
      );

      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('procesador_ia')).toBe('COMPLETED');
      expect(store.statusOf('pausa_flow')).toBe('COMPLETED');
      expect(store.statusOf('escudo_post_ia')).toBe('COMPLETED');
    });

    it('9.4 deberia purgar lo posterior tambien al reanudar en vivo', async () => {
      // 1. Arrange 📐: la contraparte de 9.2 sobre el canvas VIVO. Las dos
      //    rutas comparten el mismo barrido justo para no divergir.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'escudo_post_ia',
          context: {
            llm_response: {},
            pause_context: { pausedAtStepId: 'pausa_flow' },
            validation_result: { ok: true },
          },
        }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'procesador_ia',
        targetStepId: 'procesador_ia',
        previousCursor: 'escudo_post_ia',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: el destino corre y los dos posteriores vuelven a la
      //    espera pese a tener su namespace en el contexto del intento previo.
      expect(store.statusOf('procesador_ia')).toBe('RUNNING');
      expect(store.statusOf('pausa_flow')).toBe('IDLE');
      expect(store.statusOf('escudo_post_ia')).toBe('IDLE');
    });
  });

  /**
   * La cabecera leia `executionState`, que salia SOLO de la carga REST: las
   * transiciones se veian en las cajas pero la insignia se quedaba congelada
   * hasta que alguien recargaba la pagina.
   */
  describe('10. Reactividad del estado en vivo', () => {
    const loadRunningCanvas = async (overrides: Partial<ExecutionDetail> = {}) => {
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(buildExecution(overrides));

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      return store;
    };

    it('10.1 deberia anunciar la ejecucion al primer node:started', async () => {
      // 1. Arrange 📐: no existe ningun `flow:started` en el canal; el primer
      //    `node:started` ES el arranque observable.
      const store = await loadRunningCanvas({
        state: ExecutionState.PAUSADO,
        activeCursor: 'nodo_a',
      });

      // 2. Act ⚙️
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_a' }));

      // 3. Assert 🎯
      expect(store.executionState).toBe(ExecutionState.EN_PROCESO);
      expect(store.activeCursor).toBe('nodo_a');
    });

    it('10.2 deberia pasar a PAUSADO al recibir flow:paused', async () => {
      // 1. Arrange 📐
      const store = await loadRunningCanvas();

      // 2. Act ⚙️
      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_b',
        severity: 'GRAVE',
        errorMessage: 'Falta el texto de entrada',
      });

      // 3. Assert 🎯
      expect(store.executionState).toBe(ExecutionState.PAUSADO);
      expect(store.isPaused).toBe(true);
    });

    it('10.2bis deberia ofrecer la reanudacion en el acto, sin recargar', async () => {
      // 1. Arrange 📐: lo que el operador ve es el BOTON, y `CanvasNodeCard` lo
      //    enciende leyendo `isResumableFrom`. Ese getter exige `isPaused`, que
      //    sale de la ejecucion observada: si el evento no la parcheara, la
      //    tarjeta del nodo detenido se quedaria sin accion hasta un F5.
      const store = await loadRunningCanvas({
        state: ExecutionState.EN_PROCESO,
        activeCursor: 'nodo_b',
      });

      expect(store.isResumableFrom('nodo_b')).toBe(false);

      // 2. Act ⚙️
      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_b',
        severity: 'GRAVE',
        errorMessage: 'Falta el texto de entrada',
      });

      // 3. Assert 🎯: el cursor detenido admite reanudacion, y `nodo_a` tambien
      //    porque dejo su namespace en el contexto.
      expect(store.isResumableFrom('nodo_b')).toBe(true);
      expect(store.isResumableFrom('nodo_a')).toBe(true);
    });

    it('10.3 deberia volver a EN_PROCESO al reanudar, sin recargar', async () => {
      // 1. Arrange 📐: sin esto, `isPaused` seguia en `true` y el boton de
      //    reanudar quedaba encendido sobre una ejecucion ya en marcha.
      const store = await loadRunningCanvas({
        state: ExecutionState.PAUSADO,
        activeCursor: 'nodo_b',
      });

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_b',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯
      expect(store.executionState).toBe(ExecutionState.EN_PROCESO);
      expect(store.isPaused).toBe(false);
    });

    it('10.4 deberia cerrar el estado y el cursor al completarse', async () => {
      // 1. Arrange 📐
      const store = await loadRunningCanvas();

      // 2. Act ⚙️
      store.handleFlowCompleted({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:06:00.000Z',
        finalState: ExecutionState.EXITOSO,
      });

      // 3. Assert 🎯
      expect(store.executionState).toBe(ExecutionState.EXITOSO);
      expect(store.activeCursor).toBeNull();
    });

    it('10.5 deberia reflejar la autodesactivacion que llega por crud:mutation', async () => {
      // 1. Arrange 📐: el backend ya difunde la mutacion al apagar el flujo por
      //    `stopOnFirstSuccess`; esto comprueba que el canvas la escucha.
      const store = await loadRunningCanvas();

      // 2. Act ⚙️
      store.applyWorkflowMutation(
        'UPDATED',
        { ...buildWorkflow(), status: WorkflowStatus.INACTIVO },
        FLOW_ID,
      );

      // 3. Assert 🎯: cambia el estado SIN perder la topologia, que no viaja en
      //    el resumen difundido.
      expect(store.workflow?.status).toBe(WorkflowStatus.INACTIVO);
      expect(store.workflow?.pipelineSchema).not.toBeNull();
    });

    it('10.6 NO deberia aplicar la mutacion de OTRO flujo', async () => {
      // 1. Arrange 📐: `useCrudSocket` encamina TODAS las mutaciones de flujos.
      const store = await loadRunningCanvas();

      // 2. Act ⚙️
      store.applyWorkflowMutation(
        'UPDATED',
        { ...buildWorkflow(), id: OTHER_FLOW_ID, status: WorkflowStatus.INACTIVO },
        OTHER_FLOW_ID,
      );

      // 3. Assert 🎯
      expect(store.workflow?.status).toBe(WorkflowStatus.ACTIVO);
    });
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. `handleFlowResumed` parcheaba el mapa a
   * mano y apagaba a `IDLE` el nodo marcado como pausado sin preguntarse si
   * habia corrido. Al reanudar HACIA ADELANTE, el `PAUSA_FLOW` —que si se
   * ejecuto— quedaba en gris, mientras que recargar la pagina lo pintaba en
   * verde: el mismo flujo se dibujaba de dos maneras segun se hubiera pulsado
   * F5 o no.
   */
  describe('11. Convergencia del canvas vivo y el rehidratado', () => {
    /** Ejecucion detenida por el `PAUSA_FLOW`, con el cursor ya en el siguiente. */
    const pausedAtPauseNode = () =>
      buildExecution({
        state: ExecutionState.PAUSADO,
        activeCursor: 'escudo_post_ia',
        context: {
          llm_response: { titulo: 'Innovacion en Madrid' },
          pause_context: { pausedAtStepId: 'pausa_flow', resumeStepId: 'escudo_post_ia' },
        },
      });

    it('11.1 deberia COMPLETAR el nodo de pausa al reanudar hacia adelante', async () => {
      // 1. Arrange 📐: el caso reportado. Se reanuda desde el paso siguiente a
      //    la pausa, de modo que el nodo de pausa queda DETRAS del corte.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(pausedAtPauseNode());

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      expect(store.statusOf('pausa_flow')).toBe('PAUSED');

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'escudo_post_ia',
        previousCursor: 'pausa_flow',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: dejo `pausedAtStepId` en el contexto, que es la prueba de
      //    que corrio. Antes quedaba en 'IDLE', como si nunca hubiera arrancado.
      expect(store.statusOf('pausa_flow')).toBe('COMPLETED');
      expect(store.statusOf('procesador_ia')).toBe('COMPLETED');
      expect(store.statusOf('escudo_post_ia')).toBe('RUNNING');
    });

    it('11.2 deberia pintar lo mismo en vivo que tras recargar la pagina', async () => {
      // 1. Arrange 📐: LA PRUEBA QUE IMPIDE LA REGRESION. Los dos caminos
      //    comparten `buildStatuses`; si alguien vuelve a separarlos, esto cae.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(pausedAtPauseNode());

      const live = useCanvasStore();
      await live.loadCanvas(FLOW_ID);

      live.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'escudo_post_ia',
        previousCursor: 'pausa_flow',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      const afterLiveResume = new Map(live.nodeStatuses);

      // 2. Act ⚙️: el F5. El backend deja la ejecucion EN_PROCESO con el cursor
      //    en el destino, y el contexto conserva lo del intento anterior.
      setActivePinia(createPinia());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.EN_PROCESO,
          activeCursor: 'escudo_post_ia',
          context: {
            llm_response: { titulo: 'Innovacion en Madrid' },
            pause_context: { pausedAtStepId: 'pausa_flow', resumeStepId: 'escudo_post_ia' },
          },
        }),
      );

      const rehydrated = useCanvasStore();
      await rehydrated.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(Object.fromEntries(rehydrated.nodeStatuses)).toEqual(
        Object.fromEntries(afterLiveResume),
      );
    });

    it('11.3 NO deberia completar un paso previo que la contingencia salto', async () => {
      // 1. Arrange 📐: el control negativo de la regla topologica. Dar por
      //    completado TODO lo anterior al corte pintaria en verde un nodo que
      //    una ruta `onErrorStep` esquivo sin ejecutar.
      fetchWorkflow.mockResolvedValue(buildThreeStepWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'escudo_post_ia',
          // Sin `pause_context`: `pausa_flow` NO corrio.
          context: { llm_response: { titulo: 'Innovacion en Madrid' } },
        }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'escudo_post_ia',
        previousCursor: 'escudo_post_ia',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯
      expect(store.statusOf('pausa_flow')).toBe('IDLE');
      expect(store.statusOf('procesador_ia')).toBe('COMPLETED');
    });
  });

  /**
   * EL DEFECTO QUE CIERRA ESTE BLOQUE. Las cajas se pintaban igual —la guarda
   * de los manejadores mira el FLUJO, no la ejecucion—, pero la cabecera no:
   * `patchObservedExecution` se rendia con `observedExecution` en `null`, que
   * es justo lo que ocurre cuando el disparador arranca una ejecucion con la
   * vista ya abierta.
   */
  describe('12. Hidratacion y reconciliacion de la ejecucion observada', () => {
    it('12.1 deberia adoptar la ejecucion que anuncia el primer evento', async () => {
      // 1. Arrange 📐: canvas abierto sobre un flujo ARMADO, sin ejecucion viva.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(null);
      fetchExecution.mockResolvedValue(buildExecution());

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      expect(store.executionState).toBeNull();

      // 2. Act ⚙️
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_a' }));

      // 3. Assert 🎯: el evento NO se descarta y la cabecera se entera.
      expect(store.executionState).toBe(ExecutionState.EN_PROCESO);
      expect(store.activeCursor).toBe('nodo_a');
      expect(store.statusOf('nodo_a')).toBe('RUNNING');
      // Y se pide el detalle real, porque el evento no trae el contexto.
      expect(fetchExecution).toHaveBeenCalledWith(EXECUTION_ID);
    });

    it('12.2 deberia reponer el contexto real en segundo plano', async () => {
      // 1. Arrange 📐: sin el contexto, `isResumableFrom` no ofrece un solo
      //    paso al que volver y la reanudacion selectiva queda inerte.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(null);
      fetchExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'nodo_b',
          context: { raw_email: { asunto: 'Licitacion' } },
        }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️: el relleno es asincrono; se cede el turno para que resuelva.
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_b' }));
      await vi.waitFor(() => {
        expect(store.executionContext.raw_email).toBeDefined();
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_a')).toBe('COMPLETED');
    });

    it('12.3 NO deberia pisar el estado con una respuesta tardia', async () => {
      // 1. Arrange 📐: el relleno puede llegar cuando el canvas ya observa OTRA
      //    ejecucion. Fusionarlo a ciegas resucitaria un contexto muerto.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(null);

      // El doble responde SEGUN EL IDENTIFICADOR: la peticion de la ejecucion
      // vieja se queda colgada a proposito y la de la nueva responde al vuelo.
      // Con una sola promesa compartida, el doble mentiria devolviendo la
      // ejecucion vieja tambien a quien pregunto por la nueva.
      let resolveLate: (value: ExecutionDetail) => void = () => undefined;
      const late = new Promise<ExecutionDetail>((resolve) => {
        resolveLate = resolve;
      });

      fetchExecution.mockImplementation((executionId: string) =>
        executionId === EXECUTION_ID
          ? late
          : Promise.resolve(buildExecution({ executionId: OTHER_EXECUTION_ID, context: {} })),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_a' }));

      // 2. Act ⚙️: llega un evento de una ejecucion NUEVA y solo despues
      //    responde la peticion de la vieja.
      store.handleNodeStarted(buildStarted({ nodeId: 'nodo_b', executionId: OTHER_EXECUTION_ID }));
      resolveLate(buildExecution({ context: { raw_email: { asunto: 'Viejo' } } }));
      await vi.waitFor(() => {
        expect(store.observedExecution?.executionId).toBe(OTHER_EXECUTION_ID);
      });

      // 3. Assert 🎯: el contexto de la vieja no se cuela en la nueva.
      expect(store.executionContext.raw_email).toBeUndefined();
    });

    it('12.4 deberia reconciliar el estado tras una reconexion', async () => {
      // 1. Arrange 📐: los eventos emitidos durante el corte no se reenvian a
      //    nadie, asi que la unica salida es volver a preguntar por REST.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.EN_PROCESO, activeCursor: 'nodo_a' }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️: mientras no habia conexion, el flujo se pauso.
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'nodo_b',
          context: { raw_email: { asunto: 'Licitacion' } },
        }),
      );
      await store.syncCurrentExecution();

      // 3. Assert 🎯
      expect(store.executionState).toBe(ExecutionState.PAUSADO);
      expect(store.statusOf('nodo_b')).toBe('PAUSED');
      expect(store.isLoading).toBe(false);
    });

    it('12.5 deberia enterarse de la ejecucion que TERMINO durante el corte', async () => {
      // 1. Arrange 📐: `fetchActiveExecution` solo busca estados vivos, de modo
      //    que una ejecucion ya cerrada vuelve como «no hay ninguna». Quedarse
      //    ahi dejaria las cajas del intento anterior encendidas para siempre.
      fetchWorkflow.mockResolvedValue(buildWorkflow());
      fetchActiveExecution.mockResolvedValue(
        buildExecution({ state: ExecutionState.EN_PROCESO, activeCursor: 'nodo_b' }),
      );

      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      fetchActiveExecution.mockResolvedValue(null);
      fetchExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.EXITOSO,
          activeCursor: null,
          context: { raw_email: {}, llm_response: {} },
        }),
      );
      await store.syncCurrentExecution();

      // 3. Assert 🎯
      expect(fetchExecution).toHaveBeenCalledWith(EXECUTION_ID);
      expect(store.executionState).toBe(ExecutionState.EXITOSO);
    });

    it('12.6 NO deberia pedir nada sin flujo cargado', async () => {
      // 1. Arrange 📐: el primer `connect` ocurre al arrancar la aplicacion,
      //    mucho antes de que nadie abra un canvas.
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.syncCurrentExecution();

      // 3. Assert 🎯
      expect(fetchActiveExecution).not.toHaveBeenCalled();
    });
  });

  /**
   * El satelite de contingencia tenia DOS lecturas contradictorias de su propio
   * historico: `isResumableFrom` miraba el contexto y lo daba por ejecutado,
   * mientras que el pintado solo recorria el camino nominal y lo dejaba en
   * espera. El operador veia un boton de reanudar sobre una caja apagada.
   */
  describe('13. Historico y reseteo de los satelites de contingencia', () => {
    it('13.1 deberia pintar COMPLETED un satelite que dejo su namespace', async () => {
      // 1. Arrange 📐: `nodo_alerta` cuelga solo del `onErrorStep` de `nodo_a`,
      //    asi que `buildOrderedTopology` no lo ve. Su namespace en el contexto
      //    es la prueba de que corrio.
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.EXITOSO,
          activeCursor: null,
          context: {
            raw_email: { asunto: 'Licitacion' },
            smtp_result: { enviado: true },
          },
        }),
      );
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('nodo_alerta')).toBe('COMPLETED');
    });

    it('13.2 deberia mantener el satelite encendido tras una reanudacion', async () => {
      // 1. Arrange 📐: el defecto reportado. El satelite se encendia con su
      //    `node:completed` y el primer repintado completo —que es lo que hace
      //    `handleFlowResumed`— lo devolvia a «En espera».
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'nodo_b',
          context: {
            raw_email: { asunto: 'Licitacion' },
            smtp_result: { enviado: true },
          },
        }),
      );
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️: se reanuda desde el cursor, sin volver atras.
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'nodo_b',
        previousCursor: 'nodo_b',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯: el satelite cuelga de `nodo_a` (columna 0), que ya quedo
      //    atras; su trabajo sigue hecho.
      expect(store.statusOf('nodo_alerta')).toBe('COMPLETED');
    });

    it('13.3 deberia apagar solo los satelites por delante del nuevo cursor', async () => {
      // 1. Arrange 📐: dos ramas de error en columnas distintas. Al volver al
      //    paso 1, la rama del paso 0 ya ocurrio y la del paso 1 todavia no se
      //    ha vuelto a tomar —puede que ni se tome, si esta vez no falla.
      fetchWorkflow.mockResolvedValue({
        ...buildWorkflow(),
        pipelineSchema: buildTwoSatelliteSchema(),
      });
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'paso_tres',
          context: {
            raw_email: {},
            parsed_email: {},
            llm_response: {},
            smtp_result: {},
            ocr_result: {},
          },
        }),
      );
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);

      // 2. Act ⚙️
      store.handleFlowResumed({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-16T08:05:00.000Z',
        activeCursor: 'paso_dos',
        targetStepId: 'paso_dos',
        previousCursor: 'paso_tres',
        resumedBy: { id: 'u-1', email: 'editor@unuware.com' },
      });

      // 3. Assert 🎯
      expect(store.statusOf('sat_uno')).toBe('COMPLETED');
      expect(store.statusOf('sat_dos')).toBe('IDLE');
      expect(store.statusOf('paso_tres')).toBe('IDLE');
    });

    it('13.4 NO deberia purgar nada si el corte es un satelite', async () => {
      // 1. Arrange 📐: regresion de 8.6. Un satelite no tiene indice nominal,
      //    asi que no define ningun "despues" con el que arrastrar a otros.
      fetchWorkflow.mockResolvedValue({
        ...buildWorkflow(),
        pipelineSchema: buildTwoSatelliteSchema(),
      });
      fetchActiveExecution.mockResolvedValue(
        buildExecution({
          state: ExecutionState.PAUSADO,
          activeCursor: 'sat_dos',
          context: { raw_email: {}, parsed_email: {}, smtp_result: {}, ocr_result: {} },
        }),
      );
      const store = useCanvasStore();

      // 2. Act ⚙️
      await store.loadCanvas(FLOW_ID);

      // 3. Assert 🎯
      expect(store.statusOf('sat_dos')).toBe('PAUSED');
      expect(store.statusOf('paso_uno')).toBe('COMPLETED');
      expect(store.statusOf('paso_dos')).toBe('COMPLETED');
      expect(store.statusOf('sat_uno')).toBe('COMPLETED');
    });

    it('13.5 deberia pintar FALLIDO el nodo que emite node:error', async () => {
      // 1. Arrange 📐: el canvas no escuchaba este evento, asi que una tarjeta
      //    rota se quedaba girando en «Procesando» hasta el siguiente evento de
      //    flujo.
      fetchActiveExecution.mockResolvedValue(buildExecution());
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      // 2. Act ⚙️
      store.handleNodeError({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-15T08:00:04.000Z',
        nodeId: 'nodo_b',
        severity: 'GRAVE',
        errorCode: 'ERR_LLM_TIMEOUT',
        errorMessage: 'El proveedor no respondio',
        logFilePath: null,
        attempt: 1,
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_b')).toBe('FAILED');
    });

    it('13.6 NO deberia atender un node:error de otro flujo', async () => {
      // 1. Arrange 📐: la tabla de flujos mantiene abierta la sala de todos.
      fetchActiveExecution.mockResolvedValue(buildExecution());
      const store = useCanvasStore();
      await store.loadCanvas(FLOW_ID);
      store.handleNodeStarted(buildStarted());

      // 2. Act ⚙️
      store.handleNodeError({
        executionId: OTHER_EXECUTION_ID,
        flowId: OTHER_FLOW_ID,
        emittedAt: '2026-10-15T08:00:04.000Z',
        nodeId: 'nodo_b',
        severity: 'URGENTE',
        errorCode: null,
        errorMessage: null,
        logFilePath: null,
        attempt: 1,
      });

      // 3. Assert 🎯
      expect(store.statusOf('nodo_b')).toBe('RUNNING');
    });
  });
});
