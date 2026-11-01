// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBanner,
  QBtn,
  QExpansionItem,
  QIcon,
  QInput,
  QMenu,
  QSelect,
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import AcensHttpConfig from '@components/nodes/AcensHttpConfig.vue';
import VariableInsertButton from '@components/shared/VariableInsertButton.vue';
import { useAcensHttpStore } from '@stores/nodes/acens-http.store';

import { AcensHttpMethod } from '@/types/nodes/acens-http.types';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_acens_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = {
  QBanner,
  QBtn,
  QExpansionItem,
  QIcon,
  QInput,
  QMenu,
  QSelect,
  QTooltip,
};

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(AcensHttpConfig, {
    props: { nodeId },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

describe('AcensHttpConfig.vue', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('1.1 deberia ofrecer el boton de variables en ruta y payload', () => {
    // 1. Arrange 📐 + 2. Act ⚙️
    const wrapper = mountComponent(nextNodeId());

    // 3. Assert 🎯
    expect(wrapper.findAllComponents(VariableInsertButton)).toHaveLength(2);
    expect(wrapper.find('[data-test="destination-notice"]').text()).toContain('backend/.env');
  });

  it('1.2 deberia insertar la variable en la ruta a traves del store', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);
    const store = useAcensHttpStore(nodeId);
    store.updateConfig({ endpointPath: '/campaigns/' });

    // 2. Act ⚙️
    wrapper
      .get('[data-test="endpoint-field"]')
      .findComponent(VariableInsertButton)
      .vm.$emit('insert', '{{llm_response.headline}}');
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(store.config.endpointPath).toBe('/campaigns/{{llm_response.headline}}');
  });

  it('1.3 deberia ocultar el payload en un GET', async () => {
    // 1. Arrange 📐
    const nodeId = nextNodeId();
    const wrapper = mountComponent(nodeId);

    // 2. Act ⚙️
    useAcensHttpStore(nodeId).updateConfig({ method: AcensHttpMethod.GET });
    await wrapper.vm.$nextTick();

    // 3. Assert 🎯
    expect(wrapper.find('[data-test="payload-field"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="bodyless-notice"]').exists()).toBe(true);
  });
});
