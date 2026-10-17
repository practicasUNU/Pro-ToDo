// @vitest-environment happy-dom
//
// Directiva POR ARCHIVO, como en los demas specs de componente: los de store y
// utilidades no necesitan DOM y arrancan mas rapido sin el.
import { config, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { QBanner, QBtn, QCard, QIcon, QInput, QSelect, QSeparator, Quasar } from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import AiPromptTemplateDialog from '@components/ai-prompt-templates/AiPromptTemplateDialog.vue';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';

import type { NodeCatalogEntry } from '@/types/node-catalog';

/**
 * `PromptCodeEditor` se sustituye a nivel de MODULO y no con `stubs`.
 *
 * El dialogo lo carga con `defineAsyncComponent`, asi que en el arbol no hay un
 * nombre contra el que casar un stub; y montarlo de verdad arrastraria
 * CodeMirror entero a un spec que no va del editor.
 */
vi.mock('@components/shared/PromptCodeEditor.vue', () => ({
  // Sin esta marca Vue no desenvuelve `default` y toma el modulo entero por el
  // componente, contra el que Vue Test Utils sondea exportaciones que el doble
  // no tiene.
  __esModule: true,
  default: defineComponent({
    name: 'PromptCodeEditor',
    props: {
      modelValue: { type: String, default: '' },
      minHeight: { type: String, default: '220px' },
    },
    setup() {
      return () => h('div', { class: 'pd-prompt-editor', 'data-test': 'prompt-code-editor' });
    },
  }),
}));

// Los servicios cuelgan de `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplateById: vi.fn(),
  createAiPromptTemplate: vi.fn(),
  updateAiPromptTemplate: vi.fn(),
  deactivateAiPromptTemplate: vi.fn(),
}));

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

const QUASAR_COMPONENTS = { QBanner, QBtn, QCard, QIcon, QInput, QSelect, QSeparator };

const buildEntry = (overrides: Partial<NodeCatalogEntry> = {}): NodeCatalogEntry => ({
  id: 'e1',
  code: NodeType.PARSER_PRE_IA,
  name: 'Parser de Correo',
  category: NodeCategory.PROCESAMIENTO,
  description: null,
  implemented: true,
  outputFields: [{ name: 'clean_body', type: 'text' }],
  ...overrides,
});

/** Catalogo con un origen legitimo y los tres que un prompt no puede citar. */
const CATALOG: NodeCatalogEntry[] = [
  buildEntry({ id: '1' }),
  buildEntry({ id: '2', code: NodeType.PROCESADOR_OCR }),
  buildEntry({ id: '3', code: NodeType.PROCESADOR_IA }),
  buildEntry({ id: '4', code: NodeType.ESCUDO_POST_IA, category: NodeCategory.CONTROL }),
  buildEntry({ id: '5', code: NodeType.DESTINO_DRUPAL, category: NodeCategory.DESTINO }),
];

/**
 * Monta el dialogo CERRADO y lo abre, que es el camino real.
 *
 * El `watch` sobre `modelValue` no es `immediate`: montar directamente abierto
 * no dispararia el reseteo del formulario ni la carga del catalogo.
 */
const openDialog = async (
  props: Record<string, unknown> = {},
): Promise<ReturnType<typeof mount>> => {
  const wrapper = mount(AiPromptTemplateDialog, {
    props: { modelValue: false, prompt: null, ...props },
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

describe('AiPromptTemplateDialog · redaccion de la instruccion a dos columnas', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchNodeCatalog.mockResolvedValue(CATALOG);
  });

  /**
   * El reparto en dos columnas no es cosmetica: el editor pasa de una caja de
   * 220px a ocupar el alto del modal, y eso solo ocurre si la cadena flex esta
   * entera. Se afirma sobre las clases porque son los eslabones de esa cadena.
   */
  describe('1. Reparto en dos columnas', () => {
    it('1.1 deberia separar identificacion y editor en dos columnas', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await openDialog();

      // 3. Assert 🎯
      expect(wrapper.find('.pd-prompt-columns').exists()).toBe(true);
      expect(wrapper.find('.pd-prompt-side').classes()).toContain('col-md-4');
      expect(wrapper.find('.pd-prompt-main').classes()).toContain('col-md-8');
    });

    it('1.2 deberia dejar el editor en la derecha y el explorador en la izquierda', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await openDialog();

      // 3. Assert 🎯: cada uno en su columna. Con el explorador metido en la
      //    del editor —como estaba— la instruccion quedaba empujada hacia
      //    abajo por el formulario que deberia acompanarla, no precederla.
      expect(wrapper.get('.pd-prompt-main').find('[data-test="prompt-code-editor"]').exists()).toBe(
        true,
      );
      expect(wrapper.get('.pd-prompt-side').find('[data-test="namespace-field"]').exists()).toBe(
        true,
      );
    });

    it('1.3 deberia tener las acciones FUERA de un q-card-actions al pie', async () => {
      // 1. Arrange 📐: al pie de la tarjeta se superponian sobre el editor, que
      //    es el mismo motivo por el que el editor de plantillas HTML las movio
      //    a la columna.
      const wrapper = await openDialog();

      // 3. Assert 🎯
      const side = wrapper.get('.pd-prompt-side');

      expect(side.text()).toContain('Guardar prompt');
      expect(side.text()).toContain('Cancelar');
      expect(wrapper.find('.q-card__actions').exists()).toBe(false);
    });
  });

  /**
   * El filtro vive en `prompt-namespaces.ts` y tiene su propia prueba; lo que
   * se fija aqui es que el dialogo lo APLICA, que es la parte que se puede
   * romper sin que aquella se entere.
   */
  describe('2. Origenes citables', () => {
    it('2.1 deberia ofrecer solo los origenes previos a la inferencia', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = await openDialog();

      // 3. Assert 🎯: se comprueba sobre las OPCIONES del selector y no sobre
      //    el texto pintado, que esta colapsado hasta desplegarlo.
      const options = wrapper
        .get('[data-test="namespace-field"]')
        .findComponent(QSelect)
        .props('options') as readonly { value: string }[];
      const namespaces = options.map(({ value }) => value);

      expect(namespaces).toContain('parsed_email');
      expect(namespaces).toContain('ocr_result');
      expect(namespaces).not.toContain('llm_response');
      expect(namespaces).not.toContain('validated_drupal_json');
      expect(namespaces).not.toContain('http_result');
    });

    it('2.1b deberia ofrecer `_assets`, que no publica ninguna estrategia', async () => {
      // 1. Arrange 📐: `_assets` no lo declara ningun nodo, asi que por la via
      //    del catalogo no puede aparecer nunca; y es contenido, no mecanica
      //    del motor: es la base de las URL con las que una plantilla enlaza
      //    los binarios subidos a Drupal.
      const wrapper = await openDialog();

      // 2. Act ⚙️
      const options = wrapper
        .get('[data-test="namespace-field"]')
        .findComponent(QSelect)
        .props('options') as readonly { value: string }[];
      const namespaces = options.map(({ value }) => value);

      // 3. Assert 🎯
      expect(namespaces).toContain('_assets');
    });

    it('2.1b-bis NO deberia ofrecer la mecanica interna del motor', async () => {
      // 1. Arrange 📐: `trigger` y `error_context` describen como funciona el
      //    motor, no datos del negocio. `error_context` ademas solo existe en
      //    las ejecuciones que se desviaron por `onErrorStep`, asi que citado
      //    desde el camino feliz interpola vacio — un marcador que unas veces
      //    trae dato y otras no es lo que §4 intenta evitar.
      //
      //    Siguen FUNCIONANDO si alguien los teclea: lo que se retira es la
      //    invitacion a usarlos desde la interfaz.
      const wrapper = await openDialog();

      // 2. Act ⚙️
      const options = wrapper
        .get('[data-test="namespace-field"]')
        .findComponent(QSelect)
        .props('options') as readonly { value: string }[];
      const namespaces = options.map(({ value }) => value);

      // 3. Assert 🎯
      expect(namespaces).not.toContain('trigger');
      expect(namespaces).not.toContain('error_context');
    });

    it('2.1c deberia tener los campos de ocr_result resueltos al abrir', async () => {
      // 1. Arrange 📐: el defecto no era que faltara el namespace, sino que el
      //    catalogo se pedia sin esperarlo: el primer repintado ocurria con la
      //    lista vacia y quien bajaba al desplegable concluia que no habia
      //    variables.
      const wrapper = await openDialog();

      // 2. Act ⚙️
      const context = wrapper
        .getComponent({ name: 'VariableExplorer' })
        .props('context') as readonly {
        namespace: string;
        fields: readonly { name: string }[];
      }[];
      const ocr = context.find(({ namespace }) => namespace === 'ocr_result');

      // 3. Assert 🎯
      expect(ocr?.fields.map((field) => field.name)).toContain('clean_body');
    });

    it('2.2 deberia explicar por que faltan los demas origenes', async () => {
      // 1. Arrange 📐: la ausencia no se ve. Quien busca `llm_response` y no lo
      //    encuentra no puede distinguir "esta prohibido" de "no ha cargado".
      const wrapper = await openDialog();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="prompt-origin-notice"]').text()).toContain(
        'ANTERIORES a la inferencia',
      );
    });
  });

  describe('3. Validacion del formulario', () => {
    it('3.1 deberia bloquear el guardado sin instruccion', async () => {
      // 1. Arrange 📐: el editor es CodeMirror y no un campo de QForm, asi que
      //    las `:rules` no lo alcanzan; lo gobierna `isFormValid`.
      const wrapper = await openDialog();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="prompt-text-error"]').exists()).toBe(true);

      const save = wrapper
        .findAllComponents(QBtn)
        .find((btn) => btn.text().includes('Guardar prompt'));

      expect(save?.props('disable')).toBe(true);
    });
  });
});
