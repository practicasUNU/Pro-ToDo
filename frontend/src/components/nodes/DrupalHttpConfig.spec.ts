// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en el resto de specs de componente: los de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QBtn, QCheckbox, QExpansionItem, QIcon, QInput, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it } from 'vitest';

import DrupalHttpConfig from '@components/nodes/DrupalHttpConfig.vue';
import { useDrupalHttpStore } from '@stores/nodes/drupal-http.store';

import { NodeType } from '@/types/pipeline';
import { DRUPAL_SANDBOX_PRESETS, DrupalOperationMode } from '@/types/nodes/drupal-http.types';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `destino_http_view_${(nodeCounter += 1)}`;

/**
 * Se registran a mano porque el plugin `Quasar` instala directivas y plugins
 * pero NO componentes.
 */
const QUASAR_COMPONENTS = { QBanner, QBtn, QCheckbox, QExpansionItem, QIcon, QInput, QSelect };

const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'raw_email',
    nodeType: NodeType.TRIGGER_IMAP,
    fields: [{ name: 'attachments', type: 'object' }],
  },
  {
    namespace: 'validated_drupal_json',
    nodeType: NodeType.ESCUDO_POST_IA,
    fields: [
      { name: 'validated_markup', type: 'text' },
      { name: 'audit_status', type: 'text' },
    ],
  },
];

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(DrupalHttpConfig, {
    props: { nodeId },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS },
  });

/**
 * El control de un campo, localizado por el `data-test` de su CONTENEDOR.
 *
 * Quasar derrama los atributos sobre un div interno, asi que marcar el propio
 * `q-select` no serviria para encontrarlo.
 */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

const inputByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QInput);

describe('DrupalHttpConfig · configurador del nodo DESTINO_HTTP', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
  });

  describe('1. Montaje', () => {
    it('1.1 deberia identificar el nodo que configura', () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);

      // 3. Assert 🎯
      expect(wrapper.get('section').attributes('data-node-id')).toBe(nodeId);
    });

    it('1.2 deberia avisar de que el nodo cierra el flujo', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: nada corre despues, y eso cambia como se lee un fallo aqui.
      expect(wrapper.get('[data-test="destination-notice"]').text()).toContain('cierra el flujo');
    });
  });

  describe('2. Secciones condicionales por modo de operacion', () => {
    it('2.1 deberia pedir titulo y resumen en CREATE_NODE', () => {
      // 1. Arrange 📐: es el modo por defecto.
      const wrapper = mountComponent(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="summary-template-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(false);
    });

    it('2.2 deberia pedir contenedor y posicion en APPEND_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.APPEND_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="container-selector-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="insert-position-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="title-template-field"]').exists()).toBe(false);
    });

    it('2.3 deberia pedir los dos identificadores y el selector en TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="target-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="destination-uuid-field"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="item-selector-field"]').exists()).toBe(true);
    });

    it('2.4 deberia ocultar el origen del markup en TRANSFER_HTML_BLOCK', async () => {
      // 1. Arrange 📐: ese modo no lee el contexto; el bloque sale del DOM
      //    remoto. Pedir un namespace que no se usa invita a configurarlo mal.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      expect(wrapper.find('[data-test="source-namespace-field"]').exists()).toBe(true);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.TRANSFER_HTML_BLOCK,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="source-namespace-field"]').exists()).toBe(false);
    });

    it('2.5 deberia advertir de la caducidad de los bytes en UPLOAD_ATTACHMENT', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({
        operationMode: DrupalOperationMode.UPLOAD_ATTACHMENT,
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="attachment-notice"]').text()).toContain('ANTES del parser');
    });
  });

  describe('3. Selectores cerrados (Poka-Yoke §4)', () => {
    it('3.1 deberia deshabilitar el origen sin contexto aguas arriba', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: ofrecer un desplegable vacio sugiere que no hay nada que
      //    elegir; deshabilitado dice que todavia no se puede.
      expect(selectByField(wrapper, 'source-namespace-field').props('disable')).toBe(true);
    });

    it('3.2 deberia ofrecer los namespaces que publican los pasos anteriores', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'source-namespace-field').props('options')).toEqual([
        'raw_email',
        'validated_drupal_json',
      ]);
    });

    it('3.3 deberia ofrecer los campos del namespace elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext(UPSTREAM);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'source-field-field').props('options')).toEqual([
        'validated_markup',
        'audit_status',
      ]);
    });

    it('3.4 deberia conservar un bundle heredado fuera del catalogo', async () => {
      // 1. Arrange 📐: vaciarlo en silencio romperia un flujo que funcionaba.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).updateConfig({ bundle: 'taxonomy_term--etiquetas' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(selectByField(wrapper, 'bundle-field').props('options')).toContain(
        'taxonomy_term--etiquetas',
      );
    });
  });

  describe('4. Enlace con el store', () => {
    it('4.1 deberia escribir el modo elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      selectByField(wrapper, 'operation-mode-field').vm.$emit(
        'update:model-value',
        DrupalOperationMode.UPLOAD_ATTACHMENT,
      );
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.operationMode).toBe(DrupalOperationMode.UPLOAD_ATTACHMENT);
    });

    it('4.2 deberia tratar un titulo en blanco como ausencia', async () => {
      // 1. Arrange 📐: el backend resuelve con `trimmedOrNull`, y mostrar como
      //    configurado lo que el motor vera vacio deja el paso en falso verde.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      inputByField(wrapper, 'title-template-field').vm.$emit('update:model-value', '   ');
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.titleTemplate).toBeNull();
      expect(store.isConfigValid).toBe(false);
    });

    it('4.3 deberia desactivar la publicacion automatica desde el acordeon', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      wrapper
        .get('[data-test="publish-status-field"]')
        .findComponent(QCheckbox)
        .vm.$emit('update:model-value', false);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(store.config.publishStatus).toBe(false);
      expect(store.toNodeParams().publishStatus).toBe(false);
    });
  });

  describe('5. Presets de sandbox', () => {
    it('5.1 deberia rellenar identificador, bundle y modo de una sola vez', async () => {
      // 1. Arrange 📐: teclear un UUID v4 a mano es el error mas caro de este
      //    formulario —un digito cambiado pasa la validacion y falla en
      //    ejecucion con un 404 de Drupal y el flujo ya PAUSADO.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-licitaciones"]').trigger('click');

      // 3. Assert 🎯
      expect(store.config.targetNodeUuid).toBe(DRUPAL_SANDBOX_PRESETS.LICITACIONES.uuid);
      expect(store.config.bundle).toBe('node--page');
      expect(store.config.operationMode).toBe(DrupalOperationMode.APPEND_HTML_BLOCK);
    });

    it('5.2 deberia cargar el panel de titulos con su propio bundle', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useDrupalHttpStore(nodeId);

      // 2. Act ⚙️
      await wrapper.get('[data-test="preset-titulos"]').trigger('click');

      // 3. Assert 🎯
      expect(store.config.targetNodeUuid).toBe(DRUPAL_SANDBOX_PRESETS.TITULOS.uuid);
      expect(store.config.bundle).toBe('node--acreditacion_evaluacion_panel');
    });
  });

  describe('6. Avisos', () => {
    it('6.1 deberia pintar los avisos que levanta el store', async () => {
      // 1. Arrange 📐: un flujo sin escudo delante no publica el namespace que
      //    este nodo lee por defecto.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useDrupalHttpStore(nodeId).setAvailableUpstreamContext([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
      ]);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const warnings = wrapper.findAll('[data-test="config-warning"]');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.text()).toContain('validated_drupal_json');
    });

    it('6.2 NO deberia pintar avisos mientras el contexto esta vacio', () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: avisar mientras carga el catalogo seria una falsa alarma
      //    en cada apertura del asistente.
      expect(wrapper.findAll('[data-test="config-warning"]')).toHaveLength(0);
    });
  });
});
