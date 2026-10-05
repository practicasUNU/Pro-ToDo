// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QIcon, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import PostIaSanitizerConfig from '@components/nodes/PostIaSanitizerConfig.vue';
import { usePostIaSanitizerStore } from '@stores/nodes/post-ia-sanitizer.store';

import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

const NODE_ID = 'nodo_escudo';

/**
 * Componentes de Quasar usados por el configurador.
 *
 * Se registran a mano porque el plugin `Quasar` instala directivas y plugins
 * pero NO componentes.
 */
const QUASAR_COMPONENTS = { QBanner, QIcon, QSelect };

const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'rendered_html',
    nodeType: NodeType.MAPEADOR_PLANTILLA,
    fields: [{ name: 'compiled_markup', type: 'text' }],
  },
  {
    namespace: 'llm_response',
    nodeType: NodeType.PROCESADOR_IA,
    fields: [
      { name: 'headline', type: 'text' },
      { name: 'filled_markup', type: 'text' },
    ],
  },
];

const mountComponent = (): ReturnType<typeof mount> =>
  mount(PostIaSanitizerConfig, {
    props: { nodeId: NODE_ID },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

/** El control de un campo, localizado por el `data-test` de su CONTENEDOR. */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('PostIaSanitizerConfig · configurador del nodo ESCUDO_POST_IA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia montar la seccion con el nodeId recibido', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert: es el contrato uniforme del nodo (§3.1): el anfitrion pasa
      //    `nodeId` y nada mas.
      expect(wrapper.attributes('data-node-id')).toBe(NODE_ID);
    });

    it('1.2 deberia explicar que hace el nodo antes de pedir nada', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(wrapper.get('[data-test="shield-notice"]').text()).toContain('ultima barrera');
    });
  });

  describe('2. Selectores cerrados (Poka-Yoke §4)', () => {
    it('2.1 deberia deshabilitar el origen mientras no hay contexto', () => {
      // 1. Arrange & 2. Act: sin pasos anteriores no hay nada honesto que
      //    ofrecer, y un campo abierto invitaria a teclear una ruta inexistente.
      const wrapper = mountComponent();

      // 3. Assert
      expect(selectByField(wrapper, 'source-namespace-field').props('disable')).toBe(true);
      expect(selectByField(wrapper, 'source-field-field').props('disable')).toBe(true);
    });

    it('2.2 deberia ofrecer solo los namespaces de los pasos anteriores', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);

      // 2. Act
      store.setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 3. Assert
      expect(selectByField(wrapper, 'source-namespace-field').props('options')).toEqual([
        'rendered_html',
        'llm_response',
      ]);
    });

    it('2.3 deberia ofrecer los campos del namespace elegido', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);
      store.setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 2. Act & 3. Assert: el defecto es `llm_response`, asi que el segundo
      //    selector ofrece sus campos y no los del mapeador.
      expect(selectByField(wrapper, 'source-field-field').props('options')).toEqual([
        'headline',
        'filled_markup',
      ]);
    });

    it('2.4 deberia ofrecer la lista blanca real del saneador', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert: cerrada contra la lista del backend. Con entrada libre, el
      //    operador descubriria ERR_POST_IA_UNSUPPORTED_TAGS al guardar el flujo.
      const options = selectByField(wrapper, 'allowed-tags-field').props(
        'options',
      ) as readonly string[];

      expect(options).toContain('h1');
      expect(options).toContain('img');
      expect(options).not.toContain('script');
    });
  });

  describe('3. Enlace con el store', () => {
    it('3.1 deberia actualizar el store al cambiar el namespace', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);
      store.setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 2. Act: se emite el evento del contrato, que es lo que el componente
      //    escucha; no se simula el teclado.
      await selectByField(wrapper, 'source-namespace-field').vm.$emit(
        'update:model-value',
        'rendered_html',
      );

      // 3. Assert: el componente no guarda estado propio (regla §5).
      expect(store.config.sourceNamespace).toBe('rendered_html');
    });

    it('3.2 deberia actualizar el store al anadir selectores', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);

      // 2. Act
      await selectByField(wrapper, 'required-selectors-field').vm.$emit('update:model-value', [
        'h1.titular',
      ]);

      // 3. Assert
      expect(store.config.requiredSelectors).toEqual(['h1.titular']);
    });

    it('3.3 deberia confirmar al perder el foco lo tecleado y no confirmado', async () => {
      // 1. Arrange: QSelect solo emite al confirmar con Enter, asi que sin esto
      //    un selector escrito se pierde al guardar mientras sigue en pantalla.
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);
      const select = selectByField(wrapper, 'required-selectors-field');

      // 2. Act
      await select.vm.$emit('input-value', 'div.cuerpo');
      await select.vm.$emit('blur');

      // 3. Assert
      expect(store.config.requiredSelectors).toEqual(['div.cuerpo']);
    });
  });

  describe('4. Avisos', () => {
    it('4.1 deberia pintar los avisos que levanta el store', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);

      // 2. Act: sin mapeador por delante, el escudo no tendra markup que auditar.
      store.setAvailableUpstreamContext([UPSTREAM[1] as UpstreamNamespace]);
      await wrapper.vm.$nextTick();

      // 3. Assert
      const warnings = wrapper.findAll('[data-test="config-warning"]');

      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings.map((item) => item.text()).join(' ')).toContain('MAPEADOR_PLANTILLA');
    });

    it('4.2 deberia senalar un namespace guardado que ya no existe', async () => {
      // 1. Arrange
      const wrapper = mountComponent();
      const store = usePostIaSanitizerStore(NODE_ID);
      store.setAvailableUpstreamContext(UPSTREAM);

      // 2. Act
      store.updateConfig({ sourceNamespace: 'ocr_result' });
      await wrapper.vm.$nextTick();

      // 3. Assert: no se borra en silencio, se nombra para que el operador decida.
      expect(wrapper.get('[data-test="unlisted-namespace"]').text()).toContain('ocr_result');
    });
  });
});
