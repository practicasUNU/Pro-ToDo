import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { LlmProvider } from '@/types/nodes/llm-extractor.types';
import {
  DEFAULT_OCR_MAX_RETRIES,
  DEFAULT_OCR_MODEL,
  DEFAULT_OCR_TEMPERATURE,
  DEFAULT_OCR_TIMEOUT_MS,
  MAX_OCR_RETRIES,
  MAX_OCR_TEMPERATURE,
  MAX_OCR_TIMEOUT_MS,
  MIN_OCR_RETRIES,
  MIN_OCR_TEMPERATURE,
  MIN_OCR_TIMEOUT_MS,
} from '@/types/nodes/ocr-processor.types';

import { useSessionStore } from '@stores/session.store';
import { fetchLlmModels } from '@services/nodes/llm-extractor.service';
import { buildModelOptions, isModelForbidden } from '@/utils/llm-model-options';

import type { HydratableNode } from '@stores/nodes/node-store-registry';
import type { OcrProcessorNodeConfig } from '@/types/nodes/ocr-processor.types';
import type { LlmModelDescriptor, LlmModelOption } from '@/types/nodes/llm-extractor.types';

/** Lee una cadena de los `params` crudos del esquema. */
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Lee un numero de los `params` crudos, con respaldo si la columna trae basura. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Un valor esta dentro del rango cerrado. */
const isWithin = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

const buildInitialConfig = (): OcrProcessorNodeConfig => ({
  provider: LlmProvider.GEMINI,
  model: DEFAULT_OCR_MODEL,
  temperature: DEFAULT_OCR_TEMPERATURE,
  timeoutMs: DEFAULT_OCR_TIMEOUT_MS,
  maxRetries: DEFAULT_OCR_MAX_RETRIES,
  dryRun: false,
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'ocrProcessorNode';

// Estado reactivo del nodo PROCESADOR_OCR (regla frontend-quasar.md §3.1).
//
// SIGUE SIN BOTON DE PRUEBA, y por el motivo de siempre: una simulacion de OCR
// desde el asistente facturaria una inferencia cada vez que alguien reabre el
// paso, y el banco de pruebas del flujo completo ya cubre esa necesidad.
//
// Si CONSUME el catalogo de modelos desde PROT-22. No es una capa de servicios
// propia: la ruta `/llm/models` es del catalogo y ya la posee
// `services/nodes/llm-extractor.service.ts`; envolverla aqui seria la capa
// vacia que `frontend-architecture.md` §2.1 desaconseja.
const ocrProcessorSetup = () => {
  const sessionStore = useSessionStore();
  const config = ref<OcrProcessorNodeConfig>(buildInitialConfig());
  const availableModels = ref<LlmModelDescriptor[]>([]);
  const isLoadingModels = ref(false);

  /** Opciones del selector, con los de pago marcados segun el rol. */
  const modelOptions = computed<LlmModelOption[]>(() =>
    buildModelOptions(
      availableModels.value,
      config.value.model,
      config.value.provider,
      sessionStore.isAdmin,
    ),
  );

  /**
   * ¿El modelo elegido esta vetado para este rol?
   *
   * Invalida el paso para que el asistente NO deje avanzar hasta chocar con el
   * 403 del backend: llegar al final del formulario y descubrir alli que el
   * modelo no se podia usar es el fallo que el Poka-Yoke viene a evitar.
   */
  const isSelectedModelForbidden = computed<boolean>(() =>
    isModelForbidden(modelOptions.value, config.value.model),
  );

  const fetchAvailableModels = async (): Promise<void> => {
    isLoadingModels.value = true;

    try {
      availableModels.value = await fetchLlmModels();
    } finally {
      isLoadingModels.value = false;
    }
  };

  /**
   * Contrato Poka-Yoke que el stepper consulta para habilitar "Siguiente".
   *
   * NO exige plantilla de prompt, a diferencia del nodo de redaccion: el de este
   * nodo es del sistema. Lo que se comprueba son los rangos que el DTO del
   * backend rechazaria con un 400 sobre el esquema ENTERO, donde el operador ya
   * no sabria que campo lo causo.
   */
  const isConfigValid = computed<boolean>(
    () =>
      config.value.model.trim() !== '' &&
      isWithin(config.value.temperature, MIN_OCR_TEMPERATURE, MAX_OCR_TEMPERATURE) &&
      isWithin(config.value.timeoutMs, MIN_OCR_TIMEOUT_MS, MAX_OCR_TIMEOUT_MS) &&
      isWithin(config.value.maxRetries, MIN_OCR_RETRIES, MAX_OCR_RETRIES) &&
      !isSelectedModelForbidden.value,
  );

  /**
   * Avisos que NO bloquean el guardado pero conviene leer antes.
   *
   * Una temperatura alta en una transcripcion no es un error de configuracion
   * —el DTO la admite— pero si un mal negocio: el modelo empieza a "mejorar" lo
   * que lee, y una transcripcion que se aparta del original es peor que no
   * tenerla, porque nadie la revisa.
   */
  const configWarnings = computed<string[]>(() =>
    config.value.temperature > DEFAULT_OCR_TEMPERATURE
      ? [
          `La temperatura ${config.value.temperature} deja al modelo apartarse de lo que pone en la imagen. Para transcribir, ${DEFAULT_OCR_TEMPERATURE} es lo recomendable.`,
        ]
      : [],
  );

  const updateConfig = (patch: Partial<OcrProcessorNodeConfig>): void => {
    config.value = { ...config.value, ...patch };
  };

  /**
   * `params` que viajan al `pipeline_schema`.
   *
   * El prompt NO viaja: lo pone el backend, que es su unico dueno. Mandarlo
   * desde aqui crearia una segunda copia que se quedaria vieja en cuanto alguien
   * afinara el texto del sistema.
   */
  const toNodeParams = (): Record<string, unknown> => ({
    provider: config.value.provider,
    model: config.value.model.trim(),
    temperature: config.value.temperature,
    timeoutMs: config.value.timeoutMs,
    maxRetries: config.value.maxRetries,
    ...(config.value.dryRun ? { dryRun: true } : {}),
  });

  /** Carga la configuracion de un nodo ya guardado en el `pipeline_schema`. */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;
    const provider = asText(params.provider);

    config.value = {
      provider: Object.values(LlmProvider).includes(provider as LlmProvider)
        ? (provider as LlmProvider)
        : LlmProvider.GEMINI,
      model: asText(params.model) || DEFAULT_OCR_MODEL,
      temperature: asNumber(params.temperature, DEFAULT_OCR_TEMPERATURE),
      timeoutMs: asNumber(params.timeoutMs, DEFAULT_OCR_TIMEOUT_MS),
      maxRetries: asNumber(params.maxRetries, DEFAULT_OCR_MAX_RETRIES),
      dryRun: params.dryRun === true,
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
  };

  return {
    config,
    availableModels,
    isLoadingModels,
    modelOptions,
    isSelectedModelForbidden,
    fetchAvailableModels,
    isConfigValid,
    configWarnings,
    updateConfig,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro por el mismo motivo que en los demas: es lo que
 * garantiza que el satelite `ocr_ia` y el `procesador_ia` del camino nominal no
 * se pisen la configuracion, aunque los dos hablen con un modelo.
 */
const buildOcrProcessorStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, ocrProcessorSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type OcrProcessorStore = ReturnType<ReturnType<typeof buildOcrProcessorStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildOcrProcessorStore>>();

/** Store del nodo PROCESADOR_OCR identificado por `nodeId`. */
export const useOcrProcessorStore = (nodeId: string): OcrProcessorStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildOcrProcessorStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
