// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en `WebScraperConfig.spec.ts`: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, flushPromises, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QBtn, QIcon, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateMapperConfig from '@components/nodes/TemplateMapperConfig.vue';
import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';

import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { HtmlTemplate } from '@/types/html-template';

// Sin esto se cargaria `@boot/axios`, y ademas el componente no debe tocar la
// red ni en pruebas: todo lo pide por su store.
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
}));

// Los dos dialogos que el componente importa arrastran `templates.store`, y con
// el la frontera HTTP del gestor de plantillas. Se corta aqui: `stubs` sustituye
// el render, pero no evita el import estatico ni la carga de `@boot/axios`, que
// necesita el entorno de Quasar.
// El explorador de variables del dialogo consume el catalogo por su store, que
// tambien cuelga de `@boot/axios`.
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn().mockResolvedValue([]),
}));

vi.mock('@services/templates.service', () => ({
  fetchTemplates: vi.fn(),
  fetchTemplateById: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  previewTemplate: vi.fn(),
}));

const templateMapperService = await import('@services/nodes/template-mapper.service');
const fetchSelectableTemplates = vi.mocked(templateMapperService.fetchSelectableTemplates);

const NODE_ID = 'nodo_mapeador';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

/** Contexto que dejarian un TRIGGER_IMAP y un PARSER_PRE_IA aguas arriba. */
const UPSTREAM: UpstreamNamespace[] = [
  {
    namespace: 'raw_email',
    nodeType: NodeType.TRIGGER_IMAP,
    fields: [{ name: 'subject', type: 'text' }],
  },
  {
    namespace: 'parsed_email',
    nodeType: NodeType.PARSER_PRE_IA,
    fields: [{ name: 'clean_title', type: 'text' }],
  },
];

const buildTemplate = (requiredVariables: string[]): HtmlTemplate => ({
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: null,
  htmlContent: '<h1>x</h1>',
  requiredVariables,
  createdById: '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60',
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/**
 * Componentes de Quasar que usa el configurador.
 *
 * Se registran a mano porque el plugin `Quasar` instala directivas y plugins
 * pero NO componentes: sin esto `<q-select>` seria una etiqueta desconocida y la
 * prueba 1.1 pasaria por el motivo equivocado.
 */
const QUASAR_COMPONENTS = {
  QBanner,
  QBtn,
  QIcon,
  QSelect,
};

/**
 * Los dos dialogos se sustituyen por stubs, y solo ellos.
 *
 * No estan bajo prueba, y montarlos de verdad arrastraria CodeMirror y el store
 * de plantillas —con su propia frontera HTTP— dentro de un spec que va del
 * configurador del nodo. Los componentes de Quasar si se montan REALES: con
 * stubs, la prueba 1.1 aseveraria sobre el doble que la propia prueba declara.
 */
// El doble declara `upstreamContext` aunque el componente real ya no la tenga:
// es justamente lo que permite afirmar que el configurador NO la pasa. Sin la
// prop declarada, `props('upstreamContext')` saldria `undefined` tanto si se
// pasa como si no, y la prueba 3.2 no probaria nada.
const TemplateEditorDialogStub = defineComponent({
  name: 'TemplateEditorDialog',
  props: { upstreamContext: { type: Array, default: undefined } },
  template: '<div data-test="editor-dialog-stub" />',
});

const DIALOG_STUBS = {
  TemplateEditorDialog: TemplateEditorDialogStub,
  TemplatePreviewDialog: true,
};

const buildStore = (
  requiredVariables: string[],
  context: UpstreamNamespace[],
): ReturnType<typeof useTemplateMapperStore> => {
  const store = useTemplateMapperStore(NODE_ID);
  const template = buildTemplate(requiredVariables);

  // Tambien se ceba el servicio: el componente recarga el catalogo en su
  // `onMounted`, asi que sin esto la respuesta vacia del mock borraria la
  // plantilla recien sembrada y `selectedTemplate` quedaria en null.
  fetchSelectableTemplates.mockResolvedValue([template]);

  store.availableTemplates = [template];
  store.setTemplateId(TEMPLATE_ID);
  store.setAvailableUpstreamContext(context);

  return store;
};

const mountComponent = (): ReturnType<typeof mount> =>
  mount(TemplateMapperConfig, {
    props: { nodeId: NODE_ID },
    global: { plugins: [Quasar], components: QUASAR_COMPONENTS, stubs: DIALOG_STUBS },
  });

/**
 * El `QSelect` de un campo, localizado por el `data-test` de su CONTENEDOR.
 *
 * No se busca el atributo en el propio selector: Quasar lo derrama sobre un div
 * interno (`.q-field__native`) y no sobre la raiz del componente, asi que
 * `findComponent('[data-test=...]')` no encuentra nada. Y tampoco por posicion,
 * que se rompe al reordenar el formulario.
 */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('TemplateMapperConfig · configurador del nodo MAPEADOR_PLANTILLA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchSelectableTemplates.mockResolvedValue([]);
  });

  describe('1. Poka-Yoke de los selectores', () => {
    it('1.1 deberia ofrecer el namespace de salida como lista cerrada', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      const select = selectByField(wrapper, 'output-namespace-field');

      // 3. Assert: era un campo de texto libre sobre una lista CERRADA, y una
      //    mayuscula o un guion ahi eran un 400 al guardar el flujo entero.
      expect(select.exists()).toBe(true);
      expect(select.props('options')).toContain('rendered_html');
      expect(select.props('useInput')).toBeFalsy();
    });
  });

  describe('2. Avisos no bloqueantes', () => {
    it('2.1 NO deberia bloquear por variables que el flujo no provee', async () => {
      // 1. Arrange: PRUEBA DE REGRESION del banner suprimido. El nodo ya no
      //    interpola, asi que el contrato plantilla<->topologia dejo de existir.
      const store = buildStore(['parsed_email.clean_body'], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      await flushPromises();

      // 3. Assert
      expect(wrapper.find('[data-test="broken-contract-banner"]').exists()).toBe(false);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 deberia avisar de la plantilla que aun trae marcadores', async () => {
      // 1. Arrange
      buildStore(['parsed_email.clean_title'], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      await flushPromises();

      // 3. Assert
      const warning = wrapper.find('[data-test="template-mapper-warning"]');
      expect(warning.exists()).toBe(true);
      expect(warning.text()).toContain('parsed_email.clean_title');
    });

    it('2.3 no deberia avisar de nada con una plantilla esqueleto', async () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      await flushPromises();

      // 3. Assert
      expect(wrapper.find('[data-test="template-mapper-warning"]').exists()).toBe(false);
    });
  });

  describe('3. Aislamiento de capas', () => {
    it('3.1 deberia pedir las plantillas por el store y nada mas', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      mountComponent();

      // 3. Assert: la unica llamada del montaje, y a traves del store.
      expect(fetchSelectableTemplates).toHaveBeenCalledTimes(1);
    });

    it('3.2 NO deberia trasladar el contexto del flujo al editor de plantillas', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const editor = mountComponent().findComponent(TemplateEditorDialogStub);

      // 3. Assert: el editor dejo de ofrecer un insertador de marcadores, asi
      //    que no hay ninguna ruta `{{ns.campo}}` que componer. Una plantilla
      //    de este nodo se estructura con selectores CSS vacios y la rellena el
      //    PROCESADOR_IA de detras; pasarle un contexto que nadie lee seria
      //    sugerir que todavia se interpola aqui.
      expect(editor.props('upstreamContext')).toBeUndefined();
    });

    it('3.3 deberia montar la seccion con el nodeId recibido', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(wrapper.attributes('data-node-id')).toBe(NODE_ID);
    });
  });
});
