// @vitest-environment happy-dom
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Se dobla el servicio del socket entero: lo que se prueba es la DECISION de
// expulsar, no el transporte.
vi.mock('@services/socket-events.service', () => ({
  subscribeToSessionEvents: vi.fn(),
}));

// El store alcanza `@boot/axios` a traves de su servicio; el doble solo rompe
// esa cadena de importacion.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn().mockResolvedValue(undefined),
}));

const replace = vi.fn().mockResolvedValue(undefined);
const currentRoute = { value: { path: '/' } };

vi.mock('vue-router', () => ({
  useRouter: () => ({ replace, currentRoute }),
}));

/**
 * Cadena del plugin de dialogo.
 *
 * `dialog()` devuelve un `DialogChainObject` cuyos `onOk`/`onDismiss` se
 * encadenan devolviendo el MISMO objeto, que ademas expone `hide`. El doble lo
 * replica: si `onOk` devolviera un objeto distinto, el `hide` del desmontaje
 * no existiria y el fallo pareceria del composable.
 */
const onOk = vi.fn((handler: () => void) => {
  void handler;
  return chain;
});
const onDismiss = vi.fn(() => chain);
const hide = vi.fn();
const chain = { onOk, onDismiss, hide };
const dialog = vi.fn(() => chain);

vi.mock('quasar', async (importOriginal) => {
  const actual = await importOriginal<QuasarModule>();

  return { ...actual, useQuasar: () => ({ dialog }) };
});

import { useForcedLogout } from '@/composables/useForcedLogout';
import { subscribeToSessionEvents } from '@services/socket-events.service';
import { useSessionStore } from '@stores/session.store';

import { UserRole } from '@/types/user';

import type * as QuasarNamespace from 'quasar';
import type { UserModifiedPayload } from '@/types/session-events';

type QuasarModule = typeof QuasarNamespace;

const USER_ID = 'c8a1f2d3-5b6e-4790-8c1d-2e3f4a5b6c7d';

const buildPayload = (
  overrides: Partial<UserModifiedPayload> = {},
): UserModifiedPayload => ({
  userId: USER_ID,
  actorEmail: 'admin@unuware.com',
  updatedFields: ['rol'],
  emittedAt: '2026-10-23T10:00:00.000Z',
  ...overrides,
});

/** Monta un anfitrion minimo y devuelve el emisor del evento. */
const buildHost = () => {
  const unsubscribe = vi.fn();
  let emit: ((payload: UserModifiedPayload) => void) | null = null;

  vi.mocked(subscribeToSessionEvents).mockImplementation((handler) => {
    emit = handler;
    return unsubscribe;
  });

  const wrapper = mount(
    defineComponent({
      setup() {
        useForcedLogout();
        return () => h('div');
      },
    }),
  );

  return {
    wrapper,
    unsubscribe,
    emit: (payload: UserModifiedPayload) => emit?.(payload),
  };
};

/** Deja en el store una sesion abierta con el usuario indicado. */
const signInAs = (id: string): void => {
  const sessionStore = useSessionStore();

  sessionStore.user = { id, email: 'usuario@unuware.com', role: UserRole.EDITOR };
};

describe('useForcedLogout', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    currentRoute.value = { path: '/' };
  });

  it('1.1 deberia abrir el modal cuando el cambio es de la cuenta propia', () => {
    // 1. Arrange 📐
    signInAs(USER_ID);
    const host = buildHost();

    // 2. Act ⚙️
    host.emit(buildPayload());

    // 3. Assert 🎯: el modal lleva autor y campos, porque un cierre anonimo es
    //    indistinguible de un fallo del sistema.
    expect(dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        componentProps: {
          actorEmail: 'admin@unuware.com',
          updatedFields: ['rol'],
        },
      }),
    );
  });

  it('1.2 NO deberia reaccionar al cambio de OTRA cuenta', () => {
    // 1. Arrange 📐: el gateway manda el evento solo a la sala de esa persona,
    //    pero el socket sobrevive a un cambio de sesion en la misma pestana, y
    //    apoyar una expulsion en una suposicion del transporte seria confiar
    //    la seguridad al reparto.
    signInAs(USER_ID);
    const host = buildHost();

    // 2. Act ⚙️
    host.emit(buildPayload({ userId: 'otra-persona' }));

    // 3. Assert 🎯
    expect(dialog).not.toHaveBeenCalled();
  });

  it('1.3 NO deberia apilar dos modales', () => {
    // 1. Arrange 📐: dos cuentas atras encimadas llamarian dos veces al cierre
    //    y la segunda navegaria sobre `/login`.
    signInAs(USER_ID);
    const host = buildHost();

    // 2. Act ⚙️
    host.emit(buildPayload());
    host.emit(buildPayload({ updatedFields: ['estado'] }));

    // 3. Assert 🎯
    expect(dialog).toHaveBeenCalledTimes(1);
  });

  it('1.4 deberia cerrar la sesion y redirigir al expirar la cuenta atras', async () => {
    // 1. Arrange 📐
    signInAs(USER_ID);
    const host = buildHost();
    host.emit(buildPayload());

    const sessionStore = useSessionStore();
    const logout = vi.spyOn(sessionStore, 'logout').mockResolvedValue(undefined);

    // 2. Act ⚙️: el modal resuelve en OK cuando la cuenta atras llega a cero.
    const confirm = onOk.mock.calls[0]?.[0];
    confirm?.();
    await Promise.resolve();

    // 3. Assert 🎯
    expect(logout).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('1.5 deberia darse de baja y cerrar el modal al desmontarse', () => {
    // 1. Arrange 📐: el plugin monta el dialogo FUERA del arbol del layout, de
    //    modo que sin el cierre explicito quedaria flotando sobre el login.
    signInAs(USER_ID);
    const host = buildHost();
    host.emit(buildPayload());

    // 2. Act ⚙️
    host.wrapper.unmount();

    // 3. Assert 🎯
    expect(host.unsubscribe).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalledTimes(1);
  });
});
