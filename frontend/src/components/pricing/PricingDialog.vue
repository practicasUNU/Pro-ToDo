<script setup lang="ts">
import { computed, reactive, watch } from 'vue';

import { blockNonDecimalKeys } from '@/utils/numeric-input';

import {
  ANY_MODEL,
  MAX_RATE_USD_PER_MTOK,
  MODEL_ID_PATTERN,
  PRICING_PROVIDERS,
} from '@/types/pricing';

import type { CreatePricingPayload, ModelPricing, PricingProvider } from '@/types/pricing';

/**
 * Formulario de una tarifa de IA.
 *
 * NO persiste: emite `request-save` y es el padre quien abre el `WarningModal`
 * de 5 s antes de llamar al store. Registrar una tarifa cambia el coste de
 * toda inferencia futura del modelo, asi que merece la misma pausa que una
 * accion critica.
 *
 * Con `base` (tarifa vigente) el par queda FIJO: "actualizar" una tarifa es
 * registrar la siguiente del mismo proveedor y modelo, y el backend pasa la
 * anterior a historico. Cambiar el par desde aqui seria crear otro, no editar.
 */
interface Props {
  modelValue: boolean;
  base: ModelPricing | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  requestSave: [payload: CreatePricingPayload];
}>();

interface PricingForm {
  aiProvider: PricingProvider | null;
  aiModel: string;
  promptRateUsdPerMTok: number | null;
  completionRateUsdPerMTok: number | null;
  reasoningRateUsdPerMTok: number | null;
}

const PROVIDER_OPTIONS = PRICING_PROVIDERS.map((provider) => ({
  label: provider,
  value: provider,
}));

/** Seis decimales como maximo: el tope de `NUMERIC(12, 6)`. */
const MAX_DECIMALS_PATTERN = /^\d+(\.\d{1,6})?$/;

const form = reactive<PricingForm>({
  aiProvider: null,
  aiModel: '',
  promptRateUsdPerMTok: null,
  completionRateUsdPerMTok: null,
  reasoningRateUsdPerMTok: null,
});

const isUpdateMode = computed(() => props.base !== null);

const isKnownProvider = (value: string): value is PricingProvider =>
  (PRICING_PROVIDERS as readonly string[]).includes(value);

const resetForm = (): void => {
  const base = props.base;

  form.aiProvider = base !== null && isKnownProvider(base.aiProvider) ? base.aiProvider : null;
  form.aiModel = base?.aiModel ?? '';
  form.promptRateUsdPerMTok = base?.promptRateUsdPerMTok ?? null;
  form.completionRateUsdPerMTok = base?.completionRateUsdPerMTok ?? null;
  form.reasoningRateUsdPerMTok = base?.reasoningRateUsdPerMTok ?? null;
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
  { immediate: true },
);

const requiredRule = (value: unknown): true | string =>
  (value !== null && value !== undefined && value !== '') || 'Campo obligatorio.';

const modelRule = (value: string): true | string => {
  const trimmed = value.trim();

  if (trimmed.length > 100) return 'Máximo 100 caracteres.';

  return (
    MODEL_ID_PATTERN.test(trimmed) ||
    `Solo letras, números, ".", "_", ":" y "-", o el comodín "${ANY_MODEL}".`
  );
};

const rateRule = (value: number | string | null): true | string => {
  if (value === null || value === '') return 'Campo obligatorio.';

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return 'Debe ser un número.';
  if (numeric < 0) return 'No puede ser negativa.';
  if (numeric > MAX_RATE_USD_PER_MTOK) return 'Excede el máximo admitido.';

  return MAX_DECIMALS_PATTERN.test(String(value)) || 'Máximo 6 decimales.';
};

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = (): void => {
  const { aiProvider, promptRateUsdPerMTok, completionRateUsdPerMTok, reasoningRateUsdPerMTok } =
    form;

  // QForm ya valido las reglas; esto solo estrecha los tipos para el compilador.
  if (
    aiProvider === null ||
    promptRateUsdPerMTok === null ||
    completionRateUsdPerMTok === null ||
    reasoningRateUsdPerMTok === null
  ) {
    return;
  }

  emit('requestSave', {
    aiProvider,
    aiModel: form.aiModel.trim(),
    promptRateUsdPerMTok: Number(promptRateUsdPerMTok),
    completionRateUsdPerMTok: Number(completionRateUsdPerMTok),
    reasoningRateUsdPerMTok: Number(reasoningRateUsdPerMTok),
  });
  closeDialog();
};
</script>

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card" data-test="pricing-dialog">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="mdi-cash-multiple" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isUpdateMode ? 'Actualizar tarifa' : 'Nueva tarifa' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <p v-if="isUpdateMode" class="pd-text-secondary q-mb-none">
            La tarifa vigente pasará a histórico al guardar. El historial no se edita.
          </p>

          <div>
            <label class="pd-label" for="pricing-provider">
              Proveedor<span class="pd-required">*</span>
            </label>
            <q-select
              id="pricing-provider"
              v-model="form.aiProvider"
              outlined
              dense
              emit-value
              map-options
              class="q-mt-xs"
              :options="PROVIDER_OPTIONS"
              :disable="isUpdateMode"
              :rules="[requiredRule]"
              data-test="pricing-provider"
            />
          </div>

          <div>
            <label class="pd-label" for="pricing-model">
              Modelo<span class="pd-required">*</span>
            </label>
            <q-input
              id="pricing-model"
              v-model="form.aiModel"
              outlined
              dense
              maxlength="100"
              class="q-mt-xs pd-mono"
              placeholder="gemini-1.5-pro"
              :hint="`Usa ${ANY_MODEL} para la tarifa genérica del proveedor`"
              :disable="isUpdateMode"
              :rules="[requiredRule, modelRule]"
              data-test="pricing-model"
            />
          </div>

          <div class="pd-pricing-rates">
            <div>
              <label class="pd-label" for="pricing-prompt">
                Entrada (USD/M)<span class="pd-required">*</span>
              </label>
              <q-input
                id="pricing-prompt"
                v-model.number="form.promptRateUsdPerMTok"
                type="number"
                outlined
                dense
                min="0"
                step="0.000001"
                class="q-mt-xs"
                :rules="[rateRule]"
                data-test="pricing-prompt"
                @keydown="blockNonDecimalKeys"
              />
            </div>

            <div>
              <label class="pd-label" for="pricing-completion">
                Salida (USD/M)<span class="pd-required">*</span>
              </label>
              <q-input
                id="pricing-completion"
                v-model.number="form.completionRateUsdPerMTok"
                type="number"
                outlined
                dense
                min="0"
                step="0.000001"
                class="q-mt-xs"
                :rules="[rateRule]"
                data-test="pricing-completion"
                @keydown="blockNonDecimalKeys"
              />
            </div>

            <div>
              <label class="pd-label" for="pricing-reasoning">
                Razonamiento (USD/M)<span class="pd-required">*</span>
              </label>
              <q-input
                id="pricing-reasoning"
                v-model.number="form.reasoningRateUsdPerMTok"
                type="number"
                outlined
                dense
                min="0"
                step="0.000001"
                class="q-mt-xs"
                :rules="[rateRule]"
                data-test="pricing-reasoning"
                @keydown="blockNonDecimalKeys"
              />
            </div>
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancelar" class="pd-btn-secondary" @click="closeDialog" />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            label="Revisar y guardar"
            icon-right="north_east"
            type="submit"
            data-test="pricing-submit"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-dialog-icon {
  color: var(--pd-primary);
}

// Solo maquetacion: tres tarifas en fila, apiladas en movil.
.pd-pricing-rates {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
}
</style>
