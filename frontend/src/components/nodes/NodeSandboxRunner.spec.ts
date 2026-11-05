// @vitest-environment happy-dom
import { createPinia, setActivePinia } from 'pinia';
import { Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushPromises, mount } from '@vue/test-utils';

// Se dobla `useQuasar`: el plugin real llega tarde al espia (memoria del
// proyecto sobre `Dialog.create`).
const notify = vi.fn();
const onOk = vi.fn();
const dialog = vi.fn(() => ({ onOk }));

vi.mock('quasar', async () => {
  const actual = await vi.importActual<typeof QuasarModule>('quasar');

  return { ...actual, useQuasar: () => ({ notify, dialog }) };
});

vi.mock('@services/node-sandbox.service', () => ({
  runNodeSandbox: vi.fn(),
}));

// El store de sesion arrastra el servicio de autenticacion, y con el
// `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

import { runNodeSandbox } from '@services/node-sandbox.service';
import { useSessionStore } from '@stores/session.store';

import NodeSandboxRunner from './NodeSandboxRunner.vue';

import { NodeType } from '@/types/pipeline';
import { UserRole } from '@/types/user';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type * as QuasarModule from 'quasar';

const UPSTREAM = [
  { namespace: 'parsed_email', fields: [{ name: 'clean_title', type: 'text' }] },
] as unknown as readonly UpstreamNamespace[];

const signIn = (role: UserRole): void => {
  useSessionStore().user = { id: 'u-1', email: 'usuario@unuware.com', role };
};

const mountRunner = (nodeType: NodeType) =>
  mount(NodeSandboxRunner, {
    props: { nodeType, params: { a: 1 }, isConfigValid: true, upstream: UPSTREAM },
    global: { plugins: [Quasar] },
  });

describe('NodeSandboxRunner', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(runNodeSandbox).mockResolvedValue({
      success: true,
      data: { statusCode: 200 },
      durationMs: 12,
    });
  });

  it('1.1 NO deberia ofrecer la prueba de IA a un EDITOR', () => {
    // 1. Arrange
    signIn(UserRole.EDITOR);

    // 2. Act
    const wrapper = mountRunner(NodeType.PROCESADOR_IA);

    // 3. Assert
    expect(wrapper.find('[data-test="sandbox-runner"]').exists()).toBe(false);
  });

  it('1.2 deberia ofrecer la prueba del destino HTTP a un EDITOR y lanzarla sin confirmar', async () => {
    // 1. Arrange
    signIn(UserRole.EDITOR);
    const wrapper = mountRunner(NodeType.DESTINO_HTTP_GENERICO);

    // 2. Act
    await wrapper.get('[data-test="sandbox-run"]').trigger('click');
    await flushPromises();

    // 3. Assert: los datos de ejemplo salen de los namespaces simulados.
    expect(dialog).not.toHaveBeenCalled();
    expect(runNodeSandbox).toHaveBeenCalledWith({
      nodeType: NodeType.DESTINO_HTTP_GENERICO,
      params: { a: 1 },
      upstreamContext: { parsed_email: { clean_title: 'Texto de ejemplo para clean_title' } },
    });
    expect(wrapper.get('[data-test="sandbox-result"]').text()).toContain('Exito');
  });

  it('1.3 deberia pedir confirmacion del coste antes de una prueba de IA', async () => {
    // 1. Arrange
    signIn(UserRole.ADMIN);
    const wrapper = mountRunner(NodeType.PROCESADOR_IA);

    // 2. Act
    await wrapper.get('[data-test="sandbox-run"]').trigger('click');

    // 3. Assert: nada se factura hasta aceptar.
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(runNodeSandbox).not.toHaveBeenCalled();
  });
});
