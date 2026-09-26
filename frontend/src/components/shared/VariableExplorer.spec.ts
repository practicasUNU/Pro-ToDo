// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { QBtn, QSelect, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VariableExplorer from './VariableExplorer.vue';

import { NodeType } from '@/types/pipeline';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';
import type { VueWrapper } from '@vue/test-utils';

/**
 * Prueba del explorador YA EXTRAIDO de `TemplateEditorDialog`.
 *
 * Aquella suite sigue existiendo y pasando sin tocarse: es el control de que la
 * extraccion no cambio comportamiento. Esta cubre el componente por su cuenta,
 * que es donde ahora vive la logica de composicion del marcador.
 */

const CONTEXT: UpstreamNamespace[] = [
  {
    namespace: 'parsed_email',
    nodeType: NodeType.PARSER_PRE_IA,
    fields: [
      { name: 'clean_title', type: 'text', description: 'Titular saneado' },
      { name: 'extracted_urls', type: 'url[]' },
    ],
  },
  { namespace: '_assets', fields: [{ name: 'base_url', type: 'text' }] },
];

const mountExplorer = (context: readonly UpstreamNamespace[] = CONTEXT) =>
  mount(VariableExplorer, {
    props: { context },
    global: { plugins: [Quasar], components: { QBtn, QSelect } },
  });

const selectByField = (wrapper: VueWrapper, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

const buttonByTest = (wrapper: VueWrapper, testId: string) =>
  wrapper.get(`[data-test="${testId}"]`).findComponent(QBtn);

/** Elige origen y campo, que es el recorrido completo del explorador. */
const chooseVariable = async (
  wrapper: VueWrapper,
  namespace: string,
  fieldIndex = 0,
): Promise<void> => {
  selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', namespace);
  await wrapper.vm.$nextTick();

  const fields = CONTEXT.find((entry) => entry.namespace === namespace)?.fields ?? [];
  selectByField(wrapper, 'variable-field').vm.$emit('update:modelValue', fields[fieldIndex]);
  await wrapper.vm.$nextTick();
};

beforeEach(() => {
  config.global.plugins = [];
  vi.clearAllMocks();
});

describe('VariableExplorer · selector determinista de variables', () => {
  describe('1. Origenes ofrecidos', () => {
    it('1.1 deberia ofrecer solo los origenes que recibe', () => {
      // 1. Arrange & 2. Act: el componente NO filtra; de eso manda el anfitrion.
      const wrapper = mountExplorer();

      // 3. Assert
      const options = selectByField(wrapper, 'namespace-field').props('options') as {
        label: string;
      }[];

      expect(options.map(({ label }) => label)).toEqual([
        'parsed_email (PARSER_PRE_IA)',
        '_assets',
      ]);
    });

    it('1.2 deberia etiquetar sin parentesis el origen sin nodeType', () => {
      // 1. Arrange & 2. Act & 3. Assert: `_assets` no lo escribe ningun nodo, y
      //    un `(undefined)` en la etiqueta seria ruido.
      const wrapper = mountExplorer();
      const options = selectByField(wrapper, 'namespace-field').props('options') as {
        label: string;
      }[];

      expect(options[1]?.label).toBe('_assets');
    });

    it('1.3 no deberia reventar con el contexto vacio', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountExplorer([]);

      // 3. Assert: es el estado mientras el catalogo viaja.
      expect(selectByField(wrapper, 'namespace-field').props('options')).toEqual([]);
    });
  });

  describe('2. Seleccion en dos pasos', () => {
    it('2.1 deberia mantener el campo deshabilitado sin origen', () => {
      // 1. Arrange & 2. Act & 3. Assert: elegir un campo sin saber de donde
      //    sale no compone ningun marcador valido.
      const wrapper = mountExplorer();

      expect(selectByField(wrapper, 'variable-field').props('disable')).toBe(true);
    });

    it('2.2 deberia ofrecer los campos del origen elegido', async () => {
      // 1. Arrange
      const wrapper = mountExplorer();

      // 2. Act
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await wrapper.vm.$nextTick();

      // 3. Assert
      const fields = selectByField(wrapper, 'variable-field').props('options') as {
        name: string;
      }[];

      expect(fields.map(({ name }) => name)).toEqual(['clean_title', 'extracted_urls']);
    });

    it('2.3 deberia limpiar el campo al cambiar de origen', async () => {
      // 1. Arrange
      const wrapper = mountExplorer();
      await chooseVariable(wrapper, 'parsed_email');

      // 2. Act
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', '_assets');
      await wrapper.vm.$nextTick();

      // 3. Assert: conservarlo compondria un marcador que mezcla dos
      //    namespaces, y ese es justo el error que el explorador elimina.
      expect(wrapper.find('[data-test="token-detail"]').exists()).toBe(false);
    });
  });

  describe('3. Marcador y acciones', () => {
    it('3.1 deberia componer el marcador con su tipo y descripcion', async () => {
      // 1. Arrange
      const wrapper = mountExplorer();

      // 2. Act
      await chooseVariable(wrapper, 'parsed_email');

      // 3. Assert
      const detail = wrapper.get('[data-test="token-detail"]');

      expect(detail.text()).toContain('{{parsed_email.clean_title}}');
      expect(detail.text()).toContain('text');
      expect(detail.text()).toContain('Titular saneado');
    });

    it('3.2 deberia emitir el marcador completo al insertar', async () => {
      // 1. Arrange
      const wrapper = mountExplorer();
      await chooseVariable(wrapper, 'parsed_email', 1);

      // 2. Act
      await buttonByTest(wrapper, 'insert-token').trigger('click');

      // 3. Assert: se emite en vez de insertar porque cada anfitrion escribe en
      //    un editor distinto (CodeMirror vs textarea).
      expect(wrapper.emitted('insert')).toEqual([['{{parsed_email.extracted_urls}}']]);
    });

    it('3.3 deberia mantener los botones inhabilitados sin marcador', () => {
      // 1. Arrange & 2. Act & 3. Assert
      const wrapper = mountExplorer();

      expect(buttonByTest(wrapper, 'copy-token').props('disable')).toBe(true);
      expect(buttonByTest(wrapper, 'insert-token').props('disable')).toBe(true);
    });

    it('3.4 deberia reiniciar la seleccion cuando el anfitrion lo pide', async () => {
      // 1. Arrange: el dialogo permanece en el arbol cerrado y lo reutiliza
      //    para todas las filas, asi que al abrir tiene que limpiar.
      const wrapper = mountExplorer();
      await chooseVariable(wrapper, 'parsed_email');

      // 2. Act
      (wrapper.vm as unknown as { reset: () => void }).reset();
      await wrapper.vm.$nextTick();

      // 3. Assert
      expect(wrapper.find('[data-test="token-detail"]').exists()).toBe(false);
    });
  });
});
