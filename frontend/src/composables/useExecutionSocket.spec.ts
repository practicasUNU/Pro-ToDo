// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';

import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useExecutionSocket } from './useExecutionSocket';

import type {
  ExecutionEventHandlers,
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
}));

const service = await import('@services/fsm-executions.service');
const resumeExecution = vi.mocked(service.resumeExecution);

const EXECUTION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FLOW_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

const buildPaused = (
  overrides: Partial<FlowPausedEvent> = {},
): FlowPausedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:30:00.000Z',
  activeCursor: 'nodo_ia',
  severity: 'GRAVE',
  errorMessage: 'La plantilla aun trae marcadores',
  logFilePath: '/logs/execution.log',
  ...overrides,
});

const buildResumed = (
  overrides: Partial<FlowResumedEvent> = {},
): FlowResumedEvent => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  emittedAt: '2026-10-10T07:40:00.000Z',
  activeCursor: 'nodo_ia',
  resumedBy: 'practicas@unuware.com',
  ...overrides,
});

const buildNodeError = (
  overrides: Partial<NodeErrorEvent> = {},
): NodeErrorEvent => ({
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
    expect(options.caption).toContain('nodo_ia');
    expect(options.actions).toHaveLength(2);
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
    expect(resumeExecution).toHaveBeenCalledWith(EXECUTION_ID);
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
});
