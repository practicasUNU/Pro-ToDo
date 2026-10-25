// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBanner,
  QBtn,
  QExpansionItem,
  QIcon,
  QInput,
  QItem,
  QItemSection,
  QMenu,
  QSelect,
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/credentials.service', () => ({
  fetchCredentials: vi.fn(),
  fetchCredentialOptions: vi.fn(),
  createCredential: vi.fn(),
  updateCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

import HttpGenericDestinationConfig from '@components/nodes/HttpGenericDestinationConfig.vue';
import { fetchCredentialOptions } from '@services/credentials.service';
import { useHttpGenericDestinationStore } from '@stores/nodes/http-generic-destination.store';

import { CredentialAuthType } from '@/types/credential';
import {
  HttpGenericAuthType,
  HttpGenericBodyType,
  HttpGenericMethod,
} from '@/types/nodes/http-generic-destination.types';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_generico_view_${(nodeCounter += 1)}`;

const BEARER_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';

/** El plugin `Quasar` no registra componentes: se declaran a mano. */
const QUASAR_COMPONENTS = {
  QBanner,
  QBtn,
  QExpansionItem,
  QIcon,
  QInput,
  QItem,
  QItemSection,
  QMenu,
  QSelect,
  QTooltip,
};

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(HttpGenericDestinationConfig, {
    props: { nodeId },
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
    },
  });

const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('HttpGenericDestinationConfig.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.mocked(fetchCredentialOptions).mockResolvedValue([
      { id: BEARER_ID, name: 'API de becas', authType: CredentialAuthType.BEARER_TOKEN },
    ]);
  });

  it('1.1 deberia pedir las opciones de credencial al montarse', async () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    mountComponent(nextNodeId());
    await flushPromises();

    // 3. Assert 🎯
    expect(fetchCredentialOptions).toHaveBeenCalled();
  });

  it('1.2 no deberia mostrar el selector de credencial sin autenticacion', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountComponent(nextNodeId());

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="credential-field"]').exists()).toBe(false);
  });

  it('1.3 deberia ofrecer solo credenciales del tipo elegido y guardarlas en el store', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);
    await flushPromises();
    const store = useHttpGenericDestinationStore(nodeId);

    // 2. Act ⚙️
    selectByField(wrapper, 'auth-type-field').vm.$emit(
      'update:model-value',
      HttpGenericAuthType.BEARER_TOKEN,
    );
    await wrapper.vm.$nextTick();
    const credentialSelect = selectByField(wrapper, 'credential-field');
    credentialSelect.vm.$emit('update:model-value', BEARER_ID);
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(credentialSelect.props('options')).toEqual([
      { id: BEARER_ID, name: 'API de becas', authType: CredentialAuthType.BEARER_TOKEN },
    ]);
    expect(store.config.credentialId).toBe(BEARER_ID);
  });

  it('1.4 deberia deshabilitar el cuerpo y fijarlo en NONE con un GET', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);

    // 2. Act ⚙️
    selectByField(wrapper, 'method-field').vm.$emit('update:model-value', HttpGenericMethod.GET);
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(selectByField(wrapper, 'body-type-field').props('disable')).toBe(true);
    expect(useHttpGenericDestinationStore(nodeId).config.bodyType).toBe(HttpGenericBodyType.NONE);
    expect(wrapper.find('[data-test="body-template-field"]').exists()).toBe(false);
  });

  it('1.5 deberia listar los problemas de configuracion', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);

    // 2. Act ⚙️
    useHttpGenericDestinationStore(nodeId).updateConfig({ targetUrl: 'ftp://no-http' });
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(wrapper.get('[data-test="config-errors"]').text()).toContain('URL de destino');
  });
});
