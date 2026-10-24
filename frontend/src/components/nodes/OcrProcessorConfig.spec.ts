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
  Quasar,
} from 'quasar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OcrProcessorConfig from '@components/nodes/OcrProcessorConfig.vue';
import PromptOptimizerModal from '@components/shared/PromptOptimizerModal.vue';
import { useOcrProcessorStore } from '@stores/nodes/ocr-processor.store';
import { useSessionStore } from '@stores/session.store';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import { DEFAULT_OCR_MODEL, PROMPT_OCR_MULTIMODAL } from '@/types/nodes/ocr-processor.types';
import { UserRole } from '@/types/user';

import type { LlmModelDescriptor } from '@/types/nodes/llm-extractor.types';

// `auth.service` entra por `useSessionStore`, que el selector de modelo
// consulta para saber si el rol alcanza a los modelos de pago. Se dobla el
// SERVICIO y no axios: `@boot/axios` importa `#q-app`, que no resuelve fuera
// del build de Quasar.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

// El catalogo de modelos lo sirve el servicio del nodo de IA: la ruta
// `/llm/models` es del catalogo, no del nodo de redaccion.
// El asistente de prompts llega con su modal; sin esto se cargaria
// `@boot/axios`, que necesita el entorno de Quasar.
vi.mock('@services/prompts.service', () => ({
  optimizePrompt: vi.fn(),
}));

vi.mock('@services/nodes/llm-extractor.service', () => ({
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}));

const llmExtractorService = await import('@services/nodes/llm-extractor.service');
const fetchLlmModels = vi.mocked(llmExtractorService.fetchLlmModels);
const testLlmConnection = vi.mocked(llmExtractorService.testLlmConnection);

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
};

const CATALOG: LlmModelDescriptor[] = [
  {
    provider: LlmProvider.GEMINI,
    model: 'gemini-1.5-flash',
    label: 'Gemini 1.5 Flash',
    isAvailable: true,
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 1_000_000,
  },
  {
    provider: LlmProvider.ANTHROPIC,
    model: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    isAvailable: true,
    isTestOnly: false,
    supportsVision: true,
    contextWindow: 200_000,
    minRoleRequired: UserRole.ADMIN,
  },
];

let nodeCounter = 0;
const nextNodeId = (): string => `ocr_ia_${(nodeCounter += 1)}`;

const signInAs = (role: UserRole): void => {
  useSessionStore().user = {
    id: 'u1',
    email: 'quien@unuware.com',
    role,
  };
};

const mountComponent = (nodeId: string): ReturnType<typeof mount> =>
  mount(OcrProcessorConfig, {
    props: { nodeId },
    global: {
      plugins: [[Quasar, { plugins: { Notify } }]],
      components: QUASAR_COMPONENTS,
    },
  });

/**
 * Suite del configurador del nodo satelite PROCESADOR_OCR.
 *
 * Lo que se fija es el Poka-Yoke del selector de modelo: que un EDITOR no
 * pueda elegir un modelo facturable. Es comodidad —quien decide de verdad es
 * el backend al guardar—, pero sin ella el operador rellena el formulario
 * entero para toparse con un 403 al final.
 */
describe('OcrProcessorConfig · configurador del nodo PROCESADOR_OCR', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    config.global.plugins = [];
    vi.clearAllMocks();
    fetchLlmModels.mockResolvedValue([]);
  });

  describe('1. Carga del catalogo', () => {
    it('1.1 deberia pedir los modelos al montar', async () => {
      // 1. Arrange 📐: desplegar el selector y encontrarlo vacio durante medio
      //    segundo parece un fallo; la peticion es un GET barato.
      fetchLlmModels.mockResolvedValue(CATALOG);

      // 2. Act ⚙️
      mountComponent(nextNodeId());
      await flushPromises();

      // 3. Assert 🎯
      expect(fetchLlmModels).toHaveBeenCalledTimes(1);
    });

    it('1.2 NO deberia romper el formulario si el catalogo falla', async () => {
      // 1. Arrange 📐: el nodo conserva el modelo que ya tuviera; perder el
      //    paso entero porque el catalogo no responde seria desproporcionado.
      fetchLlmModels.mockRejectedValue(new Error('503'));
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="ocr-model-field"]').exists()).toBe(true);
      expect(useOcrProcessorStore(nodeId).isLoadingModels).toBe(false);
    });
  });

  describe('2. Restriccion por rol', () => {
    it('2.1 deberia deshabilitar el modelo de pago para un EDITOR', async () => {
      // 1. Arrange 📐
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      mountComponent(nodeId);
      await flushPromises();

      // El catalogo se filtra por proveedor desde la cascada, asi que hay
      // que elegir el del modelo de pago para que figure entre las opciones.
      useOcrProcessorStore(nodeId).updateConfig({ provider: LlmProvider.ANTHROPIC });

      // 3. Assert 🎯: se comprueba sobre las OPCIONES que recibe el QSelect y
      //    no abriendo el menu, que en happy-dom se renderiza en un portal
      //    fuera del wrapper.
      const paid = useOcrProcessorStore(nodeId).modelOptions.find(
        (option) => option.value === 'claude-haiku-4-5',
      );

      expect(paid?.disable).toBe(true);
    });

    it('2.2 deberia habilitarlo para un ADMIN', async () => {
      // 1. Arrange 📐
      signInAs(UserRole.ADMIN);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      mountComponent(nodeId);
      await flushPromises();

      // El catalogo se filtra por proveedor desde la cascada, asi que hay
      // que elegir el del modelo de pago para que figure entre las opciones.
      useOcrProcessorStore(nodeId).updateConfig({ provider: LlmProvider.ANTHROPIC });

      // 3. Assert 🎯
      const paid = useOcrProcessorStore(nodeId).modelOptions.find(
        (option) => option.value === 'claude-haiku-4-5',
      );

      expect(paid?.disable).toBe(false);
    });

    it('2.3 deberia avisar cuando el modelo guardado esta vetado', async () => {
      // 1. Arrange 📐: pasa al abrir un flujo que guardo un ADMIN. El aviso
      //    explica por que el paso no deja avanzar.
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️: el proveedor primero, porque cambiarlo limpia el modelo.
      useOcrProcessorStore(nodeId).updateConfig({ provider: LlmProvider.ANTHROPIC });
      useOcrProcessorStore(nodeId).updateConfig({ model: 'claude-haiku-4-5' });
      await flushPromises();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="ocr-forbidden-banner"]').exists()).toBe(true);
    });

    it('2.4 NO deberia avisar con un modelo permitido', async () => {
      // 1. Arrange 📐
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="ocr-forbidden-banner"]').exists()).toBe(false);
    });
  });

  describe('3. Selector cerrado', () => {
    it('3.1 deberia presentar el modelo como QSelect y no como texto libre', async () => {
      // 1. Arrange 📐: hasta PROT-22 era un `q-input`. Un selector cerrado es
      //    lo unico que permite deshabilitar una opcion por rol
      //    (`frontend-quasar.md` §4).
      fetchLlmModels.mockResolvedValue(CATALOG);

      // 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());
      await flushPromises();

      // 3. Assert 🎯
      const field = wrapper.get('[data-test="ocr-model-field"]');

      expect(field.findComponent(QSelect).exists()).toBe(true);
    });
  });

  /**
   * El banco de pruebas que este nodo NO tenia. Lo que lo hace admisible pese a
   * su coste es que la prueba la dispara el operador y su resultado no decide
   * si se puede avanzar.
   */
  describe('4. Banco de pruebas', () => {
    it('4.1 deberia ofrecer el boton de prueba de conexion', async () => {
      // 1. Arrange 📐
      fetchLlmModels.mockResolvedValue(CATALOG);

      // 2. Act ⚙️
      const wrapper = mountComponent(nextNodeId());
      await flushPromises();

      // 3. Assert 🎯
      expect(wrapper.find('[data-test="test-connection-btn"]').exists()).toBe(true);
    });

    it('4.2 deberia delegar en el servicio del catalogo con el par activo', async () => {
      // 1. Arrange 📐: no hay `ocr-processor.service.ts`, y es deliberado: la
      //    ruta `/llm/test-connection` pertenece al catalogo y envolverla aqui
      //    seria la capa vacia que `frontend-architecture.md` §2.1 desaconseja.
      fetchLlmModels.mockResolvedValue(CATALOG);
      testLlmConnection.mockResolvedValue({
        success: true,
        latencyMs: 210,
        isMock: false,
        outputPreview: 'ok',
      });
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      await wrapper.get('[data-test="test-connection-btn"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯
      expect(testLlmConnection).toHaveBeenCalledWith({
        provider: LlmProvider.GEMINI,
        model: DEFAULT_OCR_MODEL,
      });
    });

    it('4.3 deberia seguir avisando cuando responde el simulador pese al exito', async () => {
      // 1. Arrange 📐: un proveedor sin clave NO falla, degrada. Presentarlo
      //    como conexion correcta es la confusion mas cara del formulario: la
      //    transcripcion seria texto inventado y nada aguas abajo lo delata
      //    salvo `metadata.isMock`.
      fetchLlmModels.mockResolvedValue(CATALOG);
      testLlmConnection.mockResolvedValue({
        success: true,
        latencyMs: 4,
        isMock: true,
        outputPreview: 'simulado',
      });
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      await wrapper.get('[data-test="test-connection-btn"]').trigger('click');
      await flushPromises();

      // 3. Assert 🎯: el exito simulado NO puede apagar el aviso.
      expect(useOcrProcessorStore(nodeId).configWarnings.join(' ')).toContain('SIMULADOR');
    });

    it('4.4 no deberia invalidar el paso por no haber probado', async () => {
      // 1. Arrange 📐: `isConfigValid` replica `getIncompleteParams` del
      //    backend. Atarlo a una llamada de pago bloquearia el stepper.
      fetchLlmModels.mockResolvedValue(CATALOG);
      const nodeId = nextNodeId();

      // 2. Act ⚙️
      mountComponent(nodeId);
      await flushPromises();

      // 3. Assert 🎯
      expect(useOcrProcessorStore(nodeId).isConfigValid).toBe(true);
    });
  });

  describe('6. Prompt personalizable', () => {
    it('6.1 al activar "Personalizar prompt" deberia partir del prompt del sistema', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      wrapper
        .findAllComponents({ name: 'QToggle' })
        .find((toggle) => toggle.attributes('data-test') === 'ocr-prompt-toggle')
        ?.vm.$emit('update:modelValue', true);
      await flushPromises();

      // 3. Assert 🎯
      expect(useOcrProcessorStore(nodeId).config.customPrompt).toBe(PROMPT_OCR_MULTIMODAL);
      expect(wrapper.find('[data-test="ocr-prompt-restore"]').exists()).toBe(true);
    });

    it('6.2 aplicar la propuesta del asistente deberia fijarla como prompt propio', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      await flushPromises();

      // 2. Act ⚙️
      wrapper.findComponent(PromptOptimizerModal).vm.$emit('apply', 'Transcribe solo la tabla.');
      await flushPromises();

      // 3. Assert 🎯
      expect(useOcrProcessorStore(nodeId).config.customPrompt).toBe('Transcribe solo la tabla.');
      expect(useOcrProcessorStore(nodeId).toNodeParams().customPrompt).toBe(
        'Transcribe solo la tabla.',
      );
    });

    it('6.3 "Restaurar prompt del sistema" deberia volver al prompt por defecto', async () => {
      // 1. Arrange 📐
      const nodeId = nextNodeId();
      const wrapper = mountComponent(nodeId);
      useOcrProcessorStore(nodeId).updateConfig({ customPrompt: 'Otro.' });
      await flushPromises();

      // 2. Act ⚙️
      await wrapper.get('[data-test="ocr-prompt-restore"]').trigger('click');

      // 3. Assert 🎯
      expect(useOcrProcessorStore(nodeId).config.customPrompt).toBeNull();
    });
  });
});
