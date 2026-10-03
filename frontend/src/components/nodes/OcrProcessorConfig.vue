<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useOcrProcessorStore } from '@stores/nodes/ocr-processor.store';

import {
  ADMIN_ONLY_LABEL,
  ADMIN_ONLY_TOKEN,
  IMPLEMENTED_LLM_PROVIDERS,
  LLM_AVAILABILITY_LABELS,
  LLM_AVAILABILITY_TOKENS,
  LLM_PROVIDER_LABELS,
  LlmProvider,
} from '@/types/nodes/llm-extractor.types';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { LlmModelAvailability } from '@/types/nodes/llm-extractor.types';
import {
  MAX_OCR_RETRIES,
  MAX_OCR_TEMPERATURE,
  MAX_OCR_TIMEOUT_MS,
  MIN_OCR_RETRIES,
  MIN_OCR_TEMPERATURE,
  MIN_OCR_TIMEOUT_MS,
  PROMPT_OCR_MULTIMODAL,
} from '@/types/nodes/ocr-processor.types';

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
  'Lo fija el sistema y no se edita: aqui se pide el texto que hay en la imagen, ni mas ni menos. Pedirle al modelo que resuma o interprete arruinaria el rescate, y la redaccion ya la hace el nodo de IA que va despues, que si elige su plantilla.';

const MODEL_HINT =
  'Lista cerrada servida por el backend, que es el unico que sabe que credenciales hay configuradas. Los modelos de pago estan reservados a Administradores.';

const NO_MODELS_HINT =
  'No se pudo cargar el catalogo de modelos. Se conserva el que ya tuviera el nodo.';

const availabilityToken = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_TOKENS[availability];

const availabilityLabel = (availability: LlmModelAvailability): string =>
  LLM_AVAILABILITY_LABELS[availability];

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

    <!-- El prompt en SOLO LECTURA: se ve lo que se le pide al modelo, pero no se
         edita. Ocultarlo del todo dejaria al operador sin saber que se envia. -->
    <div data-test="ocr-prompt-field">
      <label class="pd-label">Instruccion del sistema</label>
      <pre class="pd-mono pd-readonly-prompt q-mt-xs">{{ PROMPT_OCR_MULTIMODAL }}</pre>
      <p class="pd-subtitle q-mt-xs q-mb-none">{{ PROMPT_NOTICE }}</p>
    </div>

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
          :options="store.modelOptions"
          :loading="store.isLoadingModels"
          outlined
          dense
          emit-value
          map-options
          option-disable="disable"
          class="q-mt-xs"
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

      <div class="col-12 col-md-4" data-test="ocr-timeout-field">
        <label class="pd-label" for="ocr-timeout">Espera maxima (ms)</label>
        <q-input
          id="ocr-timeout"
          :model-value="store.config.timeoutMs"
          type="number"
          outlined
          dense
          :min="MIN_OCR_TIMEOUT_MS"
          :max="MAX_OCR_TIMEOUT_MS"
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ timeoutMs: Number($event) })"
        />
      </div>

      <div class="col-12 col-md-4" data-test="ocr-retries-field">
        <label class="pd-label" for="ocr-retries">Reintentos de red</label>
        <q-input
          id="ocr-retries"
          :model-value="store.config.maxRetries"
          type="number"
          outlined
          dense
          :min="MIN_OCR_RETRIES"
          :max="MAX_OCR_RETRIES"
          class="q-mt-xs"
          @update:model-value="store.updateConfig({ maxRetries: Number($event) })"
        />
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
