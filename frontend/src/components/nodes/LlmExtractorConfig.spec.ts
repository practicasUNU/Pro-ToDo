// @vitest-environment happy-dom
import { config, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  Notify,
  QBadge,
  QBanner,
  QBtn,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  QTooltip,
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LlmExtractorConfig from '@components/nodes/LlmExtractorConfig.vue';
import { useLlmExtractorStore } from '@stores/nodes/llm-extractor.store';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import { AUDIT_FIXTURE } from '@/testing/audit.fixture';

import type { AiPromptTemplate } from '@/types/ai-prompt-template';
import type { LlmModelDescriptor } from '@/types/nodes/llm-extractor.types';

// El configurador monta ahora los dialogos de prompt, que arrastran el store de
// prompts y el catalogo de nodos. Sin estos dobles se cargaria `@boot/axios`,
// que necesita entorno de navegador.
//
// `auth.service` entra por `useSessionStore`, que el selector de modelo
// consulta para saber si el rol alcanza a los modelos de pago.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

// El asistente de prompts llega con su modal; sin esto se cargaria
// `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/prompts.service', () => ({
  optimizePrompt: vi.fn(),
}));

vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplateById: vi.fn(),
  createAiPromptTemplate: vi.fn(),
  updateAiPromptTemplate: vi.fn(),
  deactivateAiPromptTemplate: vi.fn(),
}));
vi.mock('@services/node-catalog.service', () => ({ fetchNodeCatalog: vi.fn() }));
vi.mock('@services/nodes/llm-extractor.service', () => ({
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}));

const llmExtractorService = await import('@services/nodes/llm-extractor.service');
const fetchLlmModels = vi.mocked(llmExtractorService.fetchLlmModels);
const testLlmConnection = vi.mocked(llmExtractorService.testLlmConnection);

const aiPromptTemplatesService = await import('@services/ai-prompt-templates.service');
const fetchAiPromptTemplates = vi.mocked(aiPromptTemplatesService.fetchAiPromptTemplates);

const PROMPT_ID = 'a7b8c9d0-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

let nodeCounter = 0;
const nextNodeId = (): string => `procesador_ia_view_${(nodeCounter += 1)}`;

const QUASAR_COMPONENTS = {
  QBadge,
  QBanner,
  QBtn,
  QIcon,
  QInput,
  QItem,
  QItemLabel,
  QItemSection,
  QSelect,
  QToggle,
  QTooltip,
};

const PROMPT: AiPromptTemplate = {
  ...AUDIT_FIXTURE,
  id: PROMPT_ID,
  code: 'REDACCION_DE_NOTA_DE_PRENSA',
  name: 'Redaccion de nota de prensa',
  description: 'Convierte una nota en noticia publicable',
  active: true,
  createdById: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const buildDescriptor = (overrides: Partial<LlmModelDescriptor> = {}): LlmModelDescriptor => ({
  provider: LlmProvider.ANTHROPIC,
  model: 'claude-sonnet-5-5',
  label: 'Claude Sonnet 5.5',
  isAvailable: true,
  isTestOnly: false,
  supportsVision: true,
  contextWindow: 1_000_000,
  ...overrides,
});

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(LlmExtractorConfig, {
    props: { nodeId },
    // `Notify` se instala explicitamente: el alta de plantilla avisa al
    // terminar, y sin el plugin `$q.notify` lanza fuera del ciclo de la prueba
    // —pasa igual pero deja un error sin atender en la salida.
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
    },
  });

/** El control de un campo, por el `data-test` de su CONTENEDOR. */
const selectByField = (wrapper: ReturnType<typeof mount>, field: string) =>
  wrapper.get(`[data-test="${field}"]`).findComponent(QSelect);

describe('LlmExtractorConfig · configurador del nodo PROCESADOR_IA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchAiPromptTemplates.mockResolvedValue([]);
    // Catalogo vacio por defecto: cada prueba que necesite modelos los declara.
    fetchLlmModels.mockResolvedValue([]);
  });

  describe('1. Montaje', () => {
    it('1.1 deberia pintar los campos de instruccion y presupuesto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      for (const field of [
        'template-prompt-field',
        'provider-field',
        'model-field',
        'timeout-field',
        'retries-field',
        'brake-field',
      ]) {
        expect(wrapper.find(`[data-test="${field}"]`).exists()).toBe(true);
      }

      // La entrada libre se retiro: el prompt es un activo compartido y
      // revisado, y el texto suelto por flujo se volvia un resto de pruebas que
      // nadie repasaba.
      expect(wrapper.find('[data-test="inline-prompt-field"]').exists()).toBe(false);
      expect(wrapper.find('[data-test="preview-prompt"]').exists()).toBe(true);
      expect(wrapper.find('[data-test="create-prompt"]').exists()).toBe(true);
    });

    it('1.2 deberia pedir el catalogo de prompts al montarse', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      mountComponent(nextNodeId());

      // 3. Assert 🎯: solo los activos, que es lo que el backend documenta para
      //    el selector de este nodo.
      expect(fetchAiPromptTemplates).toHaveBeenCalledWith(true);
    });

    it('1.3 deberia poblar el selector con los prompts recibidos', async () => {
      // 1. Arrange 📐
      fetchAiPromptTemplates.mockResolvedValue([PROMPT]);
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);
      await useLlmExtractorStore(nodeId).loadPrompts();
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const options = selectByField(wrapper, 'template-prompt-field').props('options') as {
        value: string;
      }[];

      expect(options.map((option) => option.value)).toEqual([PROMPT_ID]);
    });
  });

  describe('2. Guardas de la instruccion', () => {
    it('2.1 deberia exigir una instruccion al arrancar', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: sin ella no hay nodo que ejecutar, y es lo
      //    unico que el backend exige para poder ACTIVAR el flujo.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="missing-prompt"]').exists()).toBe(true);
    });

    it('2.2 deberia retirar la exigencia con una instruccion en linea', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ inlinePrompt: 'Redacta algo' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="missing-prompt"]').exists()).toBe(false);
    });

    it('2.3 deberia avisar de la prioridad con los dos prompts puestos', async () => {
      // 1. Arrange 📐: el backend elige la PLANTILLA en silencio. Sin este
      //    aviso, el operador descubre cual mandaba leyendo una redaccion que no
      //    esperaba.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({
        templatePromptId: PROMPT_ID,
        inlinePrompt: 'Otra cosa',
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const conflict = wrapper.find('[data-test="prompt-conflict"]');

      expect(conflict.exists()).toBe(true);
      expect(conflict.text()).toContain('LA PLANTILLA');
    });
  });

  describe('3. Avisos de coste', () => {
    it('3.1 no deberia mostrar ninguno DE COSTE en el estado inicial', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: el nodo arranca en el simulador.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯: el unico aviso que queda en el arranque es el de la
      // prueba de conexion pendiente, que no habla de gasto. Contar cero
      // avisos ya no describiria el estado inicial del formulario.
      const warnings = wrapper.findAll('[data-test="config-warning"]').map((w) => w.text());

      expect(warnings.join(' ')).not.toContain('tokens facturables');
      expect(warnings.join(' ')).not.toContain('simulador');
    });

    it('3.2 deberia mostrarlo al elegir un proveedor de pago', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ provider: LlmProvider.GEMINI });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      const warnings = wrapper.findAll('[data-test="config-warning"]').map((w) => w.text());

      expect(warnings.join(' ')).toContain('tokens facturables');
    });

    it('3.3 deberia avisar de que un proveedor sin cliente degrada al simulador', async () => {
      // 1. Arrange 📐: elegirlo creyendo que escribe el proveedor real es el
      //    fallo caro. Se ejerce con OPENAI y ya no con ANTHROPIC, que desde
      //    PROT-20 tiene cliente y cuyo aviso correcto es el del gasto.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ provider: LlmProvider.OPENAI });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="config-warning"]').text()).toContain('isMock');
    });
  });

  describe('3bis. Estimacion de recursos', () => {
    /** Tabla con las trece comisiones del flujo de verificacion de titulos. */
    const TABLA_COMISIONES = `<table class="tableform"><tbody>${Array.from(
      { length: 13 },
      () => '<tr><td>{{universidad}}</td></tr>',
    ).join('')}</tbody></table>`;

    it('3bis.1 NO deberia pintar la tarjeta sin plantilla base delante', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: sin marcado que medir, una tarjeta que
      //    siempre dice lo mismo solo anade ruido al formulario.
      const wrapper = mountComponent(nextNodeId());

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="resource-estimate"]').exists()).toBe(false);
    });

    it('3bis.2 deberia pintarla con el nivel ALTA ante una coleccion', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️: el marcado llega por el canal del anfitrion.
      useLlmExtractorStore(nodeId).setUpstreamBaseMarkup(TABLA_COMISIONES);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="resource-estimate"]').exists()).toBe(true);
      expect(wrapper.get('[data-test="estimate-level"]').text()).toBe('ALTA');
    });

    it('3bis.3 el boton deberia volcar la recomendacion sobre la configuracion', async () => {
      // 1. Arrange 📐: es una SUGERENCIA, y quien la aplica es el operador. Los
      //    campos manuales siguen estando y siguen mandando.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useLlmExtractorStore(nodeId);

      store.setUpstreamBaseMarkup(TABLA_COMISIONES);
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper.get('[data-test="apply-recommendation"]').trigger('click');

      // 3. Assert 🎯
      expect(store.config.timeoutMs).toBe(60_000);
      expect(store.config.maxTokens).toBeGreaterThanOrEqual(8_192);
    });
  });

  describe('4. Enlace con el store', () => {
    it('4.1 deberia reflejar el proveedor elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await selectByField(wrapper, 'provider-field').vm.$emit(
        'update:modelValue',
        LlmProvider.GEMINI,
      );

      // 3. Assert 🎯
      expect(useLlmExtractorStore(nodeId).config.provider).toBe(LlmProvider.GEMINI);
    });

    it('4.2 deberia limpiar la plantilla al vaciar el selector', async () => {
      // 1. Arrange 📐: `clearable` emite `null`, y el store tiene que guardarlo
      //    como ausencia y no como cadena vacia: el DTO valida `@IsUUID`.
      const nodeId = nextNodeId();
      const store = useLlmExtractorStore(nodeId);
      store.updateConfig({ templatePromptId: PROMPT_ID });
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await selectByField(wrapper, 'template-prompt-field').vm.$emit('update:modelValue', null);

      // 3. Assert 🎯
      expect(store.config.templatePromptId).toBeNull();
      expect(store.toNodeParams()).not.toHaveProperty('templatePromptId');
    });

    it('4.3 deberia registrar el presupuesto de tokens que se escriba', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="max-tokens-field"]')
        .findComponent(QInput)
        .vm.$emit('update:modelValue', '16384');

      // 3. Assert 🎯
      expect(useLlmExtractorStore(nodeId).config.maxTokens).toBe(16_384);
    });

    it('4.4 deberia volver a la resolucion automatica al vaciarlo', async () => {
      // 1. Arrange 📐: `clearable` emite `null`, y tiene que guardarse como
      //    AUSENCIA. Un 0 ahi seria un presupuesto de cero tokens.
      const nodeId = nextNodeId();
      const store = useLlmExtractorStore(nodeId);
      store.updateConfig({ maxTokens: 16_384 });
      const wrapper = mountComponent(nodeId);

      // 2. Act ⚙️
      await wrapper
        .get('[data-test="max-tokens-field"]')
        .findComponent(QInput)
        .vm.$emit('update:modelValue', null);

      // 3. Assert 🎯
      expect(store.config.maxTokens).toBeNull();
      expect(store.toNodeParams()).not.toHaveProperty('maxTokens');
    });
  });

  describe('5. Alta de plantilla sin salir del asistente', () => {
    it('5.1 deberia recargar el catalogo y seleccionar la recien creada', async () => {
      // 1. Arrange 📐: la recarga va por el STORE DE PROMPTS y no por
      //    `store.loadPrompts()`, que lleva una guarda memoizada pensada para no
      //    repetir la peticion al montar cada nodo y que aqui se tragaria justo
      //    la recarga que hace falta.
      const nodeId = nextNodeId();
      const created = {
        ...AUDIT_FIXTURE,
        id: 'e7c9a1b2-3d4e-4f50-8a6b-7c8d9e0f1a2b',
        code: 'REDACCION_INSTITUCIONAL',
        name: 'Redaccion institucional',
        description: null,
        active: true,
        createdById: 'u1',
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
        promptText: 'Redacta a partir de {{parsed_email.clean_body}}',
      };

      fetchAiPromptTemplates.mockResolvedValue([created]);

      const wrapper = mountComponent(nodeId);
      const store = useLlmExtractorStore(nodeId);

      // 2. Act ⚙️: el dialogo anuncia lo que acaba de guardar.
      await wrapper.findComponent({ name: 'AiPromptTemplateDialog' }).vm.$emit('saved', created);
      await flushPromises();

      // 3. Assert 🎯
      expect(fetchAiPromptTemplates).toHaveBeenCalled();
      expect(store.config.templatePromptId).toBe(created.id);
    });

    it('5.2 deberia entregar al dialogo el contexto aguas arriba de ESTE flujo', async () => {
      // 1. Arrange 📐: sin la prop, el dialogo cae al catalogo global de nodos y
      //    ofreceria marcadores de namespaces que este flujo no publica.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useLlmExtractorStore(nodeId);

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([
        { namespace: 'parsed_email', fields: [{ name: 'clean_body', type: 'text' }] },
      ]);
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(
        wrapper.findComponent({ name: 'AiPromptTemplateDialog' }).props('upstreamContext'),
      ).toEqual([{ namespace: 'parsed_email', fields: [{ name: 'clean_body', type: 'text' }] }]);
    });
  });

  describe('6. Instruccion en linea heredada', () => {
    it('6.1 deberia mostrarla en solo lectura sin permitir editarla', async () => {
      // 1. Arrange 📐: borrarla al guardar se llevaria por delante la unica
      //    instruccion de un flujo antiguo sin que nadie lo hubiera pedido.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      const store = useLlmExtractorStore(nodeId);

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'llm_response',
        params: { inlinePrompt: 'Instruccion antigua', model: 'claude-sonnet-5' },
      });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯: se ve, no se edita, y sigue viajando en los params.
      expect(wrapper.get('[data-test="legacy-inline-prompt"]').text()).toContain(
        'Instruccion antigua',
      );
      expect(wrapper.find('[data-test="inline-prompt-field"]').exists()).toBe(false);
      expect(store.toNodeParams().inlinePrompt).toBe('Instruccion antigua');
    });
  });

  describe('6. Catalogo de modelos y prueba de conexion', () => {
    it('6.1 deberia pedir el catalogo al montar', async () => {
      // 1. Arrange 📐 & 2. Act ⚙️
      mountComponent(nextNodeId());
      await flushPromises();

      // 3. Assert 🎯
      expect(fetchLlmModels).toHaveBeenCalledTimes(1);
    });

    it('6.2 deberia pintar el distintivo del modelo elegido', async () => {
      // 1. Arrange 📐: el estado tiene que verse con el selector CERRADO, no
      //    solo al desplegarlo.
      fetchLlmModels.mockResolvedValue([buildDescriptor()]);
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ model: 'claude-sonnet-5-5' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="model-availability-badge"]').text()).toBe('Configurado');
    });

    it('6.3 deberia marcar "Falta API Key" cuando el backend lo da por no disponible', async () => {
      // 1. Arrange 📐: es el caso que esta pantalla existe para delatar.
      fetchLlmModels.mockResolvedValue([buildDescriptor({ isAvailable: false })]);
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ model: 'claude-sonnet-5-5' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.get('[data-test="model-availability-badge"]').text()).toBe('Falta API Key');
    });

    it('6.4 deberia avisar de que el modelo guardado no esta en el catalogo', async () => {
      // 1. Arrange 📐: el aviso es lo que evita que un selector cerrado parezca
      //    haber perdido la configuracion de un flujo heredado.
      fetchLlmModels.mockResolvedValue([buildDescriptor()]);
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      useLlmExtractorStore(nodeId).updateConfig({ model: 'modelo-retirado' });
      await wrapper.vm.$nextTick();

      // 3. Assert 🎯
      expect(wrapper.text()).toContain('no figura en el catalogo');
    });

    it('6.5 deberia probar la conexion con el par elegido', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();
      useLlmExtractorStore(nodeId).updateConfig({
        provider: LlmProvider.ANTHROPIC,
        model: 'claude-sonnet-5-5',
      });
      testLlmConnection.mockResolvedValue({
        success: true,
        latencyMs: 90,
        isMock: false,
        outputPreview: 'Conexion verificada',
      });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper.get('[data-test="test-connection-btn"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(testLlmConnection).toHaveBeenCalledWith({
        provider: LlmProvider.ANTHROPIC,
        model: 'claude-sonnet-5-5',
      });
    });

    it('6.6 deberia conservar el isMock de una respuesta simulada', async () => {
      // 1. Arrange 📐: `success: true` con `isMock: true` NO es una conexion
      //    correcta —respondio el simulador porque falta la credencial—, y el
      //    componente lo traduce a un aviso y no a un positivo. Lo que se fija
      //    aqui es que el dato llegue intacto: el `$q.notify` real no se puede
      //    interceptar desde fuera, porque el componente captura `$q` al
      //    montarse, y ninguna otra suite del repositorio lo intenta.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();
      const store = useLlmExtractorStore(nodeId);
      store.updateConfig({ provider: LlmProvider.ANTHROPIC });
      testLlmConnection.mockResolvedValue({
        success: true,
        latencyMs: 12,
        isMock: true,
        outputPreview: '',
      });
      await wrapper.vm.$nextTick();

      // 2. Act ⚙️
      await wrapper.get('[data-test="test-connection-btn"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(store.lastConnectionResult?.isMock).toBe(true);
    });

    it('6.7 deberia absorber una peticion rota sin dejar el boton girando', async () => {
      // 1. Arrange 📐: una excepcion del servicio no es un diagnostico del
      //    proveedor, es que no se pudo hablar con el banco de pruebas. El
      //    componente la traduce a un aviso negativo; lo verificable desde
      //    aqui es que no se propague ni deje el indicador encendido.
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();
      const store = useLlmExtractorStore(nodeId);
      testLlmConnection.mockRejectedValue(new Error('Network Error'));

      // 2. Act ⚙️
      await wrapper.get('[data-test="test-connection-btn"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(testLlmConnection).toHaveBeenCalledTimes(1);
      expect(store.isTestingConnection).toBe(false);
      expect(store.lastConnectionResult).toBeNull();
    });
  });
});
