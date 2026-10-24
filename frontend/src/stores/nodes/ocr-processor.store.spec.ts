// @vitest-environment happy-dom
//
// Necesita DOM porque el store del nodo consulta `useSessionStore` para saber
// si el usuario puede elegir modelos de pago, y esa cadena llega a
// `LocalStorage` de Quasar, que toca `window`.

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionStore } from '@stores/session.store';
import * as llmExtractorService from '@services/nodes/llm-extractor.service';

import { useOcrProcessorStore } from './ocr-processor.store';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import {
  DEFAULT_OCR_MODEL,
  DEFAULT_OCR_TEMPERATURE,
  MAX_OCR_CUSTOM_PROMPT_LENGTH,
  PROMPT_OCR_MULTIMODAL,
} from '@/types/nodes/ocr-processor.types';
import { UserRole } from '@/types/user';

import type { LlmModelDescriptor } from '@/types/nodes/llm-extractor.types';

// `useSessionStore` llega aqui por el selector de modelo, que consulta el rol
// para deshabilitar los modelos de pago. Se dobla el SERVICIO y no axios:
// `@boot/axios` importa `#q-app`, que no resuelve fuera del build de Quasar.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

// El catalogo de modelos lo sirve el servicio del nodo de IA: la ruta
// `/llm/models` es del catalogo y ya la posee ese archivo.
vi.mock('@services/nodes/llm-extractor.service', () => ({
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}));

const fetchLlmModels = vi.mocked(llmExtractorService.fetchLlmModels);

/** Catalogo doblado: un modelo gratuito y uno reservado al ADMIN. */
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

/** Deja la sesion con el rol indicado. */
const signInAs = (role: UserRole): void => {
  useSessionStore().user = {
    id: 'u1',
    email: role === UserRole.ADMIN ? 'admin@unuware.com' : 'editor@unuware.com',
    role,
  };
};

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `ocr_ia_${(nodeCounter += 1)}`;

describe('useOcrProcessorStore · configuracion del nodo PROCESADOR_OCR', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    fetchLlmModels.mockResolvedValue([]);
  });

  describe('1. Estado inicial', () => {
    it('1.1 deberia nacer VALIDO, sin pedir plantilla de prompt', () => {
      // 1. Arrange 📐: es la diferencia con el nodo de redaccion, que sin
      //    plantilla no puede avanzar. Aqui el prompt lo pone el sistema, asi
      //    que un satelite recien provisionado ya es ejecutable.
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
      expect(store.config.model).toBe(DEFAULT_OCR_MODEL);
      expect(store.config.temperature).toBe(DEFAULT_OCR_TEMPERATURE);
    });
  });

  describe('2. Validez', () => {
    it('2.1 deberia invalidar una temperatura fuera de rango', () => {
      // 1. Arrange 📐: el DTO del backend la rechaza con un 400 sobre el esquema
      //    ENTERO, donde el operador ya no sabria que campo lo causo.
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ temperature: 2 });

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(false);
    });

    it('2.2 deberia AVISAR sin bloquear con una temperatura alta pero legal', () => {
      // 1. Arrange 📐: no es un error de configuracion —el DTO la admite— pero
      //    si un mal negocio: el modelo empieza a "mejorar" lo que lee, y una
      //    transcripcion que se aparta del original es peor que no tenerla,
      //    porque nadie la revisa.
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ temperature: 0.9 });

      // 3. Assert 🎯: se afirma sobre el CONTENIDO del aviso y no sobre cuantos
      // hay. Desde que la prueba de conexion avisa, un nodo recien creado nunca
      // tiene un solo aviso, y contar habria atado este caso a un detalle ajeno
      // a lo que comprueba.
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings.join(' ')).toContain('temperatura 0.9');
    });
  });

  /**
   * El boton de prueba revierte la decision anterior de no tenerlo. Lo que hace
   * aceptable el coste es que NO bloquea: su ausencia avisa, no invalida.
   */
  describe('2bis. Prueba de conexion', () => {
    it('2bis.1 deberia avisar mientras no haya una prueba vigente, sin invalidar', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const store = useOcrProcessorStore(nextNodeId());

      // 3. Assert 🎯
      expect(store.configWarnings.join(' ')).toContain('prueba de conexion');
      expect(store.isConfigValid).toBe(true);
    });

    it('2bis.2 deberia invalidar el resultado al cambiar de modelo', () => {
      // 1. Arrange 📐: dejar "conexion correcta" en pantalla despues de cambiar
      //    el par que la produjo es peor que no haber probado nunca.
      const store = useOcrProcessorStore(nextNodeId());
      store.lastConnectionResult = {
        success: true,
        latencyMs: 120,
        isMock: false,
        outputPreview: 'ok',
      };

      // 2. Act ⚙️
      store.updateConfig({ model: 'gemini-2.0-flash' });

      // 3. Assert 🎯
      expect(store.lastConnectionResult).toBeNull();
    });

    it('2bis.3 no deberia invalidar el resultado al tocar un campo ajeno al par', () => {
      // 1. Arrange 📐: la temperatura no cambia con quien se habla, asi que
      //    tirar la prueba obligaria a repetirla —y a pagarla— sin motivo.
      const store = useOcrProcessorStore(nextNodeId());
      store.lastConnectionResult = {
        success: true,
        latencyMs: 120,
        isMock: false,
        outputPreview: 'ok',
      };

      // 2. Act ⚙️
      store.updateConfig({ temperature: 0.2 });

      // 3. Assert 🎯
      expect(store.lastConnectionResult).not.toBeNull();
    });

    it('2bis.4 deberia bloquear el boton sin modelo elegido', () => {
      // 1. Arrange 📐
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({ model: '   ' });

      // 3. Assert 🎯: sin modelo no hay nada que probar y el backend
      // responderia un 400 sobre un `@IsNotEmpty`.
      expect(store.canTestConnection).toBe(false);
    });
  });

  describe('3. Contrato con el pipeline_schema', () => {
    it('3.1 NO deberia mandar el prompt del sistema en los params', () => {
      // 1. Arrange 📐: lo pone el backend, que es su unico dueno. Mandarlo desde
      //    aqui crearia una segunda copia que se quedaria vieja en cuanto
      //    alguien afinara el texto del sistema.
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params.prompt).toBeUndefined();
      expect(params.customPrompt).toBeUndefined();
      expect(params.templatePromptId).toBeUndefined();
      expect(params.model).toBe(DEFAULT_OCR_MODEL);
    });

    it('3.2 deberia reproducir los params al hidratar y volver a publicar', () => {
      // 1. Arrange 📐: contrato de ida y vuelta del registro de stores.
      const store = useOcrProcessorStore(nextNodeId());
      const params = {
        provider: LlmProvider.GEMINI,
        model: 'gemini-2.0-flash',
        temperature: 0.1,
        timeoutMs: 45_000,
        maxRetries: 1,
      };

      // 2. Act ⚙️
      store.hydrateFromNode({ outputNamespace: 'ocr_result', params });

      // 3. Assert 🎯
      expect(store.toNodeParams()).toEqual(params);
    });
  });

  describe('3bis. Prompt personalizado', () => {
    it('3bis.1 deberia publicar customPrompt recortado y recuperarlo al hidratar', () => {
      // 1. Arrange 📐
      const store = useOcrProcessorStore(nextNodeId());
      store.updateConfig({ customPrompt: '  Ignora sellos y firmas.  ' });

      // 2. Act ⚙️
      const params = store.toNodeParams();
      const other = useOcrProcessorStore(nextNodeId());
      other.hydrateFromNode({ outputNamespace: 'ocr_result', params });

      // 3. Assert 🎯
      expect(params.customPrompt).toBe('Ignora sellos y firmas.');
      expect(other.config.customPrompt).toBe('Ignora sellos y firmas.');
    });

    it('3bis.2 NO deberia publicar una copia identica del prompt del sistema', () => {
      // 1. Arrange 📐: activar el toggle sin tocar el texto no es personalizar.
      const store = useOcrProcessorStore(nextNodeId());
      store.updateConfig({ customPrompt: PROMPT_OCR_MULTIMODAL });

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params.customPrompt).toBeUndefined();
    });

    it('3bis.3 deberia invalidar el nodo con un prompt propio vacio o demasiado largo', () => {
      // 1. Arrange 📐
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️ + 3. Assert 🎯
      store.updateConfig({ customPrompt: '   ' });
      expect(store.isConfigValid).toBe(false);

      store.updateConfig({ customPrompt: 'x'.repeat(MAX_OCR_CUSTOM_PROMPT_LENGTH + 1) });
      expect(store.isConfigValid).toBe(false);

      store.updateConfig({ customPrompt: null });
      expect(store.isConfigValid).toBe(true);
    });
  });

  describe('4. Aislamiento por nodo', () => {
    it('4.1 NO deberia compartir configuracion con otro nodo del flujo', () => {
      // 1. Arrange 📐: el satelite `ocr_ia` y el `procesador_ia` del camino
      //    nominal hablan los dos con un modelo, y con un id fijo compartirian
      //    una sola instancia: cambiar el modelo de uno moveria el del otro.
      const satellite = useOcrProcessorStore('ocr_ia');
      const otro = useOcrProcessorStore('ocr_ia_secundario');

      // 2. Act ⚙️
      satellite.updateConfig({ model: 'gemini-2.0-flash' });

      // 3. Assert 🎯
      expect(otro.config.model).toBe(DEFAULT_OCR_MODEL);
    });
  });

  describe('5. Modelos reservados al rol ADMIN', () => {
    it('5.1 deberia marcar como deshabilitado un modelo de pago para un EDITOR', async () => {
      // 1. Arrange 📐: es COMODIDAD, no la barrera. Quien decide es el backend
      //    al guardar; aqui solo se evita que el operador rellene el
      //    formulario entero para toparse con un 403.
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      await store.fetchAvailableModels();

      // 3. Assert 🎯: el catalogo se filtra por proveedor, asi que cada modelo
      //    se mira con el suyo elegido; con los dos a la vez, uno de los dos
      //    no figuraria entre las opciones.
      store.updateConfig({ provider: LlmProvider.ANTHROPIC });
      const paid = store.modelOptions.find((option) => option.value === 'claude-haiku-4-5');

      store.updateConfig({ provider: LlmProvider.GEMINI });
      const free = store.modelOptions.find((option) => option.value === 'gemini-1.5-flash');

      expect(paid?.disable).toBe(true);
      expect(free?.disable).toBe(false);
    });

    it('5.2 deberia habilitarlo para un ADMIN', async () => {
      // 1. Arrange 📐
      signInAs(UserRole.ADMIN);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      await store.fetchAvailableModels();
      store.updateConfig({ provider: LlmProvider.ANTHROPIC });

      // 3. Assert 🎯
      expect(
        store.modelOptions.find((option) => option.value === 'claude-haiku-4-5')?.disable,
      ).toBe(false);
    });

    it('5.3 deberia INVALIDAR el paso si el modelo elegido esta vetado', async () => {
      // 1. Arrange 📐: sin esto el asistente dejaria avanzar hasta el final y
      //    el flujo moriria con un 403 al guardar, que es exactamente el fallo
      //    que el Poka-Yoke viene a evitar.
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());
      await store.fetchAvailableModels();

      // 2. Act ⚙️: el proveedor primero, porque cambiarlo limpia el modelo.
      store.updateConfig({ provider: LlmProvider.ANTHROPIC });
      store.updateConfig({ model: 'claude-haiku-4-5' });

      // 3. Assert 🎯
      expect(store.isSelectedModelForbidden).toBe(true);
      expect(store.isConfigValid).toBe(false);
    });

    it('5.3b deberia LIMPIAR el modelo al cambiar de proveedor', async () => {
      // 1. Arrange 📐: sin esto quedaba `ANTHROPIC` + `gemini-...`, una
      //    combinacion que el formulario daba por buena y que el backend
      //    rechazaba al guardar, despues de rellenarlo entero.
      signInAs(UserRole.ADMIN);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());
      await store.fetchAvailableModels();
      store.updateConfig({ model: 'gemini-1.5-flash' });

      // 2. Act ⚙️
      store.updateConfig({ provider: LlmProvider.ANTHROPIC });

      // 3. Assert 🎯
      expect(store.config.model).toBe('');
    });

    it('5.3c NO deberia limpiar el modelo si llega junto al proveedor', () => {
      // 1. Arrange 📐: restaurar un nodo guardado escribe los dos campos a la
      //    vez. Limpiar ahi vaciaria la configuracion justo al cargarla.
      signInAs(UserRole.ADMIN);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      store.updateConfig({
        provider: LlmProvider.ANTHROPIC,
        model: 'claude-haiku-4-5',
      });

      // 3. Assert 🎯
      expect(store.config.model).toBe('claude-haiku-4-5');
    });

    it('5.4 NO deberia vetar un modelo guardado que no figura en el catalogo', async () => {
      // 1. Arrange 📐: es el valor que el flujo YA tiene. Bloquearlo impediria
      //    abrir el paso para cambiarlo por otro.
      signInAs(UserRole.EDITOR);
      fetchLlmModels.mockResolvedValue(CATALOG);
      const store = useOcrProcessorStore(nextNodeId());
      await store.fetchAvailableModels();

      // 2. Act ⚙️
      store.updateConfig({ model: 'modelo-retirado' });

      // 3. Assert 🎯
      expect(store.isSelectedModelForbidden).toBe(false);
      expect(store.isConfigValid).toBe(true);
    });

    it('5.5 deberia apagar el indicador de carga aunque el catalogo falle', async () => {
      // 1. Arrange 📐: el store solo garantiza el `finally`; el mensaje al
      //    usuario lo decide el componente (`frontend-architecture.md` §2.1).
      fetchLlmModels.mockRejectedValue(new Error('503'));
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(store.fetchAvailableModels()).rejects.toThrow('503');
      expect(store.isLoadingModels).toBe(false);
    });
  });
});
