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
  MAX_OCR_CUSTOM_PROMPT_LENGTH,
  PROMPT_OCR_MULTIMODAL,
} from '@/types/nodes/ocr-processor.types';

import { useSessionStore } from '@stores/session.store';
import { fetchLlmModels, testLlmConnection } from '@services/nodes/llm-extractor.service';
import { buildModelOptions, isModelForbidden } from '@/utils/llm-model-options';

import type { HydratableNode } from '@stores/nodes/node-store-registry';
import type { OcrProcessorNodeConfig } from '@/types/nodes/ocr-processor.types';
import type {
  LlmModelDescriptor,
  LlmModelOption,
  LlmTestConnectionResult,
} from '@/types/nodes/llm-extractor.types';

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
  customPrompt: null,
});

/**
 * Prompt que se guardaria: `null` si no hay prompt propio o si coincide con el
 * del sistema (guardar una copia identica la dejaria vieja en cuanto el backend
 * afinara el suyo).
 */
const effectiveCustomPrompt = (customPrompt: string | null): string | null => {
  const trimmed = customPrompt?.trim() ?? '';

  return trimmed === '' || trimmed === PROMPT_OCR_MULTIMODAL ? null : trimmed;
};

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'ocrProcessorNode';

// Estado reactivo del nodo PROCESADOR_OCR (regla frontend-quasar.md §3.1).
//
// GANA EL BOTON DE PRUEBA, revirtiendo la decision anterior de no tenerlo. El
// motivo de aquella —"facturaria una inferencia cada vez que alguien reabre el
// paso"— daba por hecho que la prueba se dispararia sola; no es el caso: la
// lanza el operador pulsando, igual que en el nodo de redaccion, y su resultado
// entra en `configWarnings` SIN tocar `isConfigValid`, de modo que nadie se ve
// obligado a pulsarla para poder avanzar. El coste pasa a ser una eleccion y no
// un peaje, y a cambio el par proveedor/modelo deja de comprobarse por primera
// vez en ejecucion, con el flujo ya PAUSADO.
//
// CONSUME el catalogo y el banco de pruebas desde PROT-22. No es una capa de
// servicios propia: las rutas `/llm/models` y `/llm/test-connection` son del
// catalogo y ya las posee `services/nodes/llm-extractor.service.ts`; envolverlas
// aqui seria la capa vacia que `frontend-architecture.md` §2.1 desaconseja. El
// OCR comparte ademas el mismo camino de proveedores que la IA
// (`LlmProviderFactory` en el backend), asi que la prueba es la misma prueba.
const ocrProcessorSetup = () => {
  const sessionStore = useSessionStore();
  const config = ref<OcrProcessorNodeConfig>(buildInitialConfig());
  const availableModels = ref<LlmModelDescriptor[]>([]);
  const isLoadingModels = ref(false);
  const isTestingConnection = ref(false);
  const lastConnectionResult = ref<LlmTestConnectionResult | null>(null);

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

  /** Hay un par proveedor/modelo que probar y no hay una prueba en vuelo. */
  const canTestConnection = computed<boolean>(
    () => config.value.model.trim() !== '' && !isTestingConnection.value,
  );

  /**
   * Lanza una inferencia minima contra el proveedor elegido.
   *
   * No captura el error: `frontend-architecture.md` §2.1 deja al componente
   * decidir el mensaje. El `finally` solo garantiza que el boton no se quede
   * girando.
   */
  const testConnection = async (): Promise<LlmTestConnectionResult> => {
    isTestingConnection.value = true;

    try {
      const result = await testLlmConnection({
        provider: config.value.provider,
        model: config.value.model.trim(),
      });

      lastConnectionResult.value = result;

      return result;
    } finally {
      isTestingConnection.value = false;
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
  /**
   * Un prompt propio ACTIVADO no puede quedar vacio (el backend lo rechazaria
   * con `IsNotEmpty`) ni pasar del techo. Desactivado (`null`) siempre vale.
   */
  const isCustomPromptValid = computed<boolean>(() => {
    const { customPrompt } = config.value;

    return (
      customPrompt === null ||
      (customPrompt.trim() !== '' && customPrompt.length <= MAX_OCR_CUSTOM_PROMPT_LENGTH)
    );
  });

  const isConfigValid = computed<boolean>(
    () =>
      config.value.model.trim() !== '' &&
      isWithin(config.value.temperature, MIN_OCR_TEMPERATURE, MAX_OCR_TEMPERATURE) &&
      isWithin(config.value.timeoutMs, MIN_OCR_TIMEOUT_MS, MAX_OCR_TIMEOUT_MS) &&
      isWithin(config.value.maxRetries, MIN_OCR_RETRIES, MAX_OCR_RETRIES) &&
      isCustomPromptValid.value &&
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
  const configWarnings = computed<string[]>(() => {
    const warnings: string[] = [];

    if (config.value.temperature > DEFAULT_OCR_TEMPERATURE) {
      warnings.push(
        `La temperatura ${config.value.temperature} deja al modelo apartarse de lo que pone en la imagen. Para transcribir, ${DEFAULT_OCR_TEMPERATURE} es lo recomendable.`,
      );
    }

    // `null` cubre las dos situaciones que para el operador son la misma: nunca
    // se probo, o el cambio de proveedor/modelo invalido el resultado anterior.
    if (lastConnectionResult.value === null) {
      warnings.push(
        'Este nodo todavia no ha superado una prueba de conexion con el proveedor elegido. Pulsa "Probar conexion" para confirmar que la clave existe y el modelo responde.',
      );
    } else if (!lastConnectionResult.value.success) {
      warnings.push(
        `La ultima prueba de conexion fallo: ${lastConnectionResult.value.error?.message ?? 'sin detalle del proveedor'}. Guardar asi deja un flujo que reventara en su primera ejecucion.`,
      );
    } else if (lastConnectionResult.value.isMock) {
      // Un exito simulado NO puede apagar el aviso: un proveedor sin clave no
      // falla, degrada. En un OCR eso significa publicar como transcripcion un
      // texto que nadie leyo de la imagen.
      warnings.push(
        'La prueba de conexion la respondio el SIMULADOR, no el proveedor elegido: falta su clave de API en el servidor. La transcripcion seria texto simulado, no lo que pone en la imagen.',
      );
    }

    return warnings;
  });

  const updateConfig = (patch: Partial<OcrProcessorNodeConfig>): void => {
    config.value = { ...config.value, ...patch };

    // CASCADA proveedor -> modelo. Cambiar de proveedor invalida el modelo
    // elegido: el catalogo filtra por proveedor, de modo que conservarlo
    // dejaria el campo apuntando a un valor que ya no figura entre las
    // opciones, y el formulario se veria completo hasta que el backend
    // rechazara la combinacion al guardar.
    //
    // Vive en el STORE y no en el componente porque es un invariante del
    // dominio del nodo —`isConfigValid` depende de el— y no una reaccion de un
    // formulario concreto (`frontend-quasar.md` §3.1).
    if (patch.provider !== undefined && patch.model === undefined) {
      config.value = { ...config.value, model: '' };
    }

    // Un resultado de prueba no puede sobrevivir al par que lo produjo: dejar
    // "conexion correcta" en pantalla despues de cambiar de proveedor es peor
    // que no haber probado nunca. Mismo criterio que el nodo de redaccion.
    if (patch.provider !== undefined || patch.model !== undefined) {
      lastConnectionResult.value = null;
    }
  };

  /**
   * `params` que viajan al `pipeline_schema`.
   *
   * El prompt del SISTEMA no viaja: lo pone el backend, que es su unico dueno.
   * Solo viaja `customPrompt` cuando el nodo tiene uno propio y distinto.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const customPrompt = effectiveCustomPrompt(config.value.customPrompt);

    return {
      provider: config.value.provider,
      model: config.value.model.trim(),
      temperature: config.value.temperature,
      timeoutMs: config.value.timeoutMs,
      maxRetries: config.value.maxRetries,
      ...(config.value.dryRun ? { dryRun: true } : {}),
      ...(customPrompt !== null ? { customPrompt } : {}),
    };
  };

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
      customPrompt: effectiveCustomPrompt(asText(params.customPrompt)),
    };

    lastConnectionResult.value = null;
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    lastConnectionResult.value = null;
  };

  return {
    config,
    availableModels,
    isLoadingModels,
    modelOptions,
    isSelectedModelForbidden,
    isTestingConnection,
    lastConnectionResult,
    canTestConnection,
    fetchAvailableModels,
    testConnection,
    isConfigValid,
    isCustomPromptValid,
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
