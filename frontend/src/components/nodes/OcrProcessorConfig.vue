<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useOcrProcessorStore } from '@stores/nodes/ocr-processor.store';

import PromptOptimizerModal from '@components/shared/PromptOptimizerModal.vue';

import {
  ADMIN_ONLY_LABEL,
  ADMIN_ONLY_TOKEN,
  IMPLEMENTED_LLM_PROVIDERS,
  LLM_AVAILABILITY_LABELS,
  LLM_AVAILABILITY_TOKENS,
  LLM_PROVIDER_LABELS,
  LlmProvider,
} from '@/types/nodes/llm-extractor.types';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { extractApiErrorMessage } from '@/utils/api-error';
import { rangeClass } from '@/utils/field-range';

import type { LlmModelAvailability } from '@/types/nodes/llm-extractor.types';
import {
  MAX_OCR_RETRIES,
  MAX_OCR_TEMPERATURE,
  MAX_OCR_TIMEOUT_MS,
  MIN_OCR_RETRIES,
  MIN_OCR_TEMPERATURE,
  MIN_OCR_TIMEOUT_MS,
  MAX_OCR_CUSTOM_PROMPT_LENGTH,
  PROMPT_OCR_MULTIMODAL,
} from '@/types/nodes/ocr-processor.types';

// CodeMirror pesa unos cientos de KB: solo se descarga si alguien personaliza
// el prompt.
const PromptCodeEditor = defineAsyncComponent(
  () => import('@components/shared/PromptCodeEditor.vue'),
);

interface Props {
  /** Identificador del nodo en el `pipeline_schema` (contrato uniforme §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

// El store se resuelve POR NODO: es lo que impide que este satelite y el
// `procesador_ia` del camino nominal se pisen la configuracion.
const store = useOcrProcessorStore(props.nodeId);
const $q = useQuasar();

const PROMPT_NOTICE =
  'Por defecto se usa la instruccion del sistema: pide el texto que hay en la imagen, ni mas ni menos. Personalizala solo si el documento lo exige (ignorar sellos, transcribir una seccion); pedir que resuma o interprete arruinaria el rescate, y la redaccion ya la hace el nodo de IA que va despues.';

/** Asistente "Mejorar Prompt con IA" sobre la instruccion de este nodo. */
const isOptimizerOpen = ref(false);

/** `true` mientras el nodo usa un prompt propio en lugar del del sistema. */
const isCustomPrompt = computed(() => store.config.customPrompt !== null);

/** Texto que se ve y se optimiza: el propio o, si no hay, el del sistema. */
const effectivePrompt = computed(() => store.config.customPrompt ?? PROMPT_OCR_MULTIMODAL);

/** Al activar, el editor parte del prompt del sistema para no perder sus reglas. */
const toggleCustomPrompt = (enabled: boolean): void => {
  store.updateConfig({ customPrompt: enabled ? PROMPT_OCR_MULTIMODAL : null });
};

const restoreSystemPrompt = (): void => {
  store.updateConfig({ customPrompt: null });
};

/** La propuesta aceptada pasa a ser el prompt propio del nodo. */
const applyOptimizedPrompt = (prompt: string): void => {
  store.updateConfig({ customPrompt: prompt });
};

const MODEL_HINT =
  'Lista cerrada servida por el backend, que es el unico que sabe que credenciales hay configuradas. Los modelos de pago estan reservados a Administradores.';

/** Textos de rango, junto al campo y siempre visibles (no solo al fallar). */
const TIMEOUT_RULE = `Entre ${MIN_OCR_TIMEOUT_MS} y ${MAX_OCR_TIMEOUT_MS} ms`;
const MAX_RETRIES_RULE = `De ${MIN_OCR_RETRIES} a ${MAX_OCR_RETRIES} reintentos`;

/**
 * Por que el techo son TRES.
 *
 * El motor ejecuta los nodos en linea, de modo que la espera no se gasta una
 * vez sino `timeoutMs x (maxRetries + 1)`, y el ciclo se repite ademas por cada
 * proveedor de la cadena de respaldo.
 */
const RETRIES_HINT =
  'Cada reintento multiplica la espera maxima, y el ciclo se repite por cada proveedor de respaldo. Cero los desactiva.';

const NO_MODELS_HINT =
  'No se pudo cargar el catalogo de modelos. Se conserva el que ya tuviera el nodo.';

const availabilityToken = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_TOKENS[availability];

const availabilityLabel = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_LABELS[availability];

// Filtrado predictivo: un proveedor puede publicar decenas de modelos de
// vision. Sigue siendo un selector CERRADO (sin `new-value-mode`).
const { filteredOptions: filteredModelOptions, filterFn: filterModels } = useSelectFilter(
  () => store.modelOptions,
);

const providerOptions = computed(() =>
  Object.values(LlmProvider).map((provider) => ({
    label: LLM_PROVIDER_LABELS[provider],
    value: provider,
    disable: !IMPLEMENTED_LLM_PROVIDERS.has(provider),
  })),
);

// El catalogo se pide al montar y no al desplegar el selector: desplegarlo y
// encontrarlo vacio durante medio segundo parece un fallo. La peticion es un
// GET barato contra el propio backend.
/**
 * Lanza el banco de pruebas y traduce el resultado a UNA notificacion.
 *
 * Son tres desenlaces y no dos: un exito con `isMock` significa que respondio el
 * simulador por falta de clave, y presentarlo como "conexion correcta" seria la
 * confusion mas cara del formulario —el flujo transcribiria texto inventado sin
 * que nada lo delate aguas abajo salvo `metadata.isMock`—.
 */
const onTestConnection = async (): Promise<void> => {
  try {
    const result = await store.testConnection();

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
        caption: `Falta la clave de API de ${LLM_PROVIDER_LABELS[store.config.provider]} en el servidor. La transcripcion seria texto simulado, no lo que pone en la imagen.`,
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

onMounted(() => {
  void store.fetchAvailableModels().catch((error: unknown) => {
    $q.notify({
      type: 'warning',
      message: extractApiErrorMessage(error, NO_MODELS_HINT),
    });
  });
});
</script>

<template>
  <section class="pd-card q-pa-md" :data-node-id="nodeId">
    <header class="row items-center no-wrap q-gutter-sm q-mb-md">
      <span class="pd-icon-circle">
        <q-icon name="document_scanner" size="20px" class="pd-node-icon" />
      </span>
      <div>
        <div class="pd-h2 q-mb-none">Transcripcion de adjuntos</div>
        <p class="pd-subtitle q-mb-none">
          Se ejecuta SOLO cuando el correo no trae texto aprovechable. Lee la imagen o el PDF
          escaneado y devuelve el flujo a su curso con el texto recuperado.
        </p>
      </div>
    </header>

    <!-- Por defecto, el prompt del sistema en SOLO LECTURA: se ve lo que se le
         pide al modelo. Personalizarlo es una decision explicita (toggle), y el
         editor parte siempre del texto del sistema. -->
    <div data-test="ocr-prompt-field">
      <div class="row items-center no-wrap q-gutter-sm">
        <label class="pd-label col">
          {{ isCustomPrompt ? 'Instruccion personalizada' : 'Instruccion del sistema' }}
        </label>
        <q-toggle
          :model-value="isCustomPrompt"
          dense
          label="Personalizar prompt"
          data-test="ocr-prompt-toggle"
          @update:model-value="toggleCustomPrompt"
        />
        <q-btn
          class="pd-btn-icon"
          outline
          no-caps
          dense
          icon="auto_fix_high"
          label="Mejorar Prompt con IA"
          data-test="ocr-prompt-optimize"
          @click="isOptimizerOpen = true"
        >
          <q-tooltip>Reescribe la instruccion con reglas de ingenieria de prompts</q-tooltip>
        </q-btn>
      </div>

      <template v-if="isCustomPrompt">
        <PromptCodeEditor
          class="q-mt-xs"
          :model-value="store.config.customPrompt ?? ''"
          min-height="180px"
          data-test="ocr-prompt-editor"
          @update:model-value="store.updateConfig({ customPrompt: $event })"
        />
        <div class="row items-center q-mt-xs">
          <p
            v-if="!store.isCustomPromptValid"
            class="pd-required col q-mb-none"
            data-test="ocr-prompt-error"
          >
            La instruccion no puede quedar vacia ni superar
            {{ MAX_OCR_CUSTOM_PROMPT_LENGTH }} caracteres.
          </p>
          <q-space />
          <q-btn
            class="pd-btn-secondary"
            flat
            no-caps
            dense
            icon="restart_alt"
            label="Restaurar prompt del sistema"
            data-test="ocr-prompt-restore"
            @click="restoreSystemPrompt"
          />
        </div>
      </template>
      <pre v-else class="pd-mono pd-readonly-prompt q-mt-xs">{{ PROMPT_OCR_MULTIMODAL }}</pre>
      <p class="pd-subtitle q-mt-xs q-mb-none">{{ PROMPT_NOTICE }}</p>
    </div>

    <PromptOptimizerModal
      v-model="isOptimizerOpen"
      :draft-prompt="effectivePrompt"
      default-format="text"
      @apply="applyOptimizedPrompt"
    />

    <div class="row q-col-gutter-md q-mt-md">
      <div class="col-12 col-md-6" data-test="ocr-provider-field">
        <label class="pd-label" for="ocr-provider">Proveedor</label>
        <q-select
          id="ocr-provider"
          :model-value="store.config.provider"
          :options="providerOptions"
          outlined
          dense
          emit-value
          map-options
          option-disable="disable"
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ provider: $event as LlmProvider })"
        />
      </div>

      <div class="col-12 col-md-6" data-test="ocr-model-field">
        <label class="pd-label" for="ocr-model">Modelo de vision</label>
        <q-select
          id="ocr-model"
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
          @update:model-value="store.updateConfig({ model: String($event ?? '') })"
        >
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
                  data-test="ocr-admin-only-badge"
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

        <q-banner
          v-if="store.isSelectedModelForbidden"
          dense
          class="pd-warn-banner q-mt-sm"
          data-test="ocr-forbidden-banner"
        >
          <template #avatar>
            <q-icon name="lock" class="pd-warn-icon" />
          </template>
          El modelo guardado esta reservado a Administradores. Elige otro para poder continuar.
        </q-banner>

        <!-- Banco de pruebas, junto al par que verifica. La prueba NO bloquea el
             avance: su ausencia se avisa por `configWarnings`. -->
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

      <div class="col-12 col-md-4" data-test="ocr-temperature-field">
        <label class="pd-label" for="ocr-temperature">Temperatura</label>
        <q-input
          id="ocr-temperature"
          :model-value="store.config.temperature"
          type="number"
          outlined
          dense
          :step="0.1"
          :min="MIN_OCR_TEMPERATURE"
          :max="MAX_OCR_TEMPERATURE"
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ temperature: Number($event) })"
        />
      </div>

      <div
        class="col-12 col-md-4"
        :class="rangeClass(store.config.timeoutMs, MIN_OCR_TIMEOUT_MS, MAX_OCR_TIMEOUT_MS)"
        data-test="ocr-timeout-field"
      >
        <label class="pd-label" for="ocr-timeout">Espera maxima (ms)</label>
        <q-input
          id="ocr-timeout"
          :model-value="store.config.timeoutMs"
          type="number"
          outlined
          dense
          :min="MIN_OCR_TIMEOUT_MS"
          :max="MAX_OCR_TIMEOUT_MS"
          :step="1000"
          class="q-mt-xs"
          :rules="[
            (val: number | string | null) =>
              (Number(val) >= MIN_OCR_TIMEOUT_MS && Number(val) <= MAX_OCR_TIMEOUT_MS) ||
              `Entre ${MIN_OCR_TIMEOUT_MS} y ${MAX_OCR_TIMEOUT_MS} ms`,
          ]"
          @update:model-value="store.updateConfig({ timeoutMs: Number($event) })"
        />
        <span class="pd-field-range">{{ TIMEOUT_RULE }}</span>
      </div>

      <div
        class="col-12 col-md-4"
        :class="rangeClass(store.config.maxRetries, MIN_OCR_RETRIES, MAX_OCR_RETRIES)"
        data-test="ocr-retries-field"
      >
        <label class="pd-label" for="ocr-retries">Reintentos de red</label>
        <q-input
          id="ocr-retries"
          :model-value="store.config.maxRetries"
          type="number"
          outlined
          dense
          :min="MIN_OCR_RETRIES"
          :max="MAX_OCR_RETRIES"
          :step="1"
          class="q-mt-xs"
          :hint="RETRIES_HINT"
          :rules="[
            (val: number | string | null) =>
              (Number(val) >= MIN_OCR_RETRIES && Number(val) <= MAX_OCR_RETRIES) ||
              `Permitido de ${MIN_OCR_RETRIES} a ${MAX_OCR_RETRIES} reintentos`,
          ]"
          @update:model-value="store.updateConfig({ maxRetries: Number($event) })"
        />
        <span class="pd-field-range">{{ MAX_RETRIES_RULE }}</span>
      </div>

      <div class="col-12">
        <q-toggle
          :model-value="store.config.dryRun"
          color="primary"
          label="Simular la transcripcion (coste cero)"
          data-test="ocr-dry-run"
          @update:model-value="store.updateConfig({ dryRun: Boolean($event) })"
        />
      </div>
    </div>

    <q-banner
      v-for="warning in store.configWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="ocr-warning"
    >
      <template #avatar>
        <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      </template>
      {{ warning }}
    </q-banner>
  </section>
</template>

<style scoped lang="scss">
// Superficie de SOLO LECTURA, distinta de un campo: se ve que no se edita antes
// de intentar escribir en ella.
.pd-readonly-prompt {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-secondary);
}

.pd-warn-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-warn-icon {
  color: var(--pd-warning);
}

:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
