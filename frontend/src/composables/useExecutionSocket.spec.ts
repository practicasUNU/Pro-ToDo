// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExecutionSocket } from './useExecutionSocket';

import { ExecutionState } from '@/types/execution';

import type {
  ExecutionEventHandlers,
  FlowCompletedEvent,
  FlowDiscardedEvent,
  FlowPausedEvent,
  FlowResumedEvent,
  NodeErrorEvent,
} from '@/types/execution';
import type * as QuasarModule from 'quasar';
import type { QNotifyCreateOptions } from 'quasar';

// El canal se intercepta para QUEDARSE con los manejadores que el composable
// registra: asi el spec puede dispararlos a mano, sin socket ni servidor.
let registered: ExecutionEventHandlers | null = null;
const unsubscribe = vi.fn();

vi.mock('@services/socket-events.service', () => ({
  subscribeToExecutionEvents: vi.fn((handlers: ExecutionEventHandlers) => {
    registered = handlers;
    return unsubscribe;
  }),
}));

// Solo se sustituye `useQuasar`: el resto del paquete se conserva porque el
// store y los tipos siguen necesitandolo.
const notify = vi.fn();

vi.mock('quasar', async () => {
  const actual = await vi.importActual<typeof QuasarModule>('quasar');
  return { ...actual, useQuasar: () => ({ notify }) };
});

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/fsm-executions.service', () => ({
  fetchExecutions: vi.fn(),
  fetchExecution: vi.fn(),
  resumeExecution: vi.fn(),
  discardExecution: vi.fn(),
  fetchActiveExecution: vi.fn(),
}));

// El composable alimenta tambien al canvas, que arrastra el servicio de
// flujos; mismo motivo que el mock anterior.
vi.mock('@services/workflows.service', () => ({
  fetchWorkflow: vi.fn(),
}));

const service = await import('@services/fsm-executions.service');
const resumeExecution = vi.mocked(service.resumeExecution);

const EXECUTION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const buildPaused = (overrides: Partial<FlowPausedEvent> = {}): FlowPausedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:30:00.000Z',
  activeCursor: 'nodo_ia',
  severity: 'GRAVE',
  errorMessage: 'La plantilla aun trae marcadores',
  logFilePath: '/logs/execution.log',
  flowName: 'NOTIWEB Licitaciones',
  nodeType: 'PROCESADOR_IA',
  errorCode: 'ERR_TEMPLATE_PENDING_VARS',
  attempts: 3,
  errorDetail: 'Causa raiz: el proveedor devolvio 503.',
  ...overrides,
});

const buildDiscarded = (overrides: Partial<FlowDiscardedEvent> = {}): FlowDiscardedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:45:00.000Z',
  discardedBy: 'practicas@unuware.com',
  lastCursor: 'nodo_ia',
  workflowDeactivated: true,
  ...overrides,
});

const buildCompleted = (overrides: Partial<FlowCompletedEvent> = {}): FlowCompletedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:50:00.000Z',
  finalState: ExecutionState.EXITOSO,
  flowName: 'NOTIWEB Licitaciones',
  ...overrides,
});

const buildResumed = (overrides: Partial<FlowResumedEvent> = {}): FlowResumedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:40:00.000Z',
  activeCursor: 'nodo_ia',
  resumedBy: 'practicas@unuware.com',
  ...overrides,
});

const buildNodeError = (overrides: Partial<NodeErrorEvent> = {}): NodeErrorEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:35:00.000Z',
  nodeId: 'nodo_ia',
  severity: 'URGENTE',
  errorCode: 'ERR_TEMPLATE_PENDING_VARS',
  errorMessage: 'Faltan variables',
  logFilePath: '/logs/execution.log',
  attempt: 2,
  ...overrides,
});

/** Monta un anfitrion minimo: `useQuasar` y los hooks exigen componente vivo. */
const mountHost = (): ReturnType<typeof mount> =>
  mount(
    defineComponent({
      setup() {
        useExecutionSocket();
        return () => h('div');
      },
    }),
  );

/** Ultimas opciones entregadas a `notify`, ya tipadas. */
const lastNotifyOptions = (): QNotifyCreateOptions =>
  notify.mock.calls.at(-1)?.[0] as QNotifyCreateOptions;

describe('useExecutionSocket', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    registered = null;
    notify.mockClear();
    unsubscribe.mockClear();
    resumeExecution.mockReset();
  });

  it('deberia avisar con un toast persistente y accionable al pausarse un flujo', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onFlowPaused?.(buildPaused());

    // Assert
    expect(notify).toHaveBeenCalledTimes(1);

    const options = lastNotifyOptions();
    expect(options.type).toBe('warning');
    expect(options.icon).toBe('pause_circle');
    // `timeout: 0` es el contrato del aviso accionable: si se desvaneciese, el
    // reintento dependeria de haber estado mirando la pantalla.
    expect(options.timeout).toBe(0);
    expect(options.multiLine).toBe(true);
    expect(options.classes).toContain('pd-accent-grave');

    // El desglose completo, que es lo que distingue este aviso de un «algo
    // fallo»: nombre del flujo, nodo CON su tipo, severidad, codigo y mensaje.
    // Sin el tipo y el codigo, el operador sabe que hay un problema pero no a
    // que pantalla ir.
    expect(options.message).toContain('NOTIWEB Licitaciones');
    expect(options.message).toContain('nodo_ia');
    expect(options.message).toContain('PROCESADOR_IA');
    expect(options.caption).toContain('GRAVE');
    expect(options.caption).toContain('ERR_TEMPLATE_PENDING_VARS');
    expect(options.caption).toContain('La plantilla aun trae marcadores');

    expect(options.actions).toHaveLength(2);
  });

  it('deberia caer al identificador abreviado cuando la pausa no trae nombre de flujo', () => {
    // Arrange
    mountHost();

    // Act. `flowName` solo llega si quien despacho paso el nombre al motor: su
    // ausencia es un caso real, no defensivo.
    // Las claves se QUITAN en vez de pasarse como `undefined`: con
    // `exactOptionalPropertyTypes` no son lo mismo, y el evento real
    // sencillamente no las trae.
    const complete = buildPaused();
    const withoutNames: FlowPausedEvent = {
      executionId: complete.executionId,
      flowId: complete.flowId,
      emittedAt: complete.emittedAt,
      activeCursor: complete.activeCursor,
      errorMessage: 'El proveedor devolvio 503',
    };

    registered?.onFlowPaused?.(withoutNames);

    // Assert
    const options = lastNotifyOptions();
    expect(options.message).toContain(FLOW_ID.slice(0, 8));
    // Sin tipo de nodo no se inventa ningun parentesis vacio.
    expect(options.message).not.toContain('()');
  });

  it('deberia reanudar la ejecucion al pulsar la accion del toast (CU-09)', async () => {
    // Arrange
    resumeExecution.mockResolvedValue({
      executionId: EXECUTION_ID,
      workflowId: FLOW_ID,
      status: 'EN_PROCESO',
      activeCursor: 'nodo_ia',
      context: {},
    } as Awaited<ReturnType<typeof service.resumeExecution>>);

    mountHost();
    registered?.onFlowPaused?.(buildPaused());

    const [resumeAction] = lastNotifyOptions().actions ?? [];

    // Act
    (resumeAction?.handler as () => void)();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));

    // Assert: la cadena llega hasta el servicio REST, no se queda en el store.
    // El segundo argumento va `undefined`: desde el aviso se reanuda siempre
    // desde el cursor persistido; elegir paso es cosa del canvas.
    expect(resumeExecution).toHaveBeenCalledWith(EXECUTION_ID, undefined);
    expect(lastNotifyOptions().type).toBe('positive');
  });

  it('deberia avisar en negativo cuando la reanudacion falla', async () => {
    // Arrange: el store propaga la excepcion; el mensaje lo decide el consumidor.
    resumeExecution.mockRejectedValue(new Error('La ejecucion ya no esta PAUSADO'));

    mountHost();
    registered?.onFlowPaused?.(buildPaused());

    const [resumeAction] = lastNotifyOptions().actions ?? [];

    // Act
    (resumeAction?.handler as () => void)();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));

    // Assert
    const options = lastNotifyOptions();
    expect(options.type).toBe('negative');
    expect(options.caption).toBe('La ejecucion ya no esta PAUSADO');
  });

  it('deberia avisar en positivo al reanudarse el flujo', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onFlowResumed?.(buildResumed());

    // Assert
    expect(lastNotifyOptions().type).toBe('positive');
  });

  it('deberia avisar de un fallo de nodo GRAVE o URGENTE', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onNodeError?.(buildNodeError({ severity: 'GRAVE' }));

    // Assert
    const options = lastNotifyOptions();
    expect(options.type).toBe('negative');
    expect(options.message).toContain('nodo_ia');
    expect(options.caption).toContain('Intento 2');
    expect(options.caption).toContain('ERR_TEMPLATE_PENDING_VARS');
  });

  it('NO deberia avisar de un fallo de nodo LEVE', () => {
    // Arrange: un LEVE lo emite un nodo que va a reintentar; el flujo sigue.
    mountHost();

    // Act
    registered?.onNodeError?.(buildNodeError({ severity: 'LEVE' }));

    // Assert
    expect(notify).not.toHaveBeenCalled();
  });

  it('deberia retirar los listeners al desmontarse el anfitrion', () => {
    // Arrange
    const wrapper = mountHost();

    // Act
    wrapper.unmount();

    // Assert
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('deberia felicitar en positivo al completarse un flujo con exito', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onFlowCompleted?.(buildCompleted());

    // Assert
    const options = lastNotifyOptions();
    expect(options.type).toBe('positive');
    expect(options.message).toContain('NOTIWEB Licitaciones');
  });

  it('NO deberia pintar como exito un cierre OMITIDO', () => {
    // Arrange. Un OMITIDO es un buzon vacio: en verde haria creer que se
    // publico algo, y en rojo mandaria a investigar una ejecucion que funciono.
    mountHost();

    // Act
    registered?.onFlowCompleted?.(buildCompleted({ finalState: ExecutionState.OMITIDO }));

    // Assert
    expect(lastNotifyOptions().type).toBe('info');
  });

  it('deberia avisar en negativo del cierre FALLIDO con su motivo', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onFlowCompleted?.(
      buildCompleted({
        finalState: ExecutionState.FALLIDO,
        failureReason: 'El nodo "nodo_ia" fallo (URGENTE)',
      }),
    );

    // Assert
    const options = lastNotifyOptions();
    expect(options.type).toBe('negative');
    expect(options.caption).toContain('El nodo "nodo_ia" fallo (URGENTE)');
  });

  it('deberia avisar del descarte indicando que el flujo queda inactivo', () => {
    // Arrange
    mountHost();

    // Act
    registered?.onFlowDiscarded?.(buildDiscarded());

    // Assert
    const options = lastNotifyOptions();
    expect(options.type).toBe('info');
    expect(options.message).toContain('nodo_ia');
    expect(options.caption).toContain('inactivo');
  });
  it('deberia desglosar los intentos agotados en el aviso de pausa', () => {
    // Arrange. Es el dato que decide si reanudar ahora mismo sirve de algo: un
    // fallo al primer intento invita a reintentar, y uno tras agotar tres dice
    // que el problema esta en el otro extremo.
    mountHost();

    // Act
    registered?.onFlowPaused?.(buildPaused());

    // Assert
    const options = lastNotifyOptions();
    expect(options.message).toContain('3 intentos');
    expect(options.caption).toContain('Causa raiz: el proveedor devolvio 503.');
  });

  it('NO deberia anunciar los intentos cuando solo hubo uno', () => {
    // Arrange. Un unico intento es el caso normal; el distintivo solo sirve
    // para avisar de lo contrario, y ponerlo siempre lo volveria invisible.
    mountHost();

    // Act
    registered?.onFlowPaused?.(buildPaused({ attempts: 1 }));

    // Assert
    expect(lastNotifyOptions().message).not.toContain('intentos');
  });

  it('deberia desvanecer el aviso de exito, que no lleva ninguna accion', () => {
    // Arrange. A diferencia de la pausa, no hay nada que el operador deba poder
    // pulsar mas tarde, asi que un aviso permanente solo acumularia ruido.
    mountHost();

    // Act
    registered?.onFlowCompleted?.(buildCompleted());

    // Assert
    const options = lastNotifyOptions();
    expect(options.timeout).toBe(5000);
    expect(options.icon).toBe('check_circle');
  });
});
