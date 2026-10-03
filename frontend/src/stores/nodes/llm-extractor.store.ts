import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as llmExtractorService from '@services/nodes/llm-extractor.service';
import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';

import {
  DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TIMEOUT_MS,
  IMPLEMENTED_LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  LLM_RETRIES_WARNING_THRESHOLD,
  LlmProvider,
  MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MIN_LLM_RETRIES,
  MIN_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

import { useSessionStore } from '@stores/session.store';
import { buildModelOptions } from '@/utils/llm-model-options';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type {
  LlmExtractorNodeConfig,
  LlmModelAvailability,
  LlmModelDescriptor,
  LlmModelOption,
  LlmTestConnectionResult,
} from '@/types/nodes/llm-extractor.types';

// Se RE-EXPORTA porque el tipo vivia aqui hasta PROT-22 y varios componentes lo
// importan de este modulo. Su sitio es `types/`, ahora que lo comparten los dos
// nodos que consumen un LLM.
export type { LlmModelOption };

/** Opcion de variable interpolable que el prompt en linea puede citar. */
export interface PromptVariableOption {
  readonly label: string;
  readonly value: string;
  readonly group: string;
}

/** Marcador de un campo, tal y como se interpola en el prompt. */
export const promptMarkerFor = (namespace: string, field: string): string =>
  `{{${namespace}.${field}}}`;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Lee un entero de los `params` crudos, cayendo al defecto si no lo es. */
const asNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Lee el proveedor, descartando cualquier valor fuera del enum. */
const asProvider = (value: unknown): LlmProvider =>
  typeof value === 'string' && Object.values(LlmProvider).includes(value as LlmProvider)
    ? (value as LlmProvider)
    : DEFAULT_LLM_PROVIDER;

/** Comprueba que un entero este dentro de su rango, ambos incluidos. */
const isWithin = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

/** Configuracion inicial; se reutiliza en `resetConfig`. */
const buildInitialConfig = (): LlmExtractorNodeConfig => ({
  templatePromptId: null,
  // El asistente no lo ofrece: el codigo es la via portable para que una
  // PLANTILLA de flujo o una semilla citen un prompt sin fijar un UUID. Se
  // conserva para que `hydrateFromNode` + `toNodeParams` sigan siendo un viaje
  // de ida y vuelta fiel sobre un flujo creado asi.
  promptCode: '',
  inlinePrompt: '',
  // El mismo defecto que el backend, y por el mismo motivo: un nodo al que
  // todavia nadie ha mirado la configuracion no debe poder gastar dinero por
  // omision. Elegir un proveedor de pago es un acto explicito.
  provider: DEFAULT_LLM_PROVIDER,
  model: DEFAULT_LLM_MODEL,
  dryRun: false,
  timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
  maxRetries: DEFAULT_LLM_MAX_RETRIES,
  emergencyBrakeThreshold: DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
});

/** Prefijo del id de Pinia; el sufijo es el `nodeId` del `pipeline_schema`. */
const STORE_ID_PREFIX = 'llmExtractorNode';

// Estado reactivo del nodo PROCESADOR_IA (regla frontend-quasar.md §3.1).
//
// CON capa de servicios propia DESDE PROT-21, revirtiendo lo que este mismo
// comentario sostenia antes. El argumento anterior era correcto mientras lo
// fue: lo unico que el nodo pedia al backend eran las plantillas de prompt, que
// ya sirve `ai-prompt-templates.service.ts` por su store de dominio, y
// envolverlas habria sido la capa vacia que `frontend-architecture.md` §2.1
// desaconseja. Ahora hay dos rutas que no pertenecen a ningun otro dominio —el
// catalogo de modelos y el banco de pruebas de conectividad— y alguien tiene
// que poseerlas; los prompts se siguen pidiendo por donde se pedian.
const llmExtractorSetup = () => {
  const sessionStore = useSessionStore();
  const config = ref<LlmExtractorNodeConfig>(buildInitialConfig());
  const availableUpstreamContext = ref<UpstreamNamespace[]>([]);

  const availableModels = ref<LlmModelDescriptor[]>([]);
  const isLoadingModels = ref<boolean>(false);
  const isTestingConnection = ref<boolean>(false);
  const lastConnectionResult = ref<LlmTestConnectionResult | null>(null);

  const promptsStore = useAiPromptTemplatesStore();

  /** Prompts reutilizables, para el selector cerrado. */
  const promptOptions = computed(() =>
    promptsStore.prompts.map((prompt) => ({
      label: prompt.name,
      value: prompt.id,
      description: prompt.description,
    })),
  );

  /**
   * Variables que el prompt en linea puede citar, sacadas del flujo real.
   *
   * Mismo canal que usa el mapeador de plantillas: el agregador empuja el
   * contexto aguas arriba y el nodo compone las opciones. Sin esto, el operador
   * tendria que recordar de memoria que publica cada paso anterior.
   */
  const promptVariableOptions = computed<PromptVariableOption[]>(() =>
    availableUpstreamContext.value.flatMap(({ namespace, nodeType, fields }) =>
      fields.map((field) => ({
        label: `${field.name} (${field.type})`,
        value: promptMarkerFor(namespace, field.name),
        group: nodeType === undefined ? namespace : `${namespace} (${nodeType})`,
      })),
    ),
  );

  /**
   * Opciones del selector de modelo, con los disponibles arriba.
   *
   * ORDEN y no filtrado: un modelo sin credencial se ve, se puede elegir y
   * explica por que su salida saldria simulada. Esconderlo dejaria el mismo
   * sintoma sin ninguna pista, que es el estado del que viene esta pantalla.
   *
   * EL MODELO GUARDADO SIEMPRE APARECE, aunque el catalogo no lo incluya. Sin
   * esto, un selector cerrado dejaria en blanco la configuracion de cualquier
   * flujo que apunte a un modelo retirado de la tabla curada —y el `.env` de
   * esta instalacion ya puede traer uno por `AI_DEFAULT_MODEL`—, de modo que
   * abrir el paso para mirarlo bastaria para romperlo al guardar.
   */
  const modelOptions = computed<LlmModelOption[]>(() =>
    buildModelOptions(
      availableModels.value,
      config.value.model,
      config.value.provider,
      sessionStore.isAdmin,
    ),
  );

  /** Estado del modelo elegido, para el distintivo junto al selector. */
  const selectedModelAvailability = computed<LlmModelAvailability | null>(
    () =>
      modelOptions.value.find((option) => option.value === config.value.model.trim())
        ?.availability ?? null,
  );

  /** Falso mientras no haya modelo elegido o ya se este probando. */
  const canTestConnection = computed<boolean>(
    () => config.value.model.trim() !== '' && !isTestingConnection.value,
  );

  const hasTemplatePrompt = computed<boolean>(
    () => config.value.templatePromptId !== null && config.value.templatePromptId.trim() !== '',
  );

  const hasInlinePrompt = computed<boolean>(() => config.value.inlinePrompt.trim() !== '');

  /**
   * Si los dos prompts estan puestos a la vez.
   *
   * No invalida nada: el backend resuelve el conflicto eligiendo la PLANTILLA,
   * «un activo compartido y revisado», frente al texto en linea, que «suele ser
   * un resto de una prueba anterior». Pero el operador tiene que saberlo antes
   * de ejecutar, no despues de leer una redaccion que no esperaba.
   */
  const hasConflictingPrompts = computed<boolean>(
    () => hasTemplatePrompt.value && hasInlinePrompt.value,
  );

  /**
   * Contrato Poka-Yoke que el stepper consulta para habilitar "Siguiente".
   *
   * Replica EXACTA del criterio del backend: `getIncompleteParams` exige prompt
   * de plantilla O prompt en linea, y nada mas. Los rangos numericos se anaden
   * porque el DTO los rechaza con un 400 sobre el esquema ENTERO, y el operador
   * veria un error de guardado sin saber que campo lo causa.
   */
  const isConfigValid = computed<boolean>(
    () =>
      (hasTemplatePrompt.value || hasInlinePrompt.value) &&
      config.value.model.trim() !== '' &&
      isWithin(config.value.timeoutMs, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS) &&
      isWithin(config.value.maxRetries, MIN_LLM_RETRIES, MAX_LLM_RETRIES) &&
      isWithin(
        config.value.emergencyBrakeThreshold,
        MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
        MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
      ),
  );

  /**
   * Avisos que el operador debe confirmar ANTES de guardar.
   *
   * Los dos salen del TSDoc del DTO del backend y ninguno se puede deducir
   * mirando el formulario, que es el criterio para que sean avisos y no texto de
   * ayuda. No bloquean: son decisiones legitimas con consecuencias caras.
   */
  const configWarnings = computed<readonly string[]>(() => {
    const warnings: string[] = [];
    const { provider, dryRun, maxRetries } = config.value;

    if (!IMPLEMENTED_LLM_PROVIDERS.has(provider)) {
      warnings.push(
        `${LLM_PROVIDER_LABELS[provider]} todavia no tiene cliente: la inferencia la resolvera el simulador y su salida vendra marcada con metadata.isMock. No es un error, pero lo que se publique NO sera una redaccion real.`,
      );
    } else if (provider !== LlmProvider.MOCK && !dryRun) {
      warnings.push(
        `Cada ejecucion de este flujo hara una inferencia real contra ${LLM_PROVIDER_LABELS[provider]} y consumira tokens facturables. Activa "Simular" para probar la topologia sin coste.`,
      );
    }

    if (maxRetries > LLM_RETRIES_WARNING_THRESHOLD) {
      warnings.push(
        `Los reintentos de red se MULTIPLICAN con el retryPolicy del esquema, y cada vuelta factura tokens. Con ${maxRetries} aqui y una politica de reintentos en el flujo, una sola ejecucion puede pagar decenas de inferencias.`,
      );
    }

    return warnings;
  });

  const updateConfig = (patch: Partial<LlmExtractorNodeConfig>): void => {
    config.value = { ...config.value, ...patch };

    // Un resultado de prueba no puede sobrevivir al par que lo produjo: dejar
    // "conexion correcta" en pantalla despues de cambiar de proveedor es peor
    // que no haber probado nunca. Mismo criterio que el banco de pruebas del
    // extractor web con su `invalidateSandboxResult`.
    if (patch.provider !== undefined || patch.model !== undefined) {
      lastConnectionResult.value = null;
    }
  };

  const setAvailableUpstreamContext = (context: UpstreamNamespace[]): void => {
    availableUpstreamContext.value = [...context];
  };

  /**
   * Trae el catalogo de prompts, una sola vez por sesion.
   *
   * La guarda esta AQUI y no en el store de dominio, aunque `node-catalog.store`
   * si la lleve dentro: alli el catalogo son datos de instalacion, mientras que
   * los prompts se crean y editan desde su propia pantalla, y el gestor llama a
   * `loadPrompts()` despues de cada alta esperando releer. Memoizarlo alli
   * dejaria la tabla administrativa mostrando la fila anterior.
   *
   * El nodo, en cambio, solo necesita poblar un selector, y sin esta guarda un
   * flujo con dos inferencias haria dos peticiones identicas al montar sus dos
   * pasos.
   */
  const loadPrompts = async (): Promise<void> => {
    if (promptsStore.prompts.length > 0) return;

    await promptsStore.loadPrompts();
  };

  /**
   * Trae el catalogo de modelos.
   *
   * SIN memoizar, al contrario que `loadPrompts`. La disponibilidad depende de
   * variables de entorno del servidor, y el caso que esta pantalla viene a
   * resolver es precisamente el de alguien que acaba de poner una credencial
   * que faltaba: cachearlo le mostraria el estado anterior hasta recargar la
   * aplicacion entera. La peticion no toca la base de datos.
   *
   * Sin `try/catch`: la excepcion sube al componente, que es quien decide el
   * mensaje (`frontend-architecture.md` §2.1). El `finally` solo apaga el
   * indicador.
   */
  const fetchAvailableModels = async (): Promise<void> => {
    isLoadingModels.value = true;

    try {
      availableModels.value = await llmExtractorService.fetchLlmModels();
    } finally {
      isLoadingModels.value = false;
    }
  };

  /**
   * Prueba la conexion con el proveedor y el modelo elegidos ahora mismo.
   *
   * Un fallo diagnosticado llega como 200 con `success: false` y se guarda
   * como resultado, no se lanza: es la respuesta que el formulario tiene que
   * mostrar. Solo una peticion rota propaga excepcion.
   */
  const testConnection = async (): Promise<LlmTestConnectionResult> => {
    isTestingConnection.value = true;

    try {
      const result = await llmExtractorService.testLlmConnection({
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
   * `params` del nodo para el `pipeline_schema`.
   *
   * LO VACIO SE OMITE: el DTO valida `@IsNotEmpty` sobre `inlinePrompt` y
   * `@IsUUID` sobre `templatePromptId` si la clave viene, asi que publicar `''`
   * o `null` devolveria un 400 sobre el flujo entero.
   *
   * Los numericos SI viajan siempre aunque coincidan con el defecto: a
   * diferencia del asunto del nodo de alerta, aqui el valor tiene consecuencias
   * economicas, y dejarlo implicito significaria que cambiar un defecto del
   * backend cambiaria en silencio el coste de flujos ya guardados.
   */
  const toNodeParams = (): Record<string, unknown> => {
    const inlinePrompt = config.value.inlinePrompt.trim();
    const templatePromptId = config.value.templatePromptId?.trim() ?? '';
    const promptCode = config.value.promptCode.trim();

    return {
      ...(templatePromptId !== '' ? { templatePromptId } : {}),
      ...(promptCode !== '' ? { promptCode } : {}),
      ...(inlinePrompt !== '' ? { inlinePrompt } : {}),
      provider: config.value.provider,
      model: config.value.model.trim(),
      dryRun: config.value.dryRun,
      timeoutMs: config.value.timeoutMs,
      maxRetries: config.value.maxRetries,
      emergencyBrakeThreshold: config.value.emergencyBrakeThreshold,
    };
  };

  /**
   * Carga la configuracion de un nodo ya guardado.
   *
   * Contrato de ida y vuelta: `hydrateFromNode(n)` seguido de `toNodeParams()`
   * debe reproducir `n.params`. Los numericos ausentes se reponen con el mismo
   * defecto que aplica el backend, no con cero, que aqui seria un timeout
   * imposible y un freno que frena al primer fallo.
   */
  const hydrateFromNode = (node: HydratableNode): void => {
    const { params } = node;

    // Mismo motivo que en `updateConfig`: el resultado de una prueba anterior
    // no describe la configuracion que se acaba de cargar.
    lastConnectionResult.value = null;
    const templatePromptId = asText(params.templatePromptId);

    config.value = {
      templatePromptId: templatePromptId === '' ? null : templatePromptId,
      promptCode: asText(params.promptCode),
      inlinePrompt: asText(params.inlinePrompt),
      provider: asProvider(params.provider),
      model: asText(params.model) || DEFAULT_LLM_MODEL,
      dryRun: params.dryRun === true,
      timeoutMs: asNumber(params.timeoutMs, DEFAULT_LLM_TIMEOUT_MS),
      maxRetries: asNumber(params.maxRetries, DEFAULT_LLM_MAX_RETRIES),
      emergencyBrakeThreshold: asNumber(
        params.emergencyBrakeThreshold,
        DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
      ),
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    availableUpstreamContext.value = [];
    lastConnectionResult.value = null;
  };

  return {
    config,
    availableUpstreamContext,
    availableModels,
    isLoadingModels,
    isTestingConnection,
    lastConnectionResult,
    modelOptions,
    selectedModelAvailability,
    canTestConnection,
    promptOptions,
    promptVariableOptions,
    hasTemplatePrompt,
    hasInlinePrompt,
    hasConflictingPrompts,
    isConfigValid,
    configWarnings,
    updateConfig,
    setAvailableUpstreamContext,
    loadPrompts,
    fetchAvailableModels,
    testConnection,
    toNodeParams,
    hydrateFromNode,
    resetConfig,
  };
};

/**
 * Definicion de Pinia para UN nodo concreto.
 *
 * El id lleva el `nodeId` dentro, como en los demas nodos: un flujo puede
 * encadenar dos inferencias —una para redactar y otra para resumir— y con un id
 * fijo compartirian prompt, proveedor y presupuesto.
 */
const buildLlmExtractorStore = (nodeId: string) =>
  defineStore(`${STORE_ID_PREFIX}:${nodeId}`, llmExtractorSetup);

/** Instancia del store, para tipar helpers y consumidores sin `any`. */
export type LlmExtractorStore = ReturnType<ReturnType<typeof buildLlmExtractorStore>>;

/** Definiciones ya creadas, indexadas por `nodeId`. */
const definitions = new Map<string, ReturnType<typeof buildLlmExtractorStore>>();

/** Store del nodo PROCESADOR_IA identificado por `nodeId`. */
export const useLlmExtractorStore = (nodeId: string): LlmExtractorStore => {
  const cached = definitions.get(nodeId);

  if (cached !== undefined) return cached();

  const definition = buildLlmExtractorStore(nodeId);
  definitions.set(nodeId, definition);

  if (import.meta.hot) {
    import.meta.hot.accept(acceptHMRUpdate(definition, import.meta.hot));
  }

  return definition();
};
