// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en los demas specs de componente: los de store y
// utilidades no necesitan DOM y arrancan mas rapido sin el.
import { config, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QBtn, QCard, QChip, QIcon, QInput, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import TemplateEditorDialog from '@components/templates/TemplateEditorDialog.vue';

/**
 * `TemplateCodeEditor` se sustituye a nivel de MODULO y no con `stubs`.
 *
 * El dialogo lo carga con `defineAsyncComponent`, asi que en el arbol no hay un
 * nombre contra el que casar un stub; y montarlo de verdad arrastraria
 * CodeMirror entero a un spec que no va del editor.
 */
vi.mock('@components/templates/TemplateCodeEditor.vue', () => ({
  // Sin esta marca Vue no desenvuelve `default` y toma el modulo entero por el
  // componente, contra el que Vue Test Utils sondea exportaciones que el doble
  // no tiene.
  __esModule: true,
  default: defineComponent({
    name: 'TemplateCodeEditor',
    props: { modelValue: { type: String, default: '' } },
    setup() {
      return () => h('div', { 'data-test': 'code-editor-stub' });
    },
  }),
}));

// El servicio cuelga de `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/templates.service', () => ({
  fetchTemplates: vi.fn(),
  fetchTemplateById: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  previewTemplate: vi.fn(),
}));

/**
 * El catalogo de nodos se dobla aunque el dialogo YA NO lo pida.
 *
 * Precisamente para poder afirmarlo: la prueba 2.2 comprueba que no se dispara
 * ninguna peticion, y sin el doble el fallo seria un error de `@boot/axios` en
 * vez de la asercion que interesa.
 */
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn(),
}));

const nodeCatalogService = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(nodeCatalogService.fetchNodeCatalog);

/**
 * `QDialog` se sustituye por un pasamuros.
 *
 * El de verdad teleporta su contenido a `document.body`, fuera del arbol que
 * `wrapper.find` recorre, y el spec no va del portal sino de lo que hay dentro.
 */
const QUASAR_STUBS = {
  QDialog: defineComponent({
    name: 'QDialog',
    setup(_props, { slots }) {
      return () => h('div', slots.default?.());
    },
  }),
};

const QUASAR_COMPONENTS = { QBanner, QBtn, QCard, QChip, QIcon, QInput, QSelect };

/**
 * Monta el dialogo CERRADO y lo abre, que es el camino real.
 *
 * El `watch` sobre `modelValue` no es `immediate`: montar directamente abierto
 * no dispararia `initDraft`, y la prueba pasaria por un estado que en la
 * aplicacion no existe.
 */
const openDialog = async (
  props: Record<string, unknown> = {},
): Promise<ReturnType<typeof mount>> => {
  const wrapper = mount(TemplateEditorDialog, {
    props: { modelValue: false, template: null, ...props },
    global: {
      plugins: [Quasar],
      components: QUASAR_COMPONENTS,
      stubs: QUASAR_STUBS,
    },
  });

  await wrapper.setProps({ modelValue: true });
  await flushPromises();

  return wrapper;
};

describe('TemplateEditorDialog · plantillas estructurales sin marcadores', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchNodeCatalog.mockResolvedValue([]);
  });

  describe('1. Aviso de estructura', () => {
    it('1.1 deberia explicar que los huecos se nombran por clase CSS', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await openDialog();

      // 3. Assert 🎯: es la unica indicacion de como se escribe una plantilla
      //    desde que el mapeador inyecta en vez de compilar.
      const notice = wrapper.get('[data-test="structure-notice"]');
      expect(notice.text()).toContain('selectores CSS');
      expect(notice.text()).toContain('ERR_TEMPLATE_PENDING_VARS');
    });
  });

  describe('2. Retirada del explorador de variables', () => {
    it('2.1 no deberia ofrecer ningun insertador de marcadores', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await openDialog();

      // 3. Assert 🎯: el MAPEADOR_PLANTILLA rechaza con
      //    ERR_TEMPLATE_PENDING_VARS cualquier plantilla que aun interpole, de
      //    modo que un boton "Insertar en plantilla" solo serviria para
      //    fabricar flujos que revientan en ejecucion, ya PAUSADOS.
      expect(wrapper.find('[data-test="variable-explorer"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="insert-token"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="namespace-field"]').exists()).toBe(false);
    });

    it('2.2 no deberia pedir el catalogo de nodos al abrir', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      await openDialog();

      // 3. Assert 🎯: la peticion existia SOLO para poblar el explorador. Con
      //    el fuera, mantenerla gastaria una llamada por cada apertura del
      //    dialogo sin que nadie lea la respuesta.
      expect(fetchNodeCatalog).not.toHaveBeenCalled();
    });
  });

  describe('3. Variables detectadas', () => {
    it('3.1 deberia seguir mostrando las de una plantilla heredada', async () => {
      // 1. Arrange 📐: una plantilla guardada antes del cambio de semantica.
      const wrapper = await openDialog({
        template: {
          id: 'tpl-1',
          name: 'Heredada',
          description: null,
          htmlContent: '<p>{{parsed_email.clean_title}}</p>',
          requiredVariables: ['parsed_email.clean_title'],
          createdById: 'user-1',
          active: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      });

      // 3. Assert 🎯: los chips son de SOLO LECTURA y se conservan a proposito.
      //    Son el unico aviso de que esa plantilla aun interpola y de que el
      //    mapeador va a rechazarla.
      expect(wrapper.text()).toContain('parsed_email.clean_title');
    });
  });
});
