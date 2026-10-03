import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';

import {
  DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_TIMEOUT_MS,
  LlmProvider,
  MAX_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

import { useLlmExtractorStore } from './llm-extractor.store';

import type { AiPromptTemplate } from '@/types/ai-prompt-template';
import type {
  LlmModelDescriptor,
  LlmTestConnectionResult,
} from '@/types/nodes/llm-extractor.types';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplateById: vi.fn(),
}));
vi.mock('@services/nodes/llm-extractor.service', () => ({
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}));

const aiPromptTemplatesService = await import('@services/ai-prompt-templates.service');
const fetchAiPromptTemplates = vi.mocked(aiPromptTemplatesService.fetchAiPromptTemplates);

const llmExtractorService = await import('@services/nodes/llm-extractor.service');
const fetchLlmModels = vi.mocked(llmExtractorService.fetchLlmModels);
const testLlmConnection = vi.mocked(llmExtractorService.testLlmConnection);

const PROMPT_ID = 'a7b8c9d0-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

/**
 * `nodeId` unico por prueba.
 *
 * Las definiciones de Pinia se memoizan en un `Map` de MODULO que sobrevive
 * entre pruebas, asi que reutilizar un id arrastraria el estado de la anterior.
 */
let nodeCounter = 0;
const nextNodeId = (): string => `procesador_ia_${(nodeCounter += 1)}`;

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

const buildConnectionResult = (
  overrides: Partial<LlmTestConnectionResult> = {},
): LlmTestConnectionResult => ({
  success: true,
  latencyMs: 120,
  isMock: false,
  outputPreview: 'Conexion verificada',
  ...overrides,
});

const buildPrompt = (overrides: Partial<AiPromptTemplate> = {}): AiPromptTemplate => ({
  id: PROMPT_ID,
  code: 'REDACCION_DE_NOTA_DE_PRENSA',
  name: 'Redaccion de nota de prensa',
  description: 'Convierte una nota en noticia publicable',
  active: true,
  createdById: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

describe('useLlmExtractorStore · configuracion del nodo PROCESADOR_IA', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchLlmModels.mockResolvedValue([]);
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia arrancar en el simulador, sin poder gastar dinero', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: mismo defecto que el backend. Un nodo al que
      //    nadie ha mirado la configuracion no debe poder facturar por omision.
      const store = useLlmExtractorStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.config.provider).toBe(LlmProvider.MOCK);
      expect(store.config.model).toBe(DEFAULT_LLM_MODEL);
      expect(store.config.dryRun).toBe(false);
    });

    it('1.2 deberia arrancar sin instruccion y por tanto invalido', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useLlmExtractorStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.config.templatePromptId).toBeNull();
      expect(store.config.inlinePrompt).toBe('');
      expect(store.isConfigValid).toBe(false);
    });

    it('1.3 deberia traer los defectos numericos del backend', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useLlmExtractorStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.config.timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
      expect(store.config.maxRetries).toBe(DEFAULT_LLM_MAX_RETRIES);
      expect(store.config.emergencyBrakeThreshold).toBe(DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD);
    });
  });

  describe('2. Validez: la instruccion', () => {
    it('2.1 deberia bastar una plantilla de prompt', () => {
      // 1. Arrange 📐: replica exacta del criterio de `getIncompleteParams`.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ templatePromptId: PROMPT_ID });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('2.2 deberia bastar una instruccion en linea', () => {
      // 1. Arrange 📐
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ inlinePrompt: 'Redacta a partir de {{parsed_email.clean_body}}' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
    });

    it('2.3 no deberia aceptar una instruccion de solo espacios', () => {
      // 1. Arrange 📐: el DTO la rechaza con `@IsNotEmpty`.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ inlinePrompt: '   ' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('2.4 deberia senalar el conflicto sin invalidarlo', () => {
      // 1. Arrange 📐: el backend resuelve eligiendo la PLANTILLA. No es un
      //    error, pero el operador tiene que saberlo antes de ejecutar y no
      //    despues de leer una redaccion que no esperaba.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ templatePromptId: PROMPT_ID, inlinePrompt: 'Otra cosa' });

      // 3. Assert 🎯
      expect(store.hasConflictingPrompts).toBe(true);
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('3. Validez: los rangos numericos', () => {
    it.each([
      ['timeoutMs', { timeoutMs: 999 }],
      ['timeoutMs', { timeoutMs: MAX_LLM_TIMEOUT_MS + 1 }],
      ['maxRetries', { maxRetries: -1 }],
      ['maxRetries', { maxRetries: 6 }],
      ['emergencyBrakeThreshold', { emergencyBrakeThreshold: 0 }],
      ['emergencyBrakeThreshold', { emergencyBrakeThreshold: 6 }],
    ])('3.1 deberia invalidar un %s fuera de rango', (_field, patch) => {
      // 1. Arrange 📐: el DTO los rechaza con un 400 sobre el esquema ENTERO, y
      //    el operador veria un error de guardado sin saber que campo lo causa.
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ templatePromptId: PROMPT_ID });

      // 2. Act ⚙️
      store.updateConfig(patch);

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('3.2 deberia invalidar un modelo vacio', () => {
      // 1. Arrange 📐
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ templatePromptId: PROMPT_ID });

      // 2. Act ⚙️
      store.updateConfig({ model: '  ' });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('4. Avisos de coste', () => {
    it('4.1 deberia avisar del gasto real con un proveedor de pago', () => {
      // 1. Arrange 📐
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ provider: LlmProvider.GEMINI, dryRun: false });

      // 3. Assert 🎯
      expect(store.configWarnings.join(' ')).toContain('tokens facturables');
    });

    it('4.2 no deberia avisar con la simulacion activada', () => {
      // 1. Arrange 📐
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ provider: LlmProvider.GEMINI, dryRun: true });

      // 3. Assert 🎯
      expect(store.configWarnings).toEqual([]);
    });

    it('4.3 deberia avisar de que un proveedor sin cliente degrada al simulador', () => {
      // 1. Arrange 📐: desde PROT-16 no falla, simula. Lo unico que distingue
      //    una redaccion real de una simulada es `metadata.isMock`, y elegir
      //    un proveedor creyendo que escribe el es el fallo caro.
      //
      //    Se ejerce con OPENAI y ya no con ANTHROPIC: desde PROT-20 Claude
      //    tiene cliente, asi que su aviso correcto ahora es el del gasto
      //    facturable, no el de la simulacion.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ provider: LlmProvider.OPENAI });

      // 3. Assert 🎯
      const warnings = store.configWarnings.join(' ');

      expect(warnings).toContain('simulador');
      expect(warnings).toContain('isMock');
    });

    it('4.4 deberia avisar del efecto multiplicativo de los reintentos', () => {
      // 1. Arrange 📐: el TSDoc del DTO advierte de hasta 36 inferencias
      //    facturadas por una sola ejecucion del flujo.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ maxRetries: 5 });

      // 3. Assert 🎯
      expect(store.configWarnings.join(' ')).toContain('MULTIPLICAN');
    });

    it('4.5 no deberia avisar con los reintentos por defecto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useLlmExtractorStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.configWarnings).toEqual([]);
    });
  });

  describe('5. Contrato con el pipeline_schema', () => {
    it('5.1 deberia omitir la instruccion que no se usa', () => {
      // 1. Arrange 📐: el DTO valida `@IsUUID` sobre `templatePromptId` y
      //    `@IsNotEmpty` sobre `inlinePrompt` si la clave viene, asi que
      //    publicar `null` o `''` devolveria un 400 sobre el flujo entero.
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ inlinePrompt: 'Redacta algo' });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params).not.toHaveProperty('templatePromptId');
      expect(params.inlinePrompt).toBe('Redacta algo');
    });

    it('5.2 deberia publicar SIEMPRE los numericos, aunque sean el defecto', () => {
      // 1. Arrange 📐: a diferencia del asunto del nodo de alerta, aqui el valor
      //    tiene consecuencias economicas. Dejarlo implicito significaria que
      //    cambiar un defecto del backend cambia en silencio el coste de flujos
      //    ya guardados.
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ templatePromptId: PROMPT_ID });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params).toMatchObject({
        provider: LlmProvider.MOCK,
        model: DEFAULT_LLM_MODEL,
        dryRun: false,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        maxRetries: DEFAULT_LLM_MAX_RETRIES,
        emergencyBrakeThreshold: DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
      });
    });

    it('5.3 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange 📐: contrato de ida y vuelta del registro de stores.
      const store = useLlmExtractorStore(nextNodeId());
      const params = {
        templatePromptId: PROMPT_ID,
        provider: LlmProvider.GEMINI,
        model: 'gemini-1.5-pro',
        dryRun: true,
        timeoutMs: 30_000,
        maxRetries: 1,
        emergencyBrakeThreshold: 2,
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'llm_response', params });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.4 deberia sobrevivir a unos params escritos por SQL directo', () => {
      // 1. Arrange 📐: la columna es `jsonb`. Un proveedor inventado dejaria el
      //    selector sin seleccion, y un timeout textual lo convertiria en NaN.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'llm_response',
        params: { provider: 'LLAMA', timeoutMs: 'mucho', dryRun: 'false' },
      });

      // 3. Assert 🎯
      expect(store.config.provider).toBe(LlmProvider.MOCK);
      expect(store.config.timeoutMs).toBe(DEFAULT_LLM_TIMEOUT_MS);
      expect(store.config.dryRun).toBe(false);
    });

    it('5.5 deberia devolver el nodo a su estado inicial', () => {
      // 1. Arrange 📐: la instancia del store sobrevive a la topologia que la
      //    creo, asi que sin esto un flujo nuevo arrancaria con el prompt y el
      //    proveedor del anterior.
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ templatePromptId: PROMPT_ID, provider: LlmProvider.GEMINI });

      // 2. Act ⚙️
      store.resetConfig();

      // 3. Assert 🎯
      expect(store.config.templatePromptId).toBeNull();
      expect(store.config.provider).toBe(LlmProvider.MOCK);
      expect(store.isConfigValid).toBe(false);
    });
  });

  describe('6. Catalogo de prompts y variables', () => {
    it('6.1 deberia poblar el selector con los prompts activos', async () => {
      // 1. Arrange 📐: `loadPrompts()` pide solo los activos por defecto, que es
      //    lo que el backend documenta para el selector del nodo IA.
      const store = useLlmExtractorStore(nextNodeId());
      fetchAiPromptTemplates.mockResolvedValue([buildPrompt()]);

      // 2. Act ⚙️
      await store.loadPrompts();

      // 3. Assert 🎯
      expect(fetchAiPromptTemplates).toHaveBeenCalledWith(true);
      expect(store.promptOptions).toEqual([
        {
          label: 'Redaccion de nota de prensa',
          value: PROMPT_ID,
          description: 'Convierte una nota en noticia publicable',
        },
      ]);
    });

    it('6.2 deberia componer las variables del contexto aguas arriba', () => {
      // 1. Arrange 📐: sin esto el operador tendria que recordar de memoria que
      //    publica cada paso anterior.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      store.setAvailableUpstreamContext([
        {
          namespace: 'parsed_email',
          fields: [{ name: 'clean_body', type: 'text' }],
        },
      ]);

      // 3. Assert 🎯
      expect(store.promptVariableOptions).toEqual([
        {
          label: 'clean_body (text)',
          value: '{{parsed_email.clean_body}}',
          group: 'parsed_email',
        },
      ]);
    });

    it('6.3 deberia compartir el catalogo entre dos nodos de IA', async () => {
      // 1. Arrange 📐: el catalogo es estado de DOMINIO y vive en su propio
      //    store, memoizado. Dos nodos no deben provocar dos peticiones.
      fetchAiPromptTemplates.mockResolvedValue([buildPrompt()]);
      const first = useLlmExtractorStore(nextNodeId());
      const second = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      await first.loadPrompts();
      await second.loadPrompts();

      // 3. Assert 🎯
      expect(fetchAiPromptTemplates).toHaveBeenCalledTimes(1);
      expect(second.promptOptions).toHaveLength(1);
      expect(useAiPromptTemplatesStore().prompts).toHaveLength(1);
    });
  });

  describe('8. Catalogo de modelos', () => {
    it('8.1 deberia ordenar los disponibles por delante de los que no lo estan', () => {
      // 1. Arrange 📐: ORDEN y no filtrado. Un modelo sin credencial se ve y
      //    se puede elegir, porque esconderlo dejaria sin pista a quien se
      //    pregunte por que su salida sale simulada.
      const store = useLlmExtractorStore(nextNodeId());
      store.availableModels = [
        buildDescriptor({ model: 'sin-clave', isAvailable: false }),
        buildDescriptor({ model: 'mock-engine', isAvailable: true, isTestOnly: true }),
        buildDescriptor({ model: 'con-clave', isAvailable: true }),
      ];
      // El modelo elegido tiene que ser uno del catalogo: si no, el store le
      // anadiria con razon una cuarta opcion "no catalogado" (ver 8.3).
      store.updateConfig({ model: 'con-clave' });

      // 2. Act ⚙️
      const values = store.modelOptions.map((option) => option.value);

      // 3. Assert 🎯
      expect(values[0]).toBe('con-clave');
      expect(values).toHaveLength(3);
    });

    it('8.2 deberia clasificar el simulador como prueba aunque este disponible', () => {
      // 1. Arrange 📐: `isTestOnly` manda sobre `isAvailable`; si no, el
      //    simulador saldria con el distintivo verde de "Configurado" y
      //    pareceria un proveedor real.
      const store = useLlmExtractorStore(nextNodeId());
      store.availableModels = [
        buildDescriptor({ model: 'mock-engine', isAvailable: true, isTestOnly: true }),
      ];
      store.updateConfig({ model: 'mock-engine' });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(store.modelOptions[0]?.availability).toBe('TEST_ONLY');
    });

    it('8.3 deberia conservar un modelo guardado que no figure en el catalogo', async () => {
      // 1. Arrange 📐: sin esto, un selector cerrado dejaria en blanco la
      //    configuracion de cualquier flujo que apunte a un modelo retirado de
      //    la tabla curada, y abrir el paso para mirarlo bastaria para
      //    romperlo al guardar.
      const store = useLlmExtractorStore(nextNodeId());
      fetchLlmModels.mockResolvedValue([buildDescriptor({ model: 'con-clave' })]);
      await store.fetchAvailableModels();

      // 2. Act ⚙️
      store.hydrateFromNode({
        outputNamespace: 'llm_response',
        params: { model: 'claude-3-5-sonnet-20241022', inlinePrompt: 'Redacta.' },
      });

      // 3. Assert 🎯: sigue elegible, marcado, y el viaje de vuelta lo conserva.
      const uncatalogued = store.modelOptions.find(
        (option) => option.value === 'claude-3-5-sonnet-20241022',
      );

      expect(uncatalogued?.isUncatalogued).toBe(true);
      expect(uncatalogued?.label).toContain('no catalogado');
      expect(store.toNodeParams().model).toBe('claude-3-5-sonnet-20241022');
    });

    it('8.4 NO deberia memorizar el catalogo entre llamadas', async () => {
      // 1. Arrange 📐: el caso que esta pantalla resuelve es el de alguien que
      //    acaba de poner una credencial que faltaba. Cachearlo le mostraria
      //    el estado anterior hasta recargar la aplicacion entera.
      const store = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      await store.fetchAvailableModels();
      await store.fetchAvailableModels();

      // 3. Assert 🎯
      expect(fetchLlmModels).toHaveBeenCalledTimes(2);
    });
  });

  describe('9. Prueba de conectividad', () => {
    it('9.1 deberia enviar el par proveedor/modelo elegido y guardar el resultado', async () => {
      // 1. Arrange 📐
      const store = useLlmExtractorStore(nextNodeId());
      store.updateConfig({ provider: LlmProvider.ANTHROPIC, model: '  claude-sonnet-5-5  ' });
      testLlmConnection.mockResolvedValue(buildConnectionResult());

      // 2. Act ⚙️
      const result = await store.testConnection();

      // 3. Assert 🎯: el modelo viaja recortado, como en `toNodeParams`.
      expect(testLlmConnection).toHaveBeenCalledWith({
        provider: LlmProvider.ANTHROPIC,
        model: 'claude-sonnet-5-5',
      });
      expect(result.success).toBe(true);
      expect(store.lastConnectionResult).toEqual(result);
      expect(store.isTestingConnection).toBe(false);
    });

    it('9.2 deberia guardar un fallo diagnosticado en vez de lanzarlo', async () => {
      // 1. Arrange 📐: llega como 200 con `success: false`; es la respuesta
      //    que el formulario tiene que mostrar, no una excepcion.
      const store = useLlmExtractorStore(nextNodeId());
      testLlmConnection.mockResolvedValue(
        buildConnectionResult({
          success: false,
          error: { level: 'GRAVE', message: 'El proveedor rechazo la peticion' },
        }),
      );

      // 2. Act ⚙️
      const result = await store.testConnection();

      // 3. Assert 🎯
      expect(result.success).toBe(false);
      expect(store.lastConnectionResult?.error?.message).toContain('rechazo');
    });

    it('9.3 deberia apagar el indicador aunque la peticion reviente', async () => {
      // 1. Arrange 📐: el store solo garantiza el `finally`; traducir el error
      //    es cosa del componente (`frontend-architecture.md` §2.1).
      const store = useLlmExtractorStore(nextNodeId());
      testLlmConnection.mockRejectedValue(new Error('Network Error'));

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(store.testConnection()).rejects.toThrow('Network Error');
      expect(store.isTestingConnection).toBe(false);
    });

    it('9.4 deberia invalidar el resultado al cambiar de proveedor o de modelo', async () => {
      // 1. Arrange 📐: dejar "conexion correcta" en pantalla despues de
      //    cambiar el par que la produjo es peor que no haber probado nunca.
      const store = useLlmExtractorStore(nextNodeId());
      testLlmConnection.mockResolvedValue(buildConnectionResult());
      await store.testConnection();
      expect(store.lastConnectionResult).not.toBeNull();

      // 2. Act ⚙️
      store.updateConfig({ provider: LlmProvider.GEMINI });

      // 3. Assert 🎯
      expect(store.lastConnectionResult).toBeNull();
    });

    it('9.5 no deberia invalidarlo al tocar un campo ajeno al par', async () => {
      // 1. Arrange 📐: subir el timeout no cambia si la credencial sirve.
      const store = useLlmExtractorStore(nextNodeId());
      testLlmConnection.mockResolvedValue(buildConnectionResult());
      await store.testConnection();

      // 2. Act ⚙️
      store.updateConfig({ timeoutMs: MAX_LLM_TIMEOUT_MS });

      // 3. Assert 🎯
      expect(store.lastConnectionResult).not.toBeNull();
    });
  });

  describe('7. Aislamiento entre nodos', () => {
    it('7.1 no deberia compartir configuracion entre dos inferencias del flujo', () => {
      // 1. Arrange 📐: un flujo puede encadenar una redaccion y un resumen con
      //    prompts y presupuestos distintos.
      const redaccion = useLlmExtractorStore(nextNodeId());
      const resumen = useLlmExtractorStore(nextNodeId());

      // 2. Act ⚙️
      redaccion.updateConfig({ provider: LlmProvider.GEMINI, maxRetries: 0 });

      // 3. Assert 🎯
      expect(resumen.config.provider).toBe(LlmProvider.MOCK);
      expect(resumen.config.maxRetries).toBe(DEFAULT_LLM_MAX_RETRIES);
    });
  });
});
