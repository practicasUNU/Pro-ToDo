// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO: montar un componente anfitrion exige DOM, y los specs
// de store arrancan mas rapido sin el.
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Se dobla el servicio del socket entero: lo que se prueba es QUE despierta al
// panel y que se da de baja, no el transporte.
vi.mock('@services/socket-events.service', () => ({
  subscribeToCrudMutations: vi.fn(),
  subscribeToExecutionEvents: vi.fn(),
}));

import { usePanelRefresh } from '@/composables/usePanelRefresh';
import {
  subscribeToCrudMutations,
  subscribeToExecutionEvents,
} from '@services/socket-events.service';

import type { PanelRefreshOptions } from '@/composables/usePanelRefresh';
import type { CrudMutationPayload } from '@/types/crud-events';

const buildMutation = (
  entity: CrudMutationPayload['entity'],
): CrudMutationPayload => ({
  entity,
  action: 'CREATED',
  id: 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  emittedAt: '2026-10-23T10:00:00.000Z',
});

/** Monta un anfitrion minimo y devuelve los asideros de cada suscripcion. */
const buildHost = (options: PanelRefreshOptions, reload = vi.fn()) => {
  const unsubscribeCrud = vi.fn();
  const unsubscribeExecution = vi.fn();

  let emitMutation: ((payload: CrudMutationPayload) => void) | null = null;
  let emitCompleted: (() => void) | null = null;

  vi.mocked(subscribeToCrudMutations).mockImplementation((handler) => {
    emitMutation = handler;
    return unsubscribeCrud;
  });

  vi.mocked(subscribeToExecutionEvents).mockImplementation((handlers) => {
    emitCompleted = () =>
      handlers.onFlowCompleted?.({} as Parameters<
        NonNullable<typeof handlers.onFlowCompleted>
      >[0]);
    return unsubscribeExecution;
  });

  const wrapper = mount({
    setup() {
      usePanelRefresh(reload, options);

      return () => null;
    },
  });

  return {
    wrapper,
    reload,
    unsubscribeCrud,
    unsubscribeExecution,
    emitMutation: (payload: CrudMutationPayload) => emitMutation?.(payload),
    emitCompleted: () => emitCompleted?.(),
  };
};

describe('usePanelRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1.1 deberia recargar cuando muta una entidad vigilada', () => {
    // 1. Arrange 📐
    const host = buildHost({ entities: ['audit_eventos'] });

    // 2. Act ⚙️
    host.emitMutation(buildMutation('audit_eventos'));

    // 3. Assert 🎯
    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it('1.2 NO deberia recargar por una entidad que no vigila', () => {
    // 1. Arrange 📐: un panel de auditoria no tiene por que releer su pagina
    //    porque alguien renombre una plantilla.
    const host = buildHost({ entities: ['audit_eventos'] });

    // 2. Act ⚙️
    host.emitMutation(buildMutation('templates'));

    // 3. Assert 🎯
    expect(host.reload).not.toHaveBeenCalled();
  });

  it('1.3 NO deberia suscribirse al canal CRUD si no vigila ninguna entidad', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    buildHost({ onFlowCompleted: true });

    // 3. Assert 🎯: un listener que nunca puede disparar es coste sin uso.
    expect(subscribeToCrudMutations).not.toHaveBeenCalled();
    expect(subscribeToExecutionEvents).toHaveBeenCalledTimes(1);
  });

  it('1.4 deberia recargar al terminar una ejecucion si se pidio', () => {
    // 1. Arrange 📐: las filas de telemetria se escriben durante la corrida,
    //    asi que el desenlace es el primer momento con algo que resumir.
    const host = buildHost({ onFlowCompleted: true });

    // 2. Act ⚙️
    host.emitCompleted();

    // 3. Assert 🎯
    expect(host.reload).toHaveBeenCalledTimes(1);
  });

  it('1.5 NO deberia escuchar el motor si no se pidio', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    buildHost({ entities: ['audit_eventos'] });

    // 3. Assert 🎯
    expect(subscribeToExecutionEvents).not.toHaveBeenCalled();
  });

  it('1.6 deberia darse de baja de los dos canales al desmontar', () => {
    // 1. Arrange 📐: sin la baja, cada montaje apilaria un juego mas de
    //    escuchas y un solo evento provocaria varias consultas.
    const host = buildHost({ entities: ['audit_eventos'], onFlowCompleted: true });

    // 2. Act ⚙️
    host.wrapper.unmount();

    // 3. Assert 🎯
    expect(host.unsubscribeCrud).toHaveBeenCalledTimes(1);
    expect(host.unsubscribeExecution).toHaveBeenCalledTimes(1);
  });

  it('1.7 NO deberia propagar el fallo de una recarga', async () => {
    // 1. Arrange 📐: un evento del socket no tiene a quien devolverle un
    //    rechazo. Dejarlo escapar ensuciaria la consola con un
    //    `unhandledrejection` cada vez que la red falla con el panel abierto.
    const reload = vi.fn().mockRejectedValue(new Error('503'));
    const host = buildHost({ entities: ['audit_eventos'] }, reload);

    // 2. Act ⚙️
    expect(() => host.emitMutation(buildMutation('audit_eventos'))).not.toThrow();
    await Promise.resolve();

    // 3. Assert 🎯
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
