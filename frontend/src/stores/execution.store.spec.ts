import { createPinia, setActivePinia } from 'pinia';

import { WorkflowStatus } from '@/types/pipeline';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExecutionStore } from './execution.store';

import { ExecutionState } from '@/types/execution';

import type {
  DiscardExecutionResult,
  ExecutionDetail,
  ExecutionSummary,
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
} from '@/types/execution';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador. El
// canal WebSocket NO se mockea porque el store no lo importa: recibe eventos
// como argumentos, y quien lo engancha al socket es `useExecutionSocket`.
vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  fetchExecution: vi.fn(),
  resumeExecution: vi.fn(),
  discardExecution: vi.fn(),
}));

// El store emite a las salas a traves de este servicio desde que `joinFlow`
// existe. Se mockea entero: el spec comprueba el circuito, no el transporte.
vi.mock('@services/socket-events.service', () => ({
  joinFlowRoom: vi.fn(),
  leaveFlowRoom: vi.fn(),
}));

const service = await import('@services/fsm-executions.service');
const socketEvents = await import('@services/socket-events.service');
const joinFlowRoom = vi.mocked(socketEvents.joinFlowRoom);
const leaveFlowRoom = vi.mocked(socketEvents.leaveFlowRoom);
const fetchExecutions = vi.mocked(service.fetchExecutions);
const fetchExecution = vi.mocked(service.fetchExecution);
const resumeExecution = vi.mocked(service.resumeExecution);
const discardExecution = vi.mocked(service.discardExecution);

const EXECUTION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_FLOW_ID = 'c4e2d3f5-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const LOG_PATH = '/logs/execution-2026-10-10.log';

const buildSummary = (overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  state: ExecutionState.EN_PROCESO,
  activeCursor: 'nodo_ia',
  logFilePath: LOG_PATH,
  failureReason: null,
  startedAt: '2026-10-10T07:00:00.000Z',
  updatedAt: '2026-10-10T07:30:00.000Z',
  ...overrides,
});

const buildDetail = (overrides: Partial<ExecutionDetail> = {}): ExecutionDetail => ({
  ...buildSummary(),
  context: { parsed_email: { subject: 'Hola' } },
  retryState: { nodo_ia: 2 },
  ...overrides,
});

const buildNodeError = (overrides: Partial<NodeErrorEvent> = {}): NodeErrorEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T08:00:00.000Z',
  nodeId: 'nodo_ia',
  severity: 'GRAVE',
  errorCode: 'ERR_LLM_TIMEOUT',
  errorMessage: 'Tiempo agotado.',
  logFilePath: LOG_PATH,
  attempt: 1,
  ...overrides,
});

const PAUSED: FlowPausedEvent = {
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T08:00:00.000Z',
  activeCursor: 'nodo_ia',
  severity: 'GRAVE',
  errorMessage: 'El proveedor devolvio 503.',
  logFilePath: '/logs/execution-2026-10-11.log',
};

const RESUMED: FlowResumedEvent = {
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T09:00:00.000Z',
  activeCursor: 'nodo_ia',
  resumedBy: { id: 'usuario-1', email: 'editor@unuware.com' },
};

describe('useExecutionStore · estado reactivo de las ejecuciones del motor', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchExecutions.mockResolvedValue({
      items: [buildSummary()],
      total: 1,
      limit: 25,
      offset: 0,
    });
    fetchExecution.mockResolvedValue(buildDetail());
    resumeExecution.mockResolvedValue({
      executionId: EXECUTION_ID,
      workflowId: FLOW_ID,
      status: ExecutionState.EXITOSO,
      activeCursor: null,
      context: {},
    });
  });

  describe('1. Carga desde el backend', () => {
    it('1.1 deberia poblar el listado desde el servicio', async () => {
      // 1. Arrange
      const store = useExecutionStore();

      // 2. Act
      await store.fetchExecutions({ state: ExecutionState.PAUSADO });

      // 3. Assert
      expect(store.executions).toHaveLength(1);
      expect(fetchExecutions).toHaveBeenCalledWith({
        state: ExecutionState.PAUSADO,
      });
    });

    it('1.2 deberia apagar isLoading aunque el servicio falle', async () => {
      // 1. Arrange
      const store = useExecutionStore();
      fetchExecutions.mockRejectedValue(new Error('503'));

      // 2. Act
      await expect(store.fetchExecutions()).rejects.toThrow('503');

      // 3. Assert
      expect(store.isLoading).toBe(false);
    });

    // La lista pertenece a la ejecucion activa: conservarla al cambiar de
    // ejecucion mostraria las trazas de la anterior bajo la cabecera nueva.
    it('1.3 deberia vaciar las trazas al abrir otra ejecucion', async () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.activeExecution = buildSummary();
      store.handleNodeError(buildNodeError());

      // 2. Act
      await store.fetchExecution(EXECUTION_ID);

      // 3. Assert
      expect(store.nodeEvents).toHaveLength(0);
    });
  });

  describe('2. Derivados del estado activo', () => {
    it('2.1 deberia exponer cursor y estado de la ejecucion abierta', async () => {
      // 1. Arrange
      const store = useExecutionStore();

      // 2. Act
      await store.fetchExecution(EXECUTION_ID);

      // 3. Assert
      expect(store.activeCursor).toBe('nodo_ia');
      expect(store.currentState).toBe(ExecutionState.EN_PROCESO);
      expect(store.isRunning).toBe(true);
      expect(store.isPaused).toBe(false);
    });

    it('2.2 deberia marcar isPaused tras recibir la pausa', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.activeExecution = buildSummary();

      // 2. Act
      store.handleFlowPaused(PAUSED);

      // 3. Assert
      expect(store.isPaused).toBe(true);
      expect(store.isRunning).toBe(false);
    });

    it('2.3 deberia devolver null en los derivados sin ejecucion activa', () => {
      // 1. Arrange
      const store = useExecutionStore();

      // 2. Act & 3. Assert
      expect(store.activeCursor).toBeNull();
      expect(store.currentState).toBeNull();
      expect(store.lastNodeError).toBeNull();
    });
  });

  describe('3. Eventos del canal WebSocket', () => {
    it('3.1 deberia parchear la fila del listado al pausarse', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.executions = [buildSummary()];

      // 2. Act
      store.handleFlowPaused(PAUSED);

      // 3. Assert
      expect(store.executions[0]?.state).toBe(ExecutionState.PAUSADO);
      expect(store.executions[0]?.failureReason).toBe('El proveedor devolvio 503.');
      expect(store.executions[0]?.logFilePath).toBe('/logs/execution-2026-10-11.log');
    });

    // Un `null` incondicional borraria una ruta anterior perfectamente valida,
    // que es la misma precaucion que toma `pauseAt` en el backend.
    it('3.2 NO deberia borrar la ruta del log si el evento no trae ninguna', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.executions = [buildSummary()];

      // 2. Act
      store.handleFlowPaused({
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-10T08:00:00.000Z',
        activeCursor: 'nodo_ia',
      });

      // 3. Assert
      expect(store.executions[0]?.logFilePath).toBe(LOG_PATH);
    });

    it('3.3 deberia limpiar el motivo de fallo al reanudarse', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.executions = [buildSummary({ failureReason: 'Fallo anterior' })];

      // 2. Act
      store.handleFlowResumed(RESUMED);

      // 3. Assert
      expect(store.executions[0]?.state).toBe(ExecutionState.EN_PROCESO);
      expect(store.executions[0]?.failureReason).toBeNull();
    });

    it('3.4 deberia acumular las trazas de la ejecucion activa, la ultima primero', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.activeExecution = buildSummary();

      // 2. Act
      store.handleNodeError(buildNodeError({ attempt: 1 }));
      store.handleNodeError(buildNodeError({ attempt: 2 }));

      // 3. Assert
      expect(store.nodeEvents).toHaveLength(2);
      expect(store.lastNodeError?.attempt).toBe(2);
    });

    // Un socket puede estar en varias salas: mezclar trazas de dos ejecuciones
    // haria que el operador leyese como propios unos fallos que no lo son.
    it('3.5 deberia descartar los eventos de otra ejecucion', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.activeExecution = buildSummary();

      // 2. Act
      store.handleNodeError(buildNodeError({ executionId: OTHER_EXECUTION_ID }));

      // 3. Assert
      expect(store.nodeEvents).toHaveLength(0);
    });

    it('3.6 deberia descartar trazas si no hay ninguna ejecucion abierta', () => {
      // 1. Arrange
      const store = useExecutionStore();

      // 2. Act
      store.handleNodeError(buildNodeError());

      // 3. Assert
      expect(store.nodeEvents).toHaveLength(0);
    });

    it('3.7 deberia respetar el techo de trazas retenidas', () => {
      // 1. Arrange: una pestana abierta toda la jornada no puede crecer sin fin.
      const store = useExecutionStore();
      store.activeExecution = buildSummary();

      // 2. Act
      for (let attempt = 1; attempt <= 205; attempt += 1) {
        store.handleNodeError(buildNodeError({ attempt }));
      }

      // 3. Assert
      expect(store.nodeEvents).toHaveLength(200);
      expect(store.lastNodeError?.attempt).toBe(205);
    });
  });

  describe('4. Inmutabilidad del payload del backend', () => {
    // `frontend-quasar.md` §3: el StatePayloadContext que llega del backend se
    // trata como inmutable en la interfaz.
    //
    // Las aserciones son sobre CONTENIDO y no sobre identidad: Pinia envuelve
    // el array en un proxy reactivo, asi que `store.executions[0]` nunca es
    // `===` al objeto que se le asigno. Un `not.toBe` pasaria aqui sin probar
    // nada, y un `toBe` fallaria aunque el codigo fuese correcto.
    it('4.1 NO deberia mutar la fila previa al parchearla', () => {
      // 1. Arrange
      const store = useExecutionStore();
      const original = buildSummary();
      store.executions = [original];
      const snapshot = { ...original };

      // 2. Act
      store.handleFlowPaused(PAUSED);

      // 3. Assert: el objeto que se entrego sigue intacto, y el del store si
      //    refleja el parche. Si se hubiera mutado en sitio, ambos dirian
      //    PAUSADO y la primera asercion caeria.
      expect(original).toEqual(snapshot);
      expect(original.state).toBe(ExecutionState.EN_PROCESO);
      expect(store.executions[0]?.state).toBe(ExecutionState.PAUSADO);
    });

    it('4.2 NO deberia mutar la lista previa de trazas', () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.activeExecution = buildSummary();
      store.handleNodeError(buildNodeError({ attempt: 1 }));
      const previous = store.nodeEvents;

      // 2. Act
      store.handleNodeError(buildNodeError({ attempt: 2 }));

      // 3. Assert
      expect(previous).toHaveLength(1);
      expect(store.nodeEvents).not.toBe(previous);
    });

    it('4.3 NO deberia tocar las filas de otras ejecuciones del listado', () => {
      // 1. Arrange
      const store = useExecutionStore();
      const other = buildSummary({ executionId: OTHER_EXECUTION_ID });
      store.executions = [buildSummary(), other];

      const snapshot = { ...other };

      // 2. Act
      store.handleFlowPaused(PAUSED);

      // 3. Assert
      expect(store.executions[1]).toEqual(snapshot);
    });
  });

  describe('5. Reintento manual (CU-09)', () => {
    it('5.1 deberia reanudar y parchear el estado devuelto', async () => {
      // 1. Arrange
      const store = useExecutionStore();
      store.executions = [
        buildSummary({
          state: ExecutionState.PAUSADO,
          failureReason: 'Fallo anterior',
        }),
      ];

      // 2. Act
      const result = await store.resumeExecution(EXECUTION_ID);

      // 3. Assert: mismo id, el historico no crece con cada intento.
      expect(result.executionId).toBe(EXECUTION_ID);
      expect(store.executions[0]?.state).toBe(ExecutionState.EXITOSO);
      expect(store.executions[0]?.failureReason).toBeNull();
      expect(store.isResuming).toBe(false);
    });

    it('5.2 deberia propagar el error y apagar isResuming', async () => {
      // 1. Arrange: el 409, el 400 y el 429 piden mensajes distintos, y quien
      //    los decide es el componente.
      const store = useExecutionStore();
      resumeExecution.mockRejectedValue(new Error('409'));

      // 2. Act
      await expect(store.resumeExecution(EXECUTION_ID)).rejects.toThrow('409');

      // 3. Assert
      expect(store.isResuming).toBe(false);
    });
  });
  describe('6. Salas del canal de eventos', () => {
    beforeEach(() => {
      joinFlowRoom.mockReset();
      leaveFlowRoom.mockReset();
    });

    it('6.1 deberia apuntar la sala cuando el gateway la acepta', async () => {
      // 1. Arrange
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: true });

      // 2. Act
      const ack = await store.joinFlow(FLOW_ID);

      // 3. Assert
      expect(ack.ok).toBe(true);
      expect(joinFlowRoom).toHaveBeenCalledWith(FLOW_ID);
      expect([...store.joinedFlowIds]).toEqual([FLOW_ID]);
    });

    it('6.2 NO deberia apuntar la sala cuando el gateway la rechaza', async () => {
      // 1. Arrange: un UUID mal formado o el tope de salas por socket devuelven
      //    `{ ok: false }`. Apuntar una sala en la que no se esta haria que la
      //    re-suscripcion tras reconectar insistiera en un destino inexistente.
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: false, reason: 'no es un UUID' });

      // 2. Act
      const ack = await store.joinFlow('flujo-invalido');

      // 3. Assert
      expect(ack.ok).toBe(false);
      expect(store.joinedFlowIds.size).toBe(0);
    });

    it('6.3 deberia acumular las salas sin abandonar la anterior', async () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: true });
      leaveFlowRoom.mockResolvedValue({ ok: true });
      await store.joinFlow(FLOW_ID);

      // 2. Act ⚙️
      await store.joinFlow(OTHER_FLOW_ID);

      // 3. Assert 🎯: la tabla de flujos sigue a todas sus filas a la vez, de
      //    modo que entrar en una sala no puede expulsar de la anterior.
      expect(leaveFlowRoom).not.toHaveBeenCalled();
      expect([...store.joinedFlowIds]).toEqual([FLOW_ID, OTHER_FLOW_ID]);
    });

    it('6.4 deberia ser idempotente sobre la sala ya ocupada', async () => {
      // 1. Arrange
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: true });
      await store.joinFlow(FLOW_ID);
      joinFlowRoom.mockClear();

      // 2. Act
      await store.joinFlow(FLOW_ID);

      // 3. Assert: sin esto, cada montaje de la vista repetiria el handshake.
      expect(joinFlowRoom).not.toHaveBeenCalled();
      expect(leaveFlowRoom).not.toHaveBeenCalled();
    });

    it('6.5 deberia descontar solo la sala abandonada', async () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: true });
      leaveFlowRoom.mockResolvedValue({ ok: true });
      await store.joinFlow(FLOW_ID);
      await store.joinFlow(OTHER_FLOW_ID);

      // 2. Act ⚙️
      await store.leaveFlow(FLOW_ID);

      // 3. Assert 🎯
      expect(leaveFlowRoom).toHaveBeenCalledWith(FLOW_ID);
      expect([...store.joinedFlowIds]).toEqual([OTHER_FLOW_ID]);
    });

    it('6.6 deberia vaciar todas las salas de una vez', async () => {
      // 1. Arrange 📐: es lo que invoca la tabla al desmontarse.
      const store = useExecutionStore();
      joinFlowRoom.mockResolvedValue({ ok: true });
      leaveFlowRoom.mockResolvedValue({ ok: true });
      await store.joinFlow(FLOW_ID);
      await store.joinFlow(OTHER_FLOW_ID);

      // 2. Act ⚙️
      await store.leaveAllFlows();

      // 3. Assert 🎯
      expect(leaveFlowRoom).toHaveBeenCalledWith(FLOW_ID);
      expect(leaveFlowRoom).toHaveBeenCalledWith(OTHER_FLOW_ID);
      expect(store.joinedFlowIds.size).toBe(0);
    });

    it('6.7 deberia ignorar el abandono de una sala que no se ocupa', async () => {
      // 1. Arrange 📐
      const store = useExecutionStore();

      // 2. Act ⚙️
      await store.leaveFlow(FLOW_ID);

      // 3. Assert 🎯
      expect(leaveFlowRoom).not.toHaveBeenCalled();
    });
  });

  describe('7. Indice de ejecuciones por flujo', () => {
    it('7.1 deberia quedarse con la ejecucion mas reciente de cada flujo', () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      store.executions = [
        buildSummary({
          executionId: 'exec-vieja',
          flowId: FLOW_ID,
          startedAt: '2026-01-01T00:00:00.000Z',
        }),
        buildSummary({
          executionId: 'exec-nueva',
          flowId: FLOW_ID,
          startedAt: '2026-02-01T00:00:00.000Z',
        }),
        buildSummary({ executionId: 'exec-otra', flowId: OTHER_FLOW_ID }),
      ];

      // 2. Act ⚙️
      const index = store.executionByFlowId;

      // 3. Assert 🎯: la fila debe reflejar la ejecucion vigente, no la
      //    primera que devolvio la API.
      expect(index.get(FLOW_ID)?.executionId).toBe('exec-nueva');
      expect(index.get(OTHER_FLOW_ID)?.executionId).toBe('exec-otra');
    });
  });

  describe('descarte manual (CU-09)', () => {
    const buildDiscardResult = (
      overrides: Partial<ExecutionSummary> = {},
    ): DiscardExecutionResult =>
      ({
        execution: buildSummary({
          state: ExecutionState.DESCARTADO,
          activeCursor: null,
          failureReason: 'Descartada manualmente por un operador',
          ...overrides,
        }),
        workflow: { id: FLOW_ID, status: WorkflowStatus.INACTIVO },
      }) as DiscardExecutionResult;

    it('deberia cerrar la fila en DESCARTADO y sin cursor', async () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      store.executions = [buildSummary({ state: ExecutionState.PAUSADO })];
      discardExecution.mockResolvedValue(buildDiscardResult());

      // 2. Act ⚙️
      await store.discardExecution(EXECUTION_ID);

      // 3. Assert 🎯
      expect(discardExecution).toHaveBeenCalledWith(EXECUTION_ID);
      expect(store.executions[0]?.state).toBe(ExecutionState.DESCARTADO);
      // Sin cursor: DESCARTADO es terminal, y conservarlo ofreceria un
      // reintento imposible.
      expect(store.executions[0]?.activeCursor).toBeNull();
      expect(store.isDiscarding).toBe(false);
    });

    it('deberia propagar el fallo y apagar el indicador igualmente', async () => {
      // 1. Arrange 📐: el 409 de «ya no esta PAUSADO» necesita un mensaje
      //    propio, y quien lo decide es el componente.
      const store = useExecutionStore();
      discardExecution.mockRejectedValue(new Error('409'));

      // 2. Act ⚙️ + 3. Assert 🎯
      await expect(store.discardExecution(EXECUTION_ID)).rejects.toThrow('409');
      expect(store.isDiscarding).toBe(false);
    });

    it('deberia reflejar el descarte llegado por el canal', () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      store.executions = [buildSummary({ state: ExecutionState.PAUSADO })];

      const event: FlowDiscardedEvent = {
        executionId: EXECUTION_ID,
        flowId: FLOW_ID,
        emittedAt: '2026-10-10T08:00:00.000Z',
        discardedBy: 'practicas@unuware.com',
        lastCursor: 'nodo_ia',
        workflowDeactivated: true,
      };

      // 2. Act ⚙️
      store.handleFlowDiscarded(event);

      // 3. Assert 🎯
      expect(store.executions[0]?.state).toBe(ExecutionState.DESCARTADO);
      expect(store.executions[0]?.activeCursor).toBeNull();
    });
  });

  describe('cierre terminal llegado por el canal', () => {
    const buildCompleted = (overrides: Partial<FlowCompletedEvent> = {}): FlowCompletedEvent => ({
      executionId: EXECUTION_ID,
      flowId: FLOW_ID,
      emittedAt: '2026-10-10T08:10:00.000Z',
      finalState: ExecutionState.EXITOSO,
      ...overrides,
    });

    it('deberia escribir el estado terminal que dicta el evento', () => {
      // 1. Arrange 📐: el estado lo decide el motor; reconstruirlo aqui seria
      //    una segunda fuente de verdad.
      const store = useExecutionStore();
      store.executions = [buildSummary()];

      // 2. Act ⚙️
      store.handleFlowCompleted(buildCompleted({ finalState: ExecutionState.OMITIDO }));

      // 3. Assert 🎯
      expect(store.executions[0]?.state).toBe(ExecutionState.OMITIDO);
      expect(store.executions[0]?.activeCursor).toBeNull();
    });

    it('deberia conservar el motivo del fallo que trae el cierre', () => {
      // 1. Arrange 📐
      const store = useExecutionStore();
      store.executions = [buildSummary()];

      // 2. Act ⚙️
      store.handleFlowCompleted(
        buildCompleted({
          finalState: ExecutionState.FALLIDO,
          failureReason: 'La ruta de contingencia solo notifico',
        }),
      );

      // 3. Assert 🎯
      expect(store.executions[0]?.failureReason).toBe('La ruta de contingencia solo notifico');
    });
  });
});
