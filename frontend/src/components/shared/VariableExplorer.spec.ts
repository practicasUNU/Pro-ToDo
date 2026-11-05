// @vitest-environment happy-dom
import { config, mount } from '@vue/test-utils';
import { QBtn, QBtnToggle, QSelect, Quasar } from 'quasar';
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

const mountExplorer = (
  context: readonly UpstreamNamespace[] = CONTEXT,
  extraProps: { requirednessToggle?: boolean } = {},
) =>
  mount(VariableExplorer, {
    props: { context, ...extraProps },
    global: { plugins: [Quasar], components: { QBtn, QBtnToggle, QSelect } },
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

  // El segundo selector emite el NOMBRE y no el objeto: lleva `emit-value` con
  // `option-value="name"`, de modo que el modelo es la clave que se interpola y
  // la etiqueta queda libre para mostrar tambien la descripcion.
  const fields = CONTEXT.find((entry) => entry.namespace === namespace)?.fields ?? [];
  selectByField(wrapper, 'variable-field').vm.$emit('update:modelValue', fields[fieldIndex]?.name);
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

  describe('2bis. Lectura del campo en el desplegable', () => {
    it('2bis.1 deberia acompanar el nombre tecnico con su descripcion', async () => {
      // 1. Arrange 📐: sin esto el segundo selector ofrecia una lista de claves
      //    en snake_case sin decir que hay dentro de cada una, y la
      //    `description` que ya declara cada estrategia no se veia en ninguna
      //    parte hasta DESPUES de elegir.
      const wrapper = mountExplorer();
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      const optionLabel = selectByField(wrapper, 'variable-field').props('optionLabel') as (field: {
        name: string;
        description?: string;
      }) => string;

      // 3. Assert 🎯
      expect(optionLabel({ name: 'clean_title', description: 'Titular saneado' })).toBe(
        'clean_title — Titular saneado',
      );
    });

    it('2bis.2 deberia dejar el nombre solo cuando no hay descripcion', async () => {
      // 1. Arrange 📐: un guion colgando sin texto detras se lee como un error
      //    de maquetacion.
      const wrapper = mountExplorer();
      selectByField(wrapper, 'namespace-field').vm.$emit('update:modelValue', 'parsed_email');
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      const optionLabel = selectByField(wrapper, 'variable-field').props('optionLabel') as (field: {
        name: string;
        description?: string;
      }) => string;

      // 3. Assert 🎯
      expect(optionLabel({ name: 'extracted_urls' })).toBe('extracted_urls');
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

  describe('5. Obligatoriedad del marcador (prompts de IA)', () => {
    it('5.1 no deberia mostrar el conmutador si el anfitrion no lo pide', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountExplorer();

      // 3. Assert 🎯: plantillas HTML y campos URL no conocen el asterisco.
      expect(wrapper.find('[data-test="requiredness-toggle"]').exists()).toBe(false);
    });

    it('5.2 deberia componer un marcador opcional por defecto', async () => {
      // 1. Arrange 📐
      const wrapper = mountExplorer(CONTEXT, { requirednessToggle: true });

      // 2. Act ⚙️
      await chooseVariable(wrapper, 'parsed_email');
      await buttonByTest(wrapper, 'insert-token').trigger('click');

      // 3. Assert 🎯
      expect(wrapper.emitted('insert')?.[0]).toEqual(['{{parsed_email.clean_title}}']);
      expect(wrapper.get('[data-test="token-value"]').classes()).toContain('pd-chip-optional');
    });

    it('5.3 deberia insertar {{*ns.campo}} al elegir Obligatorio (*)', async () => {
      // 1. Arrange 📐
      const wrapper = mountExplorer(CONTEXT, { requirednessToggle: true });
      await chooseVariable(wrapper, 'parsed_email');

      // 2. Act ⚙️
      wrapper
        .get('[data-test="requiredness-toggle"]')
        .findComponent(QBtnToggle)
        .vm.$emit('update:modelValue', 'mandatory');
      await wrapper.vm.$nextTick();
      await buttonByTest(wrapper, 'insert-token').trigger('click');

      // 3. Assert 🎯
      expect(wrapper.emitted('insert')?.[0]).toEqual(['{{*parsed_email.clean_title}}']);
      expect(wrapper.get('[data-test="token-value"]').classes()).toContain('pd-chip-mandatory');
      expect(wrapper.get('[data-test="requiredness-hint"]').text()).toContain('se pausa');
    });

    it('5.4 deberia ofrecer las dos opciones con sus etiquetas', () => {
      // 1. Arrange & 2. Act
      const wrapper = mountExplorer(CONTEXT, { requirednessToggle: true });
      const options = wrapper
        .get('[data-test="requiredness-toggle"]')
        .findComponent(QBtnToggle)
        .props('options') as { label: string; value: string }[];

      // 3. Assert 🎯
      expect(options).toEqual([
        { label: 'Obligatorio (*)', value: 'mandatory' },
        { label: 'Opcional', value: 'optional' },
      ]);
    });
  });
});
