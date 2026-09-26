// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en los demas specs de componente: los de store y
// utilidades no necesitan DOM y arrancan mas rapido sin el.
import { config, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBtn, QCard, QIcon, QInput, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import TemplateEditorDialog from '@components/templates/TemplateEditorDialog.vue';

import { TEMPLATE_NAMESPACES } from '@/types/html-template';
import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { NodeCatalogEntry } from '@/types/node-catalog';

/**
 * Espias del contrato imperativo del editor.
 *
 * `vi.hoisted` porque `vi.mock` se iza por encima de las declaraciones del
 * modulo: sin esto, la factoria del doble leeria variables aun sin inicializar.
 */
const editorSpies = vi.hoisted(() => ({
  insertTextAtCursor: vi.fn(),
  setViolations: vi.fn(),
  formatDocument: vi.fn(),
}));

/**
 * `TemplateCodeEditor` se sustituye a nivel de MODULO y no con `stubs`.
 *
 * El dialogo lo carga con `defineAsyncComponent`, asi que en el arbol no hay un
 * nombre contra el que casar un stub; y montarlo de verdad arrastraria CodeMirror
 * entero a un spec que va del explorador de variables. El doble expone el mismo
 * contrato que `defineExpose` publica, que es lo unico que el dialogo consume.
 */
vi.mock('@components/templates/TemplateCodeEditor.vue', () => ({
  // Sin esta marca Vue no desenvuelve `default` y toma el modulo entero por el
  // componente, contra el que Vue Test Utils sondea exportaciones que el doble
  // no tiene.
  __esModule: true,
  default: defineComponent({
    name: 'TemplateCodeEditor',
    props: { modelValue: { type: String, default: '' } },
    setup(_props, { expose }) {
      expose(editorSpies);

      return () => h('div', { 'data-test': 'code-editor-stub' });
    },
  }),
}));

// Los dos servicios que el dialogo alcanza por sus stores cuelgan de
// `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/templates.service', () => ({
  fetchTemplates: vi.fn(),
  fetchTemplateById: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deactivateTemplate: vi.fn(),
  previewTemplate: vi.fn(),
}));

vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn(),
}));

const nodeCatalogService = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(nodeCatalogService.fetchNodeCatalog);

const PARSER_ENTRY: NodeCatalogEntry = {
  id: 'id-parser',
  code: NodeType.PARSER_PRE_IA,
  name: 'Parser pre-IA',
  category: NodeCategory.PROCESAMIENTO,
  description: null,
  implemented: true,
  outputFields: [
    { name: 'clean_title', type: 'text', description: 'Titular saneado' },
    { name: 'extracted_urls', type: 'url[]' },
  ],
};

/** Contexto que dejaria un flujo real aguas arriba del mapeador. */
const FLOW_CONTEXT: UpstreamNamespace[] = [
  {
    namespace: 'parsed_email',
    nodeType: NodeType.PARSER_PRE_IA,
    fields: PARSER_ENTRY.outputFields,
  },
];

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

const QUASAR_COMPONENTS = { QBtn, QCard, QIcon, QInput, QSelect };

/**
 * Monta el dialogo CERRADO y lo abre, que es el camino real.
 *
 * El `watch` sobre `modelValue` no es `immediate`: montar directamente abierto
 * no dispararia ni `initDraft` ni la carga del catalogo, y la prueba pasaria por
 * un estado que en la aplicacion no existe.
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

const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

const buttonByTest = (wrapper: ReturnType<typeof mount>, testId: string) =>
  wrapper.get(`[data-test="${testId}"]`).findComponent(QBtn);

describe('TemplateEditorDialog · explorador de variables', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchNodeCatalog.mockResolvedValue([PARSER_ENTRY]);
  });

  describe('1. Origen de los namespaces', () => {
    it('1.1 deberia ofrecer el catalogo global sin flujo detras', async () => {
      // 1. Arrange & 2. Act: es como lo abre el gestor de plantillas.
      const wrapper = await openDialog();
      const options = selectByField(wrapper, 'namespace-field').props('options');

      // 3. Assert: ahi no hay topologia, y la plantilla debe poder escribirse
      //    para cualquier flujo.
      expect(options).toHaveLength(TEMPLATE_NAMESPACES.length);
      expect(options).toContainEqual({ label: '_assets', value: '_assets' });
      expect(options).toContainEqual({
        label: 'parsed_email (PARSER_PRE_IA)',
        value: 'parsed_email',
      });
    });

    it('1.2 deberia restringirse al flujo cuando llega upstreamContext', async () => {
      // 1. Arrange & 2. Act: es como lo abre el nodo mapeador.
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      // 3. Assert: la prop MANDA porque es la respuesta mas especifica.
      expect(selectByField(wrapper, 'namespace-field').props('options')).toEqual([
        { label: 'parsed_email (PARSER_PRE_IA)', value: 'parsed_email' },
      ]);
    });

    it('1.3 deberia pedir el catalogo AL ABRIR y una sola vez', async () => {
      // 1. Arrange & 2. Act
      await openDialog();

      // 3. Assert: memoizada en el store, asi que si el asistente ya lo cargo no
      //    cuesta una peticion.
      expect(fetchNodeCatalog).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. Seleccion en dos pasos', () => {
    it('2.1 deberia mantener el campo deshabilitado hasta elegir origen', async () => {
      // 1. Arrange & 2. Act
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      // 3. Assert
      expect(selectByField(wrapper, 'variable-field').props('disable')).toBe(true);
    });

    it('2.2 deberia ofrecer los campos del origen elegido', async () => {
      // 1. Arrange
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      // 2. Act
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await flushPromises();

      // 3. Assert
      const field = selectByField(wrapper, 'variable-field');
      expect(field.props('disable')).toBe(false);
      expect(field.props('options')).toEqual(PARSER_ENTRY.outputFields);
    });

    it('2.3 deberia limpiar el campo al cambiar de origen', async () => {
      // 1. Arrange: dejarlo compuesto para ver que se deshace.
      const wrapper = await openDialog();
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await flushPromises();
      selectByField(wrapper, 'variable-field').vm.$emit(
        'update:modelValue',
        PARSER_ENTRY.outputFields[0],
      );
      await flushPromises();
      expect(wrapper.find('[data-test="token-detail"]').exists()).toBe(true);

      // 2. Act
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'raw_email');
      await flushPromises();

      // 3. Assert: el campo pertenecia al origen anterior; conservarlo compondria
      //    un marcador que mezcla dos namespaces.
      expect(wrapper.find('[data-test="token-detail"]').exists()).toBe(false);
    });
  });

  describe('3. Tarjeta de detalle y acciones', () => {
    /** Deja el explorador con `{{parsed_email.clean_title}}` compuesto. */
    const composeToken = async (): Promise<ReturnType<typeof mount>> => {
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await flushPromises();
      selectByField(wrapper, 'variable-field').vm.$emit(
        'update:modelValue',
        PARSER_ENTRY.outputFields[0],
      );
      await flushPromises();

      return wrapper;
    };

    it('3.1 deberia mostrar el token, su tipo y su descripcion', async () => {
      // 1. Arrange & 2. Act
      const detail = (await composeToken()).get('[data-test="token-detail"]');

      // 3. Assert
      expect(detail.text()).toContain('{{parsed_email.clean_title}}');
      expect(detail.text()).toContain('text');
      expect(detail.text()).toContain('Titular saneado');
    });

    it('3.2 deberia deshabilitar ambos botones sin la eleccion completa', async () => {
      // 1. Arrange & 2. Act
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      // 3. Assert
      expect(buttonByTest(wrapper, 'copy-token').props('disable')).toBe(true);
      expect(buttonByTest(wrapper, 'insert-token').props('disable')).toBe(true);
    });

    it('3.3 deberia habilitarlos con el token compuesto', async () => {
      // 1. Arrange & 2. Act
      const wrapper = await composeToken();

      // 3. Assert
      expect(buttonByTest(wrapper, 'copy-token').props('disable')).toBe(false);
      expect(buttonByTest(wrapper, 'insert-token').props('disable')).toBe(false);
    });

    it('3.4 deberia insertar la ruta COMPLETA en el cursor del editor', async () => {
      // 1. Arrange
      const wrapper = await composeToken();

      // 2. Act
      await buttonByTest(wrapper, 'insert-token').trigger('click');

      // 3. Assert: offset 0, el caret detras. La version de chips insertaba
      //    `{{parsed_email.}}` y retrocedia dos para que el autor escribiera el
      //    campo, que es la errata que el explorador elimina.
      expect(editorSpies.insertTextAtCursor).toHaveBeenCalledWith(
        '{{parsed_email.clean_title}}',
        0,
      );
    });

    it('3.5 no deberia tocar el editor sin token compuesto', async () => {
      // 1. Arrange
      const wrapper = await openDialog({ upstreamContext: FLOW_CONTEXT });

      // 2. Act: el boton esta deshabilitado, pero la guarda es del manejador.
      await buttonByTest(wrapper, 'insert-token').trigger('click');

      // 3. Assert
      expect(editorSpies.insertTextAtCursor).not.toHaveBeenCalled();
    });
  });
});
