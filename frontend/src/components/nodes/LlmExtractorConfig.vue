<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useLlmExtractorStore } from '@stores/nodes/llm-extractor.store';
import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';

import AiPromptPreviewDialog from '@components/ai-prompt-templates/AiPromptPreviewDialog.vue';
import AiPromptTemplateDialog from '@components/ai-prompt-templates/AiPromptTemplateDialog.vue';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { extractApiErrorMessage } from '@/utils/api-error';
import { rangeClass } from '@/utils/field-range';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import { blockNonNumericKeys } from '@/utils/numeric-input';
import type { AiPromptTemplateDetail } from '@/types/ai-prompt-template';
import type { LlmModelAvailability } from '@/types/nodes/llm-extractor.types';
import {
  ADMIN_ONLY_LABEL,
  ADMIN_ONLY_TOKEN,
  IMPLEMENTED_LLM_PROVIDERS,
  LLM_AVAILABILITY_LABELS,
  LLM_AVAILABILITY_TOKENS,
  LLM_PROVIDER_LABELS,
  LlmProvider,
  MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
  DEFAULT_LLM_MARKUP_MAX_TOKENS,
  MAX_LLM_MAX_TOKENS,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MIN_LLM_MAX_TOKENS,
  MIN_LLM_RETRIES,
  MIN_LLM_TIMEOUT_MS,
} from '@/types/nodes/llm-extractor.types';

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

const $q = useQuasar();
// El store se resuelve POR NODO: un flujo puede encadenar dos inferencias —una
// para redactar y otra para resumir— con prompts y presupuestos distintos.
const store = useLlmExtractorStore(props.nodeId);
// El catalogo de prompts es COMPARTIDO entre nodos y flujos, asi que vive en su
// propio store y no en el del nodo.
const promptsStore = useAiPromptTemplatesStore();

const isPreviewOpen = ref(false);
const isEditorOpen = ref(false);

const PROMPT_RULE = 'Elige una plantilla de prompt para que este nodo tenga algo que ejecutar';

const CONFLICT_NOTICE =
  'Hay una plantilla elegida Y una instruccion en linea. El motor usara LA PLANTILLA: es un activo compartido y revisado, mientras que el texto en linea suele ser el resto de una prueba anterior. Borra uno de los dos para que no haya duda.';

const LEGACY_INLINE_NOTICE =
  'Este flujo se creo cuando se podia escribir la instruccion aqui. Se conserva tal cual para no alterarlo, pero ya no se edita: elige una plantilla de prompt y pasara a mandar ella.';

const MODEL_HINT =
  'El distintivo dice si el proveedor tiene su clave de API puesta en el servidor. Un modelo sin ella no falla: degrada al simulador y la salida sale marcada como simulada.';

const NO_MODELS_HINT = 'No se pudo cargar el catalogo de modelos';

const UNCATALOGUED_NOTICE =
  'Este flujo apunta a un modelo que no figura en el catalogo del servidor. Se conserva tal cual para no alterarlo, pero no se ha podido comprobar que siga existiendo: pruebalo con el boton de abajo antes de confiar en el.';

const RETRIES_HINT =
  'Reintentos RAPIDOS DE RED, distintos del retryPolicy del esquema. Los dos niveles se multiplican y cada vuelta factura tokens.';

const MAX_TOKENS_HINT =
  'Dejalo VACIO salvo que sepas lo que haces: el nodo lo resuelve solo, y sube el presupuesto a 8192 cuando su instruccion cita una plantilla base, que es cuando la respuesta tiene que traer el HTML entero. Un tope corto no acorta la respuesta: la parte a media cadena JSON y el nodo muere por contrato.';

const BRAKE_HINT =
  'Fallos consecutivos del proveedor que pausan el flujo. Es el corte de la espiral de gasto: al alcanzarlo, la ejecucion queda PAUSADA con el cursor intacto.';

/** Selector cerrado del proveedor (Poka-Yoke §4). */
// Filtrado predictivo en las dos listas largas del nodo: el repositorio de
// prompts crece sin tope y un proveedor puede publicar decenas de modelos. El
// selector sigue CERRADO —no se declara `new-value-mode`—, asi que teclear
// filtra pero no inventa.
const { filteredOptions: filteredPromptOptions, filterFn: filterPrompts } = useSelectFilter(
  () => store.promptOptions,
);
const { filteredOptions: filteredModelOptions, filterFn: filterModels } = useSelectFilter(
  () => store.modelOptions,
);

const providerOptions = computed(() =>
  Object.values(LlmProvider).map((provider) => ({
    label: LLM_PROVIDER_LABELS[provider],
    value: provider,
    description: IMPLEMENTED_LLM_PROVIDERS.has(provider)
      ? 'Cliente implementado'
      : 'Sin cliente: degrada al simulador',
  })),
);

/** Color del distintivo, resuelto sobre los tokens de la paleta (§2). */
const availabilityToken = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_TOKENS[availability];

const availabilityLabel = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_LABELS[availability];

/** true si el modelo guardado no esta en el catalogo que sirvio el backend. */
const isModelUncatalogued = computed<boolean>(
  () =>
    store.modelOptions.find((option) => option.value === store.config.model.trim())
      ?.isUncatalogued === true,
);

const loadModels = async (): Promise<void> => {
  try {
    await store.fetchAvailableModels();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de modelos'),
    });
  }
};

/**
 * Prueba la conexion y traduce el resultado a uno de tres mensajes.
 *
 * Las tres ramas son necesarias y no decorativas. Un `success: true` con
 * `isMock: true` es el caso que esta pantalla existe para delatar: el
 * proveedor "responde" porque le falta la credencial y contesto el simulador,
 * asi que anunciarlo como conexion correcta repetiria el engano que veniamos a
 * eliminar.
 */
const onTestConnection = async (): Promise<void> => {
  try {
    const result = await store.testConnection();

    // Aparte del desenlace: la prueba se facturo y no aparecera en el informe
    // de consumo. Callarlo dejaria un gasto sin rastro.
    if (result.telemetryWarning !== undefined) {
      $q.notify({ type: 'warning', message: result.telemetryWarning });
    }

    if (!result.success) {
      $q.notify({
        type: 'warning',
        message: 'No se pudo conectar con el proveedor',
        caption: result.error?.message ?? 'Revisa el proveedor y el modelo elegidos.',
      });
      return;
    }

    if (result.isMock) {
      $q.notify({
        type: 'warning',
        message: 'Respondio el simulador, no el proveedor real',
        caption: `Falta la clave de API de ${LLM_PROVIDER_LABELS[store.config.provider]} en el servidor. El flujo se ejecutaria, pero la salida seria simulada.`,
      });
      return;
    }

    $q.notify({
      type: 'positive',
      message: `Conexion correcta en ${result.latencyMs} ms`,
      caption: result.outputPreview,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo contactar con el banco de pruebas.'),
    });
  }
};

const loadPrompts = async (): Promise<void> => {
  try {
    await store.loadPrompts();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar los prompts de IA'),
    });
  }
};

/**
 * Recoge la plantilla recien creada y la deja seleccionada.
 *
 * Recarga por el STORE DE PROMPTS y no por `store.loadPrompts()`: aquel lleva
 * una guarda memoizada —`if (promptsStore.prompts.length > 0) return;`— pensada
 * para no repetir la peticion al montar cada nodo, y aqui se tragaria justo la
 * recarga que hace falta. Es la misma trampa que `TemplateMapperConfig` esquiva.
 */
const onPromptCreated = async (prompt: AiPromptTemplateDetail): Promise<void> => {
  try {
    await promptsStore.loadPrompts();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo recargar el catalogo de prompts'),
    });
  }

  store.updateConfig({ templatePromptId: prompt.id });
  $q.notify({ type: 'positive', message: 'Plantilla creada y seleccionada' });
};

/** Explicacion de los chips de variables obligatorias. */
const REQUIRED_VARIABLES_NOTICE =
  'Si alguna falta en el contexto, el flujo se pausa antes de llamar a la IA (sin coste).';

/**
 * Trae el texto del prompt elegido para listar sus variables obligatorias.
 * Un fallo no bloquea el paso: solo deja la lista sin pintar y lo avisa.
 */
const loadSelectedPromptText = async (): Promise<void> => {
  try {
    await store.loadSelectedPromptText();
  } catch (error) {
    $q.notify({
      type: 'warning',
      message: extractApiErrorMessage(
        error,
        'No se pudo leer el prompt elegido para listar sus variables obligatorias',
      ),
    });
  }
};

watch(
  () => store.config.templatePromptId,
  () => {
    void loadSelectedPromptText();
  },
);

onMounted(async () => {
  // En paralelo: son recursos independientes y encadenarlos solo sumaria
  // latencias al abrir el paso.
  await Promise.all([loadPrompts(), loadModels(), loadSelectedPromptText()]);
});
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="auto_awesome" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2">{{ NODE_TYPE_LABELS[NodeType.PROCESADOR_IA] }}</div>
        <div class="pd-subtitle">
          Convierte el texto acumulado en una redaccion estructurada y, cuando el mapeador de
          plantilla va delante, la vuelca sobre el esqueleto HTML que aquel publica.
        </div>
      </div>
    </header>

    <!-- La instruccion: plantilla reutilizable o texto propio de este flujo. -->
    <div data-test="template-prompt-field">
      <label class="pd-label" for="llm-template-prompt">
        Plantilla de prompt<span class="pd-required">*</span>
      </label>
      <q-select
        id="llm-template-prompt"
        :model-value="store.config.templatePromptId"
        :options="filteredPromptOptions"
        outlined
        dense
        clearable
        emit-value
        map-options
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        class="q-mt-xs"
        @filter="filterPrompts"
        hint="Prompts revisados y compartidos entre flujos. Se gestionan en Prompts de IA."
        @update:model-value="
          store.updateConfig({ templatePromptId: ($event ?? null) as string | null })
        "
      >
        <template #option="scope">
          <q-item v-bind="scope.itemProps">
            <q-item-section>
              <q-item-label>{{ scope.opt.label }}</q-item-label>
              <q-item-label v-if="scope.opt.description" caption>
                {{ scope.opt.description }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </div>

    <!-- Acciones sobre la plantilla elegida, mismo par que en el mapeador:
         comprobar que es la que se creia, y crear una sin salir del asistente. -->
    <div class="pd-actions q-mt-md">
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon="visibility"
        label="Previsualizar"
        data-test="preview-prompt"
        :disable="store.config.templatePromptId === null"
        @click="isPreviewOpen = true"
      />
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon="add"
        label="Nueva plantilla"
        data-test="create-prompt"
        @click="isEditorOpen = true"
      />
    </div>

    <!-- Variables OBLIGATORIAS del prompt efectivo ({{*ns.campo}}). Con texto
         y asterisco visible, no solo color. -->
    <div
      v-if="store.requiredPromptVariables.length > 0"
      class="q-mt-md"
      data-test="required-prompt-variables"
    >
      <label class="pd-label">Variables obligatorias del prompt</label>
      <div class="row q-gutter-xs q-mt-xs">
        <span
          v-for="variable in store.requiredPromptVariables"
          :key="variable"
          class="pd-mono pd-chip-mandatory"
          data-test="required-prompt-variable"
          >*{{ variable }}</span
        >
      </div>
      <p class="pd-subtitle q-mt-xs q-mb-none">{{ REQUIRED_VARIABLES_NOTICE }}</p>
    </div>

    <!-- Instruccion en linea HEREDADA. Ya no se puede escribir una: el prompt es
         un activo compartido y revisado, y el texto suelto por flujo se volvia
         un resto de pruebas que nadie repasaba. Se MUESTRA en solo lectura, sin
         borrarla: guardar el flujo sin ella se la llevaria por delante sin que
         nadie lo hubiera pedido. -->
    <div v-if="store.hasInlinePrompt" class="q-mt-md" data-test="legacy-inline-prompt">
      <label class="pd-label">Instruccion en linea (heredada)</label>
      <pre class="pd-mono pd-legacy-prompt q-mt-xs">{{ store.config.inlinePrompt }}</pre>
      <p class="pd-subtitle q-mt-xs q-mb-none">{{ LEGACY_INLINE_NOTICE }}</p>
    </div>

    <!-- Bloquea el avance: sin instruccion no hay nodo que ejecutar. -->
    <q-banner
      v-if="!store.hasTemplatePrompt && !store.hasInlinePrompt"
      dense
      class="pd-warn-banner q-mt-md"
      role="alert"
      data-test="missing-prompt"
    >
      <template #avatar>
        <q-icon name="error_outline" size="20px" class="pd-warn-icon" />
      </template>
      {{ PROMPT_RULE }}
    </q-banner>

    <!-- No bloquea, y solo puede darse en un flujo heredado: el backend
         resuelve el conflicto eligiendo la plantilla, pero en silencio. -->
    <q-banner
      v-if="store.hasConflictingPrompts"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="prompt-conflict"
    >
      <template #avatar>
        <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      </template>
      {{ CONFLICT_NOTICE }}
    </q-banner>

    <h3 class="pd-h2 q-mt-lg q-mb-md">Proveedor y presupuesto</h3>

    <div class="row q-col-gutter-md items-start">
      <div class="col-12 col-md-6" data-test="provider-field">
        <label class="pd-label" for="llm-provider">Proveedor</label>
        <q-select
          id="llm-provider"
          :model-value="store.config.provider"
          :options="providerOptions"
          outlined
          dense
          emit-value
          map-options
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ provider: $event as LlmProvider })"
        >
          <template #option="scope">
            <q-item v-bind="scope.itemProps">
              <q-item-section>
                <q-item-label>{{ scope.opt.label }}</q-item-label>
                <q-item-label caption>{{ scope.opt.description }}</q-item-label>
              </q-item-section>
            </q-item>
          </template>
        </q-select>
      </div>

      <div class="col-12 col-md-6" data-test="model-field">
        <label class="pd-label" for="llm-model">Modelo<span class="pd-required">*</span></label>
        <q-select
          id="llm-model"
          :model-value="store.config.model"
          :options="filteredModelOptions"
          :loading="store.isLoadingModels"
          outlined
          dense
          emit-value
          map-options
          option-disable="disable"
          use-input
          fill-input
          hide-selected
          input-debounce="0"
          class="q-mt-xs"
          @filter="filterModels"
          :hint="store.modelOptions.length > 0 ? MODEL_HINT : NO_MODELS_HINT"
          :rules="[(val: string) => !!val?.trim() || 'El modelo es obligatorio']"
          @update:model-value="store.updateConfig({ model: String($event ?? '') })"
        >
          <!-- Distintivo junto al valor elegido: el estado del modelo tiene
               que verse con el selector cerrado, no solo al desplegarlo. -->
          <template #append>
            <q-badge
              v-if="store.selectedModelAvailability !== null"
              :style="{ backgroundColor: availabilityToken(store.selectedModelAvailability) }"
              class="pd-badge"
              data-test="model-availability-badge"
            >
              {{ availabilityLabel(store.selectedModelAvailability) }}
            </q-badge>
          </template>

          <template #option="scope">
            <q-item v-bind="scope.itemProps">
              <q-item-section>
                <q-item-label class="pd-mono">{{ scope.opt.value }}</q-item-label>
                <q-item-label caption class="pd-subtitle">
                  {{ scope.opt.label }}
                  <span v-if="scope.opt.contextWindow > 0">
                    · {{ (scope.opt.contextWindow / 1000).toLocaleString('es-ES') }}k de contexto
                  </span>
                </q-item-label>
              </q-item-section>
              <q-item-section side>
                <!-- La restriccion de rol MANDA sobre la disponibilidad: de
                     nada sirve saber que el modelo esta configurado si este
                     usuario no lo puede elegir. -->
                <q-badge
                  v-if="scope.opt.disable"
                  :style="{ backgroundColor: ADMIN_ONLY_TOKEN }"
                  text-color="black"
                  class="pd-badge"
                  data-test="admin-only-badge"
                >
                  {{ ADMIN_ONLY_LABEL }}
                </q-badge>
                <q-badge
                  v-else
                  :style="{ backgroundColor: availabilityToken(scope.opt.availability) }"
                  class="pd-badge"
                >
                  {{ availabilityLabel(scope.opt.availability) }}
                </q-badge>
              </q-item-section>
            </q-item>
          </template>

          <template #no-option>
            <q-item>
              <q-item-section class="pd-subtitle">{{ NO_MODELS_HINT }}</q-item-section>
            </q-item>
          </template>
        </q-select>

        <q-banner v-if="isModelUncatalogued" dense class="pd-warn-banner q-mt-sm">
          <template #avatar>
            <q-icon name="help_outline" class="pd-warn-icon" />
          </template>
          {{ UNCATALOGUED_NOTICE }}
        </q-banner>

        <!-- Banco de pruebas, junto al par que verifica. AVISA del coste en el
             propio boton: contra un proveedor de pago cada pulsacion factura. -->
        <q-btn
          flat
          no-caps
          dense
          icon="bolt"
          label="Probar conexion"
          class="q-mt-sm pd-btn-secondary"
          data-test="test-connection-btn"
          :disable="!store.canTestConnection"
          :loading="store.isTestingConnection"
          @click="onTestConnection"
        >
          <q-tooltip>
            Ejecuta una inferencia minima contra el proveedor elegido. Con un proveedor de pago,
            esta prueba factura tokens.
          </q-tooltip>
        </q-btn>
      </div>

      <!-- Poka-Yoke: proyecta el coste ANTES de ejecutar, para que el operador no
           descubra que se quedo corto en forma de JSON cortado a media cadena.
           Visible SIEMPRE: sin plantilla base delante estima a partir del
           prompt y del contexto que interpola, y la razon lo dice. -->
      <div class="col-12">
        <div class="pd-estimate" data-test="resource-estimate">
          <div class="row items-center q-gutter-sm">
            <span
              class="pd-badge"
              :class="`pd-estimate--${store.resourceEstimation.complexityLevel.toLowerCase()}`"
              data-test="estimate-level"
            >
              {{ store.resourceEstimation.complexityLevel }}
            </span>
            <span class="pd-estimate-figures pd-mono">
              ~{{ store.resourceEstimation.estimatedOutputTokens }} tokens de salida ·
              {{ Math.round(store.resourceEstimation.recommendedTimeoutMs / 1000) }} s ·
              {{ store.resourceEstimation.recommendedMaxRetries }} reintento(s) recomendados
            </span>
          </div>

          <p class="pd-estimate-reason" data-test="estimate-reason">
            {{ store.resourceEstimation.reason }}
          </p>

          <q-btn
            no-caps
            dense
            icon="auto_fix_high"
            label="Recomendar presupuesto (tokens, timeout y reintentos)"
            class="pd-btn-primary"
            data-test="apply-recommendation"
            @click="store.applyRecommendedResources()"
          >
            <q-tooltip max-width="320px">
              Escribe la espera, el presupuesto de tokens y los reintentos sugeridos en los campos
              de abajo. Es una estimacion heuristica: los campos siguen siendo tuyos y puedes
              corregirlos.
            </q-tooltip>
          </q-btn>
        </div>
      </div>

      <div class="col-12">
        <q-toggle
          :model-value="store.config.dryRun"
          color="primary"
          label="Simular la inferencia (coste cero)"
          data-test="dry-run-toggle"
          @update:model-value="store.updateConfig({ dryRun: Boolean($event) })"
        >
          <q-tooltip max-width="320px">
            Responde el cliente determinista sin salir a ningun proveedor, sea cual sea el elegido.
            Sirve para probar la topologia del flujo sin pagar una inferencia por cada vuelta.
          </q-tooltip>
        </q-toggle>
      </div>

      <div
        class="col-12 col-md-4"
        :class="rangeClass(store.config.timeoutMs, MIN_LLM_TIMEOUT_MS, MAX_LLM_TIMEOUT_MS)"
        data-test="timeout-field"
      >
        <label class="pd-label" for="llm-timeout">Espera maxima (ms)</label>
        <q-input
          id="llm-timeout"
          :model-value="store.config.timeoutMs"
          type="number"
          @keydown="blockNonNumericKeys"
          :min="MIN_LLM_TIMEOUT_MS"
          :max="MAX_LLM_TIMEOUT_MS"
          step="1000"
          outlined
          dense
          class="q-mt-xs"
          hint="El motor ejecuta los nodos en linea: es tiempo que el flujo entero pasa bloqueado."
          :rules="[
            (val: number | string | null) =>
              (val !== null &&
                val !== '' &&
                Number(val) >= MIN_LLM_TIMEOUT_MS &&
                Number(val) <= MAX_LLM_TIMEOUT_MS) ||
              `Entre ${MIN_LLM_TIMEOUT_MS} y ${MAX_LLM_TIMEOUT_MS}`,
          ]"
          @update:model-value="store.updateConfig({ timeoutMs: Number($event) })"
        />
      </div>

      <div
        class="col-12 col-md-4"
        :class="rangeClass(store.config.maxRetries, MIN_LLM_RETRIES, MAX_LLM_RETRIES)"
        data-test="retries-field"
      >
        <label class="pd-label" for="llm-retries">Reintentos de red</label>
        <q-input
          id="llm-retries"
          :model-value="store.config.maxRetries"
          type="number"
          @keydown="blockNonNumericKeys"
          :min="MIN_LLM_RETRIES"
          :max="MAX_LLM_RETRIES"
          step="1"
          outlined
          dense
          class="q-mt-xs"
          :hint="RETRIES_HINT"
          :rules="[
            (val: number | string | null) =>
              (val !== null &&
                val !== '' &&
                Number(val) >= MIN_LLM_RETRIES &&
                Number(val) <= MAX_LLM_RETRIES) ||
              `Entre ${MIN_LLM_RETRIES} y ${MAX_LLM_RETRIES}`,
          ]"
          @update:model-value="store.updateConfig({ maxRetries: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-4" data-test="brake-field">
        <label class="pd-label" for="llm-brake">Freno de emergencia</label>
        <q-input
          id="llm-brake"
          :model-value="store.config.emergencyBrakeThreshold"
          type="number"
          @keydown="blockNonNumericKeys"
          :min="MIN_LLM_EMERGENCY_BRAKE_THRESHOLD"
          :max="MAX_LLM_EMERGENCY_BRAKE_THRESHOLD"
          step="1"
          outlined
          dense
          class="q-mt-xs"
          :hint="BRAKE_HINT"
          :rules="[
            (val: number | string | null) =>
              (val !== null &&
                val !== '' &&
                Number(val) >= MIN_LLM_EMERGENCY_BRAKE_THRESHOLD &&
                Number(val) <= MAX_LLM_EMERGENCY_BRAKE_THRESHOLD) ||
              `Entre ${MIN_LLM_EMERGENCY_BRAKE_THRESHOLD} y ${MAX_LLM_EMERGENCY_BRAKE_THRESHOLD}`,
          ]"
          @update:model-value="store.updateConfig({ emergencyBrakeThreshold: Number($event) })"
        />
      </div>

      <!-- Fila propia: los tres de arriba son col-md-4 y suman 12 exactos.
           `clearable` es el control, y no un adorno: vaciarlo es la unica forma
           de devolver el campo a `null`, que es lo que activa la resolucion
           automatica del backend. -->
      <div class="col-12 col-md-4" data-test="max-tokens-field">
        <label class="pd-label" for="llm-max-tokens">Presupuesto de tokens</label>
        <q-input
          id="llm-max-tokens"
          :model-value="store.config.maxTokens"
          type="number"
          @keydown="blockNonNumericKeys"
          :min="MIN_LLM_MAX_TOKENS"
          :max="MAX_LLM_MAX_TOKENS"
          step="256"
          outlined
          dense
          clearable
          class="q-mt-xs"
          :placeholder="String(DEFAULT_LLM_MARKUP_MAX_TOKENS)"
          :hint="MAX_TOKENS_HINT"
          :rules="[
            (val: number | string | null) =>
              val === null ||
              val === '' ||
              (Number(val) >= MIN_LLM_MAX_TOKENS && Number(val) <= MAX_LLM_MAX_TOKENS) ||
              `Entre ${MIN_LLM_MAX_TOKENS} y ${MAX_LLM_MAX_TOKENS}`,
          ]"
          @update:model-value="
            store.updateConfig({
              maxTokens: $event === null || $event === '' ? null : Number($event),
            })
          "
        />
      </div>
    </div>

    <!-- Avisos del contrato §3.1: no bloquean, pero el operador debe verlos
         antes de guardar. Ninguno se deduce mirando los campos. -->
    <q-banner
      v-for="warning in store.configWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="config-warning"
    >
      <template #avatar>
        <q-icon name="paid" size="20px" class="pd-warn-icon" />
      </template>
      {{ warning }}
    </q-banner>
    <!-- Previsualizacion de SOLO LECTURA: comprobar que la plantilla elegida es
         la que se creia. Editarla desde aqui tocaria un activo que comparten
         varios flujos sin decirlo. -->
    <AiPromptPreviewDialog v-model="isPreviewOpen" :prompt-id="store.config.templatePromptId" />

    <!-- El alta reutiliza el MISMO dialogo del gestor de prompts: duplicar aqui
         el formulario duplicaria tambien sus reglas, que divergirian. Se le
         entrega el contexto aguas arriba de ESTE flujo para que los chips de
         marcadores ofrezcan lo que de verdad publica, y no el catalogo global. -->
    <AiPromptTemplateDialog
      v-model="isEditorOpen"
      :prompt="null"
      :upstream-context="store.availableUpstreamContext"
      @saved="onPromptCreated"
    />
  </section>
</template>

<style scoped lang="scss">
// Mismo contenedor de acciones que `TemplateMapperConfig.vue`.
.pd-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

// Superficie de SOLO LECTURA, distinta de un campo: se ve que no se edita antes
// de intentar escribir en ella. `pre` conserva los saltos, que en una
// instruccion son parte de su significado.
.pd-legacy-prompt {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-secondary);
}

.pd-node-icon {
  color: var(--pd-primary);
}

// Tarjeta de estimacion. Superficie secundaria sobre los tokens del sistema
// (regla §2): ni compite con la tarjeta principal ni parece un campo editable.
.pd-estimate {
  padding: 12px;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
}

.pd-estimate-figures {
  color: var(--pd-text-secondary);
}

.pd-estimate-reason {
  margin: 8px 0 12px;
  color: var(--pd-text-secondary);
}

// El nivel colorea el badge con la misma escala de severidad que el modulo de
// trazabilidad, para que ALTA signifique lo mismo en las dos pantallas.
.pd-estimate--baja {
  background: var(--pd-positive);
}

.pd-estimate--media {
  background: var(--pd-warning);
}

.pd-estimate--alta {
  background: var(--pd-negative);
}

.pd-warn-icon {
  color: var(--pd-warning);
}

.pd-warn-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-left: 3px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Sexta
// copia del mismo bloque; candidato claro a subir a app.scss.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}

:deep(.q-field__messages) {
  color: var(--pd-text-secondary);
}
</style>
