// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, igual que en `WebScraperConfig.spec.ts`: los specs de
// store no necesitan DOM y arrancan mas rapido sin el.
import { config, mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  QBtn,
  QChip,
  QIcon,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QTooltip,
  Quasar,
} from 'quasar';
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
  compilePreview: vi.fn(),
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
  QBtn,
  QChip,
  QIcon,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QTooltip,
};

/**
 * Los dos dialogos se sustituyen por stubs, y solo ellos.
 *
 * No estan bajo prueba, y montarlos de verdad arrastraria CodeMirror y el store
 * de plantillas —con su propia frontera HTTP— dentro de un spec que va del
 * configurador del nodo. Los componentes de Quasar si se montan REALES: con
 * stubs, la prueba 1.1 aseveraria sobre el doble que la propia prueba declara.
 */
const TemplateEditorDialogStub = defineComponent({
  name: 'TemplateEditorDialog',
  props: { upstreamContext: { type: Array, default: () => [] } },
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

  store.availableTemplates = [buildTemplate(requiredVariables)];
  store.setTemplateId(TEMPLATE_ID);
  store.setAvailableUpstreamNamespaces(context.map(({ namespace }) => namespace));
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

    it('1.2 deberia ofrecer una opcion por campo publicado aguas arriba', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      const options = selectByField(wrapper, 'upstream-variables-field').props('options');

      // 3. Assert: el marcador viaja como `value`, listo para pegarlo.
      expect(options).toEqual([
        {
          label: 'subject (text)',
          value: '{{raw_email.subject}}',
          group: 'raw_email (TRIGGER_IMAP)',
        },
        {
          label: 'clean_title (text)',
          value: '{{parsed_email.clean_title}}',
          group: 'parsed_email (PARSER_PRE_IA)',
        },
      ]);
    });

    it('1.3 deberia deshabilitar el selector de variables sin contexto', () => {
      // 1. Arrange
      buildStore([], []);

      // 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(selectByField(wrapper, 'upstream-variables-field').props('disable')).toBe(true);
    });
  });

  describe('2. Avisos y bloqueos', () => {
    it('2.1 deberia avisar sin bloquear cuando no hay variables aguas arriba', () => {
      // 1. Arrange: una plantilla estatica es legitima, asi que el aviso informa
      //    pero no puede invalidar el paso.
      const store = buildStore([], []);

      // 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(wrapper.find('[data-test="no-upstream-variables"]').exists()).toBe(true);
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 no deberia avisar en cuanto un paso anterior publique campos', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(wrapper.find('[data-test="no-upstream-variables"]').exists()).toBe(false);
    });

    it('2.3 deberia nombrar la RUTA COMPLETA cuando falla el campo, no el namespace', () => {
      // 1. Arrange: `parsed_email` esta aguas arriba, pero no publica
      //    `clean_body`. Antes esto pasaba por bueno y reventaba en ejecucion.
      const store = buildStore(['parsed_email.clean_body'], UPSTREAM);

      // 2. Act
      const wrapper = mountComponent();
      const banner = wrapper.find('[data-test="broken-contract-banner"]');

      // 3. Assert
      expect(banner.exists()).toBe(true);
      expect(banner.text()).toContain('parsed_email.clean_body');
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia nombrar el namespace cuando es el namespace entero el que falta', () => {
      // 1. Arrange
      buildStore(['validated_drupal_json.body'], UPSTREAM);

      // 2. Act
      const banner = mountComponent().find('[data-test="broken-contract-banner"]');

      // 3. Assert: el arreglo es otro —anadir un nodo, no corregir la plantilla—
      //    y el mensaje tiene que distinguirlo.
      expect(banner.text()).toContain('no provee los namespaces requeridos');
      expect(banner.text()).toContain('validated_drupal_json');
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

    it('3.2 deberia trasladar el contexto del flujo al editor de plantillas', () => {
      // 1. Arrange
      buildStore([], UPSTREAM);

      // 2. Act
      const editor = mountComponent().findComponent(TemplateEditorDialogStub);

      // 3. Assert: con el, los chips del editor insertan la ruta completa en vez
      //    de dejar al autor terminando el nombre del campo a mano.
      expect(editor.props('upstreamContext')).toEqual(UPSTREAM);
    });

    it('3.3 deberia montar la seccion con el nodeId recibido', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountComponent();

      // 3. Assert
      expect(wrapper.attributes('data-node-id')).toBe(NODE_ID);
    });
  });
});
