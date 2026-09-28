import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useOcrProcessorStore } from './ocr-processor.store';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import { DEFAULT_OCR_MODEL, DEFAULT_OCR_TEMPERATURE } from '@/types/nodes/ocr-processor.types';

/** `nodeId` unico por prueba: las definiciones de Pinia se memoizan por modulo. */
let nodeCounter = 0;
const nextNodeId = (): string => `ocr_ia_${(nodeCounter += 1)}`;

describe('useOcrProcessorStore · configuracion del nodo PROCESADOR_OCR', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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

      // 3. Assert 🎯
      expect(store.isConfigValid).toBe(true);
      expect(store.configWarnings).toHaveLength(1);
    });
  });

  describe('3. Contrato con el pipeline_schema', () => {
    it('3.1 NO deberia mandar el prompt en los params', () => {
      // 1. Arrange 📐: lo pone el backend, que es su unico dueno. Mandarlo desde
      //    aqui crearia una segunda copia que se quedaria vieja en cuanto
      //    alguien afinara el texto del sistema.
      const store = useOcrProcessorStore(nextNodeId());

      // 2. Act ⚙️
      const params = store.toNodeParams();

      // 3. Assert 🎯
      expect(params.prompt).toBeUndefined();
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
});
