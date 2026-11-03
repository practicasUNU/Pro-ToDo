<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { usePromptOptimizerStore } from '@stores/prompt-optimizer.store';

import { extractApiErrorCode, extractApiErrorMessage } from '@/utils/api-error';
import { ALERT_TIMEOUT_MS } from '@/utils/alert-categorizer';
import { formatInteger, formatUsd } from '@/utils/number-format';
import { MANDATORY_CHIP_CLASS, OPTIONAL_CHIP_CLASS, buildMarker } from '@/utils/prompt-markers';

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

/** Puente del `q-toggle` con la cardinalidad del store. */
const isMultipleCardinality = computed<boolean>({
  get: () => optimizerStore.outputCardinality === 'MULTIPLE',
  set: (isMultiple) => {
    optimizerStore.outputCardinality = isMultiple ? 'MULTIPLE' : 'SINGLE';
  },
});

const canGenerate = computed(
  () => props.draftPrompt.trim().length > 0 && !optimizerStore.isLoading,
);

/** `ns.campo` -> `{{*ns.campo}}` o `{{ns.campo}}`, tal como va en el prompt. */
const markerForPath = (path: string, mandatory: boolean): string => {
  const separator = path.indexOf('.');

  return separator < 0
    ? path
    : buildMarker(path.slice(0, separator), path.slice(separator + 1), mandatory);
};

/** Hay alguna variable que mostrar en el bloque de recomendadas. */
const hasRecommendedVariables = computed(() => {
  const variables = result.value?.recommendedVariables;

  return (variables?.mandatory.length ?? 0) + (variables?.optional.length ?? 0) > 0;
});

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
          <div class="pd-prompt-optimizer__cardinality" data-test="optimizer-cardinality">
            <q-toggle
              v-model="isMultipleCardinality"
              label="Soporte para múltiples peticiones (Lote 1:N)"
              data-test="optimizer-cardinality-toggle"
            />
            <span
              class="pd-badge"
              :class="
                isMultipleCardinality
                  ? 'pd-prompt-optimizer__badge--batch'
                  : 'pd-prompt-optimizer__badge--single'
              "
              data-test="optimizer-cardinality-badge"
            >
              {{ isMultipleCardinality ? 'LOTE (1:N)' : 'UNITARIO (1:1)' }}
            </span>
          </div>
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

        <q-banner
          v-if="isMultipleCardinality"
          dense
          class="pd-prompt-optimizer__batch-notice q-mt-sm"
          data-test="optimizer-batch-notice"
        >
          <template #avatar>
            <q-icon name="layers" size="20px" class="pd-prompt-optimizer__icon" />
          </template>
          Modo lote: el prompt optimizado exigirá el contrato asimétrico — el primer elemento en la
          raíz del JSON y el resto en «items». Úsalo con un procesador de IA configurado como «Varios
          elementos (lote 1:N)».
        </q-banner>

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

          <p
            v-if="result.rationale"
            class="pd-subtitle pd-prompt-optimizer__rationale"
            data-test="optimizer-rationale"
          >
            {{ result.rationale }}
          </p>

          <template v-if="hasRecommendedVariables">
            <h3 class="pd-label pd-prompt-optimizer__heading">Variables recomendadas</h3>
            <!-- El asterisco visible acompaña al color: el estado no depende
                 solo del rojo/azul. -->
            <div class="pd-prompt-optimizer__variables" data-test="optimizer-variables">
              <span
                v-for="path in result.recommendedVariables.mandatory"
                :key="`m-${path}`"
                class="pd-mono"
                :class="MANDATORY_CHIP_CLASS"
                data-test="optimizer-variable-mandatory"
                >{{ markerForPath(path, true) }}</span
              >
              <span
                v-for="path in result.recommendedVariables.optional"
                :key="`o-${path}`"
                class="pd-mono"
                :class="OPTIONAL_CHIP_CLASS"
                data-test="optimizer-variable-optional"
                >{{ markerForPath(path, false) }}</span
              >
            </div>
            <p class="pd-text-secondary pd-prompt-optimizer__hint">
              Obligatoria: el flujo se pausa si falta. Opcional: se sustituye por texto vacío.
            </p>
          </template>

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

.pd-prompt-optimizer__cardinality {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pd-prompt-optimizer__badge--batch {
  background: var(--pd-accent);
  color: var(--pd-on-accent);
}

.pd-prompt-optimizer__badge--single {
  background: var(--pd-surface-muted);
  color: var(--pd-text-secondary);
  border: 1px solid var(--pd-border);
}

.pd-prompt-optimizer__batch-notice {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-accent);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
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

.pd-prompt-optimizer__rationale {
  margin: 12px 0 0;
}

.pd-prompt-optimizer__variables {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pd-prompt-optimizer__hint {
  margin: 6px 0 0;
  font-size: 0.75rem;
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
