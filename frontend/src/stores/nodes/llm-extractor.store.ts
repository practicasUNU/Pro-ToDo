import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as llmExtractorService from '@services/nodes/llm-extractor.service';
import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';

import {
  DEFAULT_LLM_EMERGENCY_BRAKE_THRESHOLD,
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  DEFAULT_LLM_MAX_RETRIES,
  DEFAULT_LLM_OUTPUT_CARDINALITY,
  DEFAULT_MAX_TOKENS_MULTIPLE,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TIMEOUT_MS,
  IMPLEMENTED_LLM_PROVIDERS,
  isBatchCardinality,
  LLM_PROVIDER_LABELS,
  LLM_RETRIES_WARNING_THRESHOLD,
  LlmProvider,
  MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MAX_LLM_MAX_TOKENS,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MIN_LLM_MAX_TOKENS,
  MIN_LLM_RETRIES,
  MIN_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

import { useSessionStore } from '@stores/session.store';
import { buildModelOptions } from '@/utils/llm-model-options';
import { estimateLlmResources } from '@/utils/llm-estimator.util';
import { filterPromptContext } from '@/utils/prompt-namespaces';
import { buildMarker, extractMandatoryPromptVariables } from '@/utils/prompt-markers';

import type { HydratableNode, UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { LlmResourceEstimate } from '@/utils/llm-estimator.util';

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

/**
 * Marcador de un campo, tal y como se interpola en el prompt. Con `required`
 * sale la marca obligatoria `{{*ns.campo}}`.
 */
export const promptMarkerFor = (namespace: string, field: string, required = false): string =>
  buildMarker(namespace, field, required);

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
  // `null` = "decide tu". Ver el TSDoc del campo en los tipos.
  maxTokens: null,
  outputCardinality: DEFAULT_LLM_OUTPUT_CARDINALITY,
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

  /**
   * Marcado base que aporta un paso ANTERIOR, empujado por el anfitrion.
   *
   * `null` significa "no hay plantilla base delante", que es lo mismo que
   * "todavia no se ha elegido": nunca es un error.
   */
  const upstreamBaseMarkup = ref<string | null>(null);

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
   *
   * PASA POR `filterPromptContext` igual que el dialogo de plantillas de prompt.
   * `availableUpstreamContext` llega CRUDO —el agregador empuja todo lo que
   * precede al nodo, sin criterio de prompt— y este es el segundo camino hacia
   * las mismas opciones: sin el filtro, un ESCUDO_POST_IA mal colocado delante
   * se ofreceria aqui y no alli, y la incoherencia solo se veria al ejecutar.
   */
  const promptVariableOptions = computed<PromptVariableOption[]>(() =>
    filterPromptContext(availableUpstreamContext.value).flatMap(({ namespace, nodeType, fields }) =>
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
   * Texto del prompt guardado que el nodo tiene elegido, si ya se trajo.
   *
   * El listado del repositorio omite `promptText` (ver `types/ai-prompt-template.ts`),
   * asi que se pide el detalle con `loadSelectedPromptText` al cambiar la eleccion.
   */
  const selectedPromptText = ref<string | null>(null);

  /**
   * Prompt que usara el backend, con su misma precedencia: plantilla por UUID,
   * plantilla por codigo y, si no hay ninguna, el texto en linea.
   */
  const effectivePromptText = computed<string | null>(() =>
    hasTemplatePrompt.value || config.value.promptCode.trim() !== ''
      ? selectedPromptText.value
      : config.value.inlinePrompt,
  );

  /**
   * Variables que el prompt efectivo marca como OBLIGATORIAS (`{{*ns.campo}}`).
   *
   * El prompt efectivo es el que elegira el backend: la plantilla si la hay, y
   * si no el texto en linea heredado. Son las que pausaran el flujo, sin
   * facturar la inferencia, si el contexto no las trae.
   */
  const requiredPromptVariables = computed<string[]>(() => {
    const text = hasTemplatePrompt.value
      ? (selectedPromptText.value ?? '')
      : config.value.inlinePrompt;

    return extractMandatoryPromptVariables(text);
  });

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
      ) &&
      // `null` es valido y es el caso normal: significa que el nodo no declara
      // tope y lo resuelve el backend. Solo se comprueba el rango cuando el
      // operador escribe un numero, que es cuando el DTO puede rechazarlo.
      (config.value.maxTokens === null ||
        isWithin(config.value.maxTokens, MIN_LLM_MAX_TOKENS, MAX_LLM_MAX_TOKENS)),
  );

  /**
   * Avisos que el operador debe confirmar ANTES de guardar.
   *
   * Los dos primeros salen del TSDoc del DTO del backend y ninguno se puede
   * deducir mirando el formulario, que es el criterio para que sean avisos y no
   * texto de ayuda. No bloquean: son decisiones legitimas con consecuencias
   * caras.
   *
   * EL ESTADO DE LA PRUEBA DE CONEXION ENTRA AQUI Y NO EN `isConfigValid`. Ese
   * getter es la replica exacta de `getIncompleteParams` del backend, de modo
   * que atarlo al resultado de la prueba haria invalido en el asistente un flujo
   * que la API acepta —y bloquearia el boton "Siguiente" hasta que alguien
   * pulsase un boton que factura tokens contra un proveedor de pago cada vez
   * que se reabre el paso—. El aviso dice lo mismo sin cobrar el peaje.
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

    // Coste de lote: no bloquea, pero el operador debe saber que una sola
    // ejecucion puede devolver (y facturar) varias piezas enteras.
    if (isBatchCardinality(config.value.outputCardinality)) {
      warnings.push(
        `${config.value.outputCardinality === 'AUTO' ? 'Autodeteccion (1:1 / 1:N), presupuestada como lote' : 'Modo lote (1:N)'}: la respuesta incluye un elemento por cada pieza del correo y se factura entera. Se proyectan unos ${resourceEstimation.value.estimatedOutputTokens} tokens de salida; sin un tope propio, el nodo reserva ${DEFAULT_MAX_TOKENS_MULTIPLE}.`,
      );
    }

    // Generacion extensa con un presupuesto o una espera por debajo de lo que
    // pide: es el corte a media cadena JSON, o el ERR_HTTP_TIMEOUT, que el
    // operador veria por primera vez en produccion.
    const estimate = resourceEstimation.value;

    if (estimate.longForm) {
      const effectiveMaxTokens =
        config.value.maxTokens ??
        (isBatchCardinality(config.value.outputCardinality)
          ? DEFAULT_MAX_TOKENS_MULTIPLE
          : DEFAULT_LLM_MARKUP_MAX_TOKENS);
      const shortTokens =
        estimate.recommendedMaxTokens !== null &&
        effectiveMaxTokens < estimate.recommendedMaxTokens;
      const shortTimeout = config.value.timeoutMs < estimate.recommendedTimeoutMs;

      if (shortTokens || shortTimeout) {
        warnings.push(
          `Generacion extensa: el prompt pide redaccion larga y la configuracion se queda corta (${effectiveMaxTokens} tokens y ${Math.round(config.value.timeoutMs / 1000)} s frente a ${estimate.recommendedMaxTokens ?? effectiveMaxTokens} tokens y ${Math.round(estimate.recommendedTimeoutMs / 1000)} s recomendados). Pulsa "Recomendar presupuesto" para evitar respuestas cortadas o timeouts.`,
        );
      }
    }

    if (maxRetries > LLM_RETRIES_WARNING_THRESHOLD) {
      warnings.push(
        `Los reintentos de red se MULTIPLICAN con el retryPolicy del esquema, y cada vuelta factura tokens. Con ${maxRetries} aqui y una politica de reintentos en el flujo, una sola ejecucion puede pagar decenas de inferencias.`,
      );
    }

    // `null` cubre dos situaciones que para el operador son la misma —nunca se
    // probo, o se probo y el cambio de proveedor/modelo invalido el resultado—:
    // en ambas no hay prueba vigente del par que se va a guardar.
    if (lastConnectionResult.value === null) {
      warnings.push(
        'Este nodo todavia no ha superado una prueba de conexion con el proveedor elegido. Pulsa "Probar conexion" para confirmar que la clave existe y el modelo responde; si no, el fallo aparecera en ejecucion con el flujo ya PAUSADO.',
      );
    } else if (!lastConnectionResult.value.success) {
      warnings.push(
        `La ultima prueba de conexion fallo: ${lastConnectionResult.value.error?.message ?? 'sin detalle del proveedor'}. Guardar asi deja un flujo que reventara en su primera ejecucion.`,
      );
    } else if (lastConnectionResult.value.isMock) {
      // Un exito simulado NO puede apagar el aviso: un proveedor sin clave no
      // falla, degrada, de modo que sin esta rama la prueba "correcta" seria
      // indistinguible de una real y el flujo publicaria texto inventado.
      warnings.push(
        `La prueba de conexion la respondio el SIMULADOR, no ${LLM_PROVIDER_LABELS[provider]}: falta su clave de API en el servidor. El flujo se ejecutaria, pero lo que publique no sera una redaccion real.`,
      );
    }

    return warnings;
  });

  const updateConfig = (patch: Partial<LlmExtractorNodeConfig>): void => {
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
   * Canal del marcado base; lo invoca el anfitrion al sincronizar un paso.
   *
   * Segundo consumidor de este canal, junto al ESCUDO_POST_IA. Va por el
   * agregador y no leyendo el store del mapeador porque §3.1 prohibe que un
   * nodo conozca la forma interna de otro.
   *
   * Que el marcado LLEGUE aqui depende de que el mapeador vaya DELANTE, y eso
   * es exactamente la topologia prevista desde el cambio de semantica: el
   * mapeador publica `rendered_html.compiled_markup` y el prompt de este nodo
   * lo interpola. Con el mapeador detras, `upstreamBaseMarkup` del anfitrion
   * —que solo mira hacia atras— entrega `null` y la estimacion se calla, que es
   * la conducta correcta.
   */
  const setUpstreamBaseMarkup = (markup: string | null): void => {
    upstreamBaseMarkup.value = markup;
  };

  /**
   * Proyeccion de recursos de la inferencia, derivada del marcado de delante.
   *
   * Es un `computed` y no un dato cargado porque todo lo que necesita ya esta
   * en memoria: el anfitrion empuja el marcado al cambiar de paso. Pedir ademas
   * el TEXTO del prompt obligaria a una llamada asincrona —el listado de
   * plantillas lo omite a proposito— para medir lo que menos influye: lo que
   * encarece esta inferencia es cuantas fichas hay que rellenar, no lo larga
   * que sea la orden.
   */
  const resourceEstimation = computed<LlmResourceEstimate>(() =>
    estimateLlmResources(
      upstreamBaseMarkup.value,
      availableUpstreamContext.value.reduce((total, entry) => total + entry.fields.length, 0),
      config.value.outputCardinality,
      // El texto SI importa para una cosa: cuantos parrafos exige. Es lo que
      // delata una generacion extensa que el marcado, corto y vacio, no dice.
      effectivePromptText.value,
    ),
  );

  /**
   * Hay plantilla base delante. Ya NO oculta la tarjeta (se ve siempre, con la
   * estimacion por prompt cuando falta la plantilla): solo distingue el origen.
   */
  const hasResourceEstimation = computed<boolean>(
    () => (upstreamBaseMarkup.value?.trim().length ?? 0) > 0,
  );

  /**
   * Vuelca la recomendacion sobre la configuracion del nodo.
   *
   * Quien garantiza que la recomendacion CABE en el nodo es el estimador, que
   * ya acota contra `MAX_LLM_TIMEOUT_MS` y `MAX_LLM_MAX_TOKENS` antes de
   * devolverla. `updateConfig` no acota —es una fusion llana— y ponerle un
   * acotado aqui repartiria la misma regla en dos sitios. Importa que se
   * respete: dejar el nodo invalido apagaria el "Siguiente" del asistente por
   * culpa de un boton que el operador acaba de pulsar.
   *
   * `recommendedMaxTokens` puede valer `null`, y entonces se escribe `null`: es
   * la recomendacion ACTIVA de no fijar tope y dejar que lo resuelva el
   * backend, no la ausencia de recomendacion.
   */
  const applyRecommendedResources = (): void => {
    const estimate = resourceEstimation.value;

    updateConfig({
      timeoutMs: estimate.recommendedTimeoutMs,
      maxTokens: estimate.recommendedMaxTokens,
      maxRetries: estimate.recommendedMaxRetries,
    });
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
   * Trae el texto del prompt elegido para derivar sus variables obligatorias.
   * Sin plantilla elegida se limpia. Los errores suben al componente.
   */
  const loadSelectedPromptText = async (): Promise<void> => {
    const promptId = config.value.templatePromptId;
    const promptCode = config.value.promptCode.trim();

    // Un nodo con `promptCode` (los maestros) tambien tiene texto: se resuelve
    // su id en el listado, que trae el codigo aunque omita el texto.
    let resolvedId = promptId !== null && promptId.trim() !== '' ? promptId : null;

    if (resolvedId === null && promptCode !== '') {
      if (promptsStore.prompts.length === 0) {
        await promptsStore.loadPrompts();
      }

      resolvedId = promptsStore.prompts.find((prompt) => prompt.code === promptCode)?.id ?? null;
    }

    if (resolvedId === null) {
      selectedPromptText.value = null;
      return;
    }

    const detail = await promptsStore.loadPromptById(resolvedId);

    // La eleccion pudo cambiar mientras viajaba la peticion: solo se guarda si
    // el texto corresponde todavia al prompt elegido.
    if (
      config.value.templatePromptId === promptId &&
      config.value.promptCode.trim() === promptCode
    ) {
      selectedPromptText.value = detail.promptText;
    }
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
      // SE OMITE cuando es `null`, al reves que los demas numericos: aqui la
      // ausencia de la clave es lo que activa la resolucion en tres escalones
      // del backend. Publicar un numero fijaria el presupuesto para siempre y
      // desactivaria la subida automatica ante una plantilla.
      ...(config.value.maxTokens === null ? {} : { maxTokens: config.value.maxTokens }),
      // Solo se publica lo que no es `SINGLE`: es el defecto del backend, y
      // omitirlo mantiene el viaje de ida y vuelta de los nodos guardados antes
      // de que existiera la clave.
      ...(isBatchCardinality(config.value.outputCardinality)
        ? { outputCardinality: config.value.outputCardinality }
        : {}),
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
      // Ausente vuelve a `null` y NO al tope de marcado: el contrato de ida y
      // vuelta exige que un nodo guardado sin la clave la siga omitiendo.
      maxTokens: typeof params.maxTokens === 'number' ? params.maxTokens : null,
      outputCardinality:
        params.outputCardinality === 'MULTIPLE' || params.outputCardinality === 'AUTO'
          ? params.outputCardinality
          : DEFAULT_LLM_OUTPUT_CARDINALITY,
    };
  };

  const resetConfig = (): void => {
    config.value = buildInitialConfig();
    availableUpstreamContext.value = [];
    upstreamBaseMarkup.value = null;
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
    requiredPromptVariables,
    selectedPromptText,
    hasTemplatePrompt,
    hasInlinePrompt,
    hasConflictingPrompts,
    isConfigValid,
    configWarnings,
    updateConfig,
    setAvailableUpstreamContext,
    setUpstreamBaseMarkup,
    resourceEstimation,
    hasResourceEstimation,
    applyRecommendedResources,
    loadPrompts,
    loadSelectedPromptText,
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
