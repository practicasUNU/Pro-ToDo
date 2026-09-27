<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

import { useLlmExtractorStore } from '@stores/nodes/llm-extractor.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_TYPE_LABELS, NodeType } from '@/types/pipeline';
import {
  IMPLEMENTED_LLM_PROVIDERS,
  LLM_PROVIDER_LABELS,
  LlmProvider,
  MAX_LLM_EMERGENCY_BRAKE_THRESHOLD,
  MAX_LLM_RETRIES,
  MAX_LLM_TIMEOUT_MS,
  MIN_LLM_EMERGENCY_BRAKE_THRESHOLD,
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

const PROMPT_RULE = 'Elige una plantilla de prompt o escribe una instruccion en linea';

const CONFLICT_NOTICE =
  'Hay una plantilla elegida Y una instruccion en linea. El motor usara LA PLANTILLA: es un activo compartido y revisado, mientras que el texto en linea suele ser el resto de una prueba anterior. Borra uno de los dos para que no haya duda.';

const INLINE_HINT =
  'Admite marcadores {{namespace.campo}} que se resuelven contra el contexto del flujo. Usa el selector de abajo para copiarlos sin teclearlos.';

const MODEL_HINT =
  'Texto libre a proposito: los proveedores publican modelos nuevos cada pocas semanas, y una lista cerrada obligaria a desplegar el backend para poder escribir el ultimo. Un modelo inexistente lo rechaza el proveedor.';

const RETRIES_HINT =
  'Reintentos RAPIDOS DE RED, distintos del retryPolicy del esquema. Los dos niveles se multiplican y cada vuelta factura tokens.';

const BRAKE_HINT =
  'Fallos consecutivos del proveedor que pausan el flujo. Es el corte de la espiral de gasto: al alcanzarlo, la ejecucion queda PAUSADA con el cursor intacto.';

const VARIABLES_HINT = 'Elige una para copiar su marcador y pegarlo en la instruccion';

const NO_VARIABLES_HINT = 'Sin pasos anteriores que publiquen campos';

/** Selector cerrado del proveedor (Poka-Yoke §4). */
const providerOptions = computed(() =>
  Object.values(LlmProvider).map((provider) => ({
    label: LLM_PROVIDER_LABELS[provider],
    value: provider,
    description: IMPLEMENTED_LLM_PROVIDERS.has(provider)
      ? 'Cliente implementado'
      : 'Sin cliente: degrada al simulador',
  })),
);

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

const onCopyVariable = async (marker: string): Promise<void> => {
  try {
    await copyToClipboard(marker);
    $q.notify({ type: 'positive', message: `${marker} copiado al portapapeles` });
  } catch {
    $q.notify({ type: 'warning', message: `Copia manualmente: ${marker}` });
  }
};

onMounted(loadPrompts);
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
          Convierte el texto acumulado en una redaccion estructurada. Su salida alimenta al mapeador
          de plantilla.
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
        :options="store.promptOptions"
        outlined
        dense
        clearable
        emit-value
        map-options
        class="q-mt-xs"
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

    <div class="q-mt-md" data-test="inline-prompt-field">
      <label class="pd-label" for="llm-inline-prompt">Instruccion en linea</label>
      <q-input
        id="llm-inline-prompt"
        :model-value="store.config.inlinePrompt"
        type="textarea"
        rows="4"
        outlined
        dense
        class="q-mt-xs pd-mono"
        :hint="INLINE_HINT"
        placeholder="Redacta una noticia a partir de {{parsed_email.clean_body}}"
        @update:model-value="store.updateConfig({ inlinePrompt: String($event ?? '') })"
      />
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

    <!-- No bloquea: el backend resuelve el conflicto, pero en silencio. -->
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

    <!-- Inventario real de lo que el flujo publica, como en el mapeador. -->
    <div class="q-mt-md" data-test="prompt-variables-field">
      <label class="pd-label" for="llm-variables">Variables disponibles</label>
      <q-select
        id="llm-variables"
        :model-value="null"
        :options="store.promptVariableOptions"
        outlined
        dense
        emit-value
        map-options
        class="q-mt-xs"
        :disable="store.promptVariableOptions.length === 0"
        :hint="store.promptVariableOptions.length > 0 ? VARIABLES_HINT : NO_VARIABLES_HINT"
        @update:model-value="onCopyVariable(String($event))"
      >
        <template #option="scope">
          <q-item v-bind="scope.itemProps">
            <q-item-section>
              <q-item-label>{{ scope.opt.label }}</q-item-label>
              <q-item-label caption class="pd-mono pd-variable-option">
                {{ scope.opt.value }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </div>

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
        <q-input
          id="llm-model"
          :model-value="store.config.model"
          outlined
          dense
          class="q-mt-xs pd-mono"
          :hint="MODEL_HINT"
          :rules="[(val: string) => !!val?.trim() || 'El modelo es obligatorio']"
          @update:model-value="store.updateConfig({ model: String($event ?? '') })"
        />
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

      <div class="col-12 col-md-4" data-test="timeout-field">
        <label class="pd-label" for="llm-timeout">Espera maxima (ms)</label>
        <q-input
          id="llm-timeout"
          :model-value="store.config.timeoutMs"
          type="number"
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

      <div class="col-12 col-md-4" data-test="retries-field">
        <label class="pd-label" for="llm-retries">Reintentos de red</label>
        <q-input
          id="llm-retries"
          :model-value="store.config.maxRetries"
          type="number"
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
  </section>
</template>

<style scoped lang="scss">
.pd-node-icon {
  color: var(--pd-primary);
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

.pd-variable-option {
  color: var(--pd-accent-text);
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
