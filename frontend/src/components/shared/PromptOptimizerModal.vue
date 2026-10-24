<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { usePromptOptimizerStore } from '@stores/prompt-optimizer.store';

import { extractApiErrorCode, extractApiErrorMessage } from '@/utils/api-error';
import { ALERT_TIMEOUT_MS } from '@/utils/alert-categorizer';
import { formatInteger, formatUsd } from '@/utils/number-format';

import type { PromptTargetFormat } from '@/types/prompt-optimizer';

/**
 * Asistente "Mejorar Prompt con IA".
 *
 * Recibe el borrador del formulario que lo abre y devuelve, con `apply`, el
 * prompt optimizado; el anfitrion decide donde escribirlo. No llama al
 * servicio al abrirse: cada propuesta es una inferencia de PAGO, asi que solo
 * se pide con un clic explicito en "Generar propuesta".
 *
 * El formato de salida es un `q-select` cerrado (Poka-Yoke): solo los cuatro
 * que el backend sabe optimizar.
 */
const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** Borrador actual del formulario anfitrion. */
    draftPrompt: string;
    /** Formato propuesto al abrir; el usuario puede cambiarlo. */
    defaultFormat?: PromptTargetFormat;
  }>(),
  { defaultFormat: 'text' },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  apply: [prompt: string];
}>();

const $q = useQuasar();
const optimizerStore = usePromptOptimizerStore();

const FORMAT_OPTIONS: ReadonlyArray<{ label: string; value: PromptTargetFormat }> = [
  { label: 'HTML', value: 'html' },
  { label: 'Texto plano', value: 'text' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'JSON', value: 'json' },
];

const targetFormat = ref<PromptTargetFormat>(props.defaultFormat);

const result = computed(() => optimizerStore.result);

const canGenerate = computed(
  () => props.draftPrompt.trim().length > 0 && !optimizerStore.isLoading,
);

/** Texto del chip de consumo: tokens totales y coste en USD. */
const usageLabel = computed(() => {
  const telemetry = result.value?.telemetry;

  if (telemetry === undefined) return '';

  const totalTokens =
    telemetry.tokensPrompt + telemetry.tokensCompletion + telemetry.tokensReasoning;

  return `${formatInteger(totalTokens)} tokens · ${telemetry.isEstimated ? '≈ ' : ''}${formatUsd(telemetry.estimatedCostUSD)}`;
});

// Cada apertura parte de cero: una propuesta de un borrador anterior no debe
// poder aplicarse sobre el actual.
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      targetFormat.value = props.defaultFormat;
      optimizerStore.clear();
    }
  },
  { immediate: true },
);

const generate = async (): Promise<void> => {
  if (!canGenerate.value) return;

  try {
    await optimizerStore.optimize({
      draftPrompt: props.draftPrompt,
      targetFormat: targetFormat.value,
    });
  } catch (error) {
    // El codigo va de `caption` y no dentro del mensaje: es el contrato
    // estable que identifica el fallo —el texto cambia con cada version— y es
    // lo unico que el operador puede citar o buscar en la trazabilidad. Se
    // perdia porque `extractApiErrorMessage` solo lee `message`.
    const code = extractApiErrorCode(error);

    $q.notify({
      type: 'negative',
      multiLine: true,
      message: extractApiErrorMessage(error, 'No se pudo optimizar el prompt.'),
      ...(code === null ? {} : { caption: code }),
      // El mensaje del backend ya trae el consejo de recuperacion cuando el
      // fallo fue de tiempo o de presupuesto, y es mas largo que un aviso
      // corriente: con los 5000 por defecto no da tiempo a leerlo.
      timeout: ALERT_TIMEOUT_MS,
    });
  }
};

const close = (): void => {
  emit('update:modelValue', false);
};

const applyPrompt = (): void => {
  if (result.value === null) return;

  emit('apply', result.value.optimizedPrompt);
  close();
};
</script>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pd-dialog-card pd-prompt-optimizer" data-test="prompt-optimizer">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon
            name="auto_fix_high"
            size="20px"
            class="pd-prompt-optimizer__icon"
            aria-hidden="true"
          />
        </span>
        <div class="col">
          <div class="pd-h2">Mejorar prompt con IA</div>
          <div class="pd-text-secondary">
            Reescribe el borrador con reglas de ingeniería de prompts. Cada propuesta consume tokens
            y queda registrada en los informes de consumo.
          </div>
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <div class="pd-prompt-optimizer__controls">
          <q-select
            v-model="targetFormat"
            class="pd-prompt-optimizer__format"
            dense
            outlined
            emit-value
            map-options
            :options="FORMAT_OPTIONS"
            label="Formato de salida"
            data-test="optimizer-format"
          />
          <q-btn
            class="pd-btn-secondary"
            flat
            no-caps
            icon="auto_fix_high"
            label="Generar propuesta"
            :loading="optimizerStore.isLoading"
            :disable="!canGenerate"
            data-test="optimizer-generate"
            @click="generate"
          />
        </div>

        <div v-if="optimizerStore.isLoading" class="pd-prompt-optimizer__loading" role="status">
          <q-spinner size="24px" />
          <span>Analizando el borrador…</span>
        </div>

        <template v-else-if="result">
          <div class="pd-prompt-optimizer__meta">
            <q-chip
              dense
              square
              icon="toll"
              class="pd-prompt-optimizer__usage"
              data-test="optimizer-usage"
            >
              {{ usageLabel }}
            </q-chip>
            <span class="pd-mono pd-text-secondary">{{ result.telemetry.model }}</span>
          </div>

          <h3 class="pd-label pd-prompt-optimizer__heading">Propuesta optimizada</h3>
          <pre class="pd-mono pd-prompt-optimizer__proposal" data-test="optimizer-proposal">{{
            result.optimizedPrompt
          }}</pre>

          <h3 class="pd-label pd-prompt-optimizer__heading">Recomendaciones</h3>
          <ul
            v-if="result.recommendations.length > 0"
            class="pd-prompt-optimizer__recommendations"
            data-test="optimizer-recommendations"
          >
            <li v-for="(recommendation, index) in result.recommendations" :key="index">
              {{ recommendation }}
            </li>
          </ul>
          <p v-else class="pd-text-secondary">El modelo no añadió recomendaciones.</p>
        </template>

        <p v-else class="pd-text-secondary" data-test="optimizer-empty">
          Elige el formato de salida y pulsa «Generar propuesta». El borrador no se modifica hasta
          que apliques la propuesta.
        </p>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          flat
          no-caps
          label="Cerrar"
          class="pd-btn-secondary"
          data-test="optimizer-close"
          @click="close"
        />
        <q-btn
          unelevated
          no-caps
          icon-right="north_east"
          label="Aplicar Prompt"
          class="pd-btn-primary"
          :disable="result === null"
          data-test="optimizer-apply"
          @click="applyPrompt"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-prompt-optimizer {
  width: 820px;
}

.pd-prompt-optimizer__icon {
  color: var(--pd-primary);
}

.pd-prompt-optimizer__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.pd-prompt-optimizer__format {
  min-width: 200px;
}

.pd-prompt-optimizer__loading,
.pd-prompt-optimizer__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.pd-prompt-optimizer__usage {
  background: var(--pd-accent-soft);
  color: var(--pd-accent-text);
}

.pd-prompt-optimizer__heading {
  margin: 16px 0 6px;
}

.pd-prompt-optimizer__proposal {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: 12px;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  color: var(--pd-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.pd-prompt-optimizer__recommendations {
  margin: 0;
  padding-left: 20px;
  color: var(--pd-text-secondary);

  li + li {
    margin-top: 4px;
  }
}
</style>
