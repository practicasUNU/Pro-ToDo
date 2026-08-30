<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';

import type { QInput } from 'quasar';

/** Digitos del codigo, fijados por `VerifyOtpDto` en el backend. */
const OTP_LENGTH = 6;

interface Props {
  modelValue: string;
  disable?: boolean;
  autofocus?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  disable: false,
  autofocus: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  /** Se emite cuando las seis casillas estan llenas, para enviar sin pulsar boton. */
  complete: [value: string];
}>();

// Una casilla por digito. El v-model del padre sigue siendo la cadena completa:
// este componente es el unico que conoce la division en casillas.
const digits = ref<string[]>(Array.from({ length: OTP_LENGTH }, () => ''));
const inputRefs = ref<(QInput | null)[]>([]);

const code = computed(() => digits.value.join(''));

const setInputRef = (element: unknown, index: number): void => {
  inputRefs.value[index] = (element as QInput | null) ?? null;
};

const focusAt = (index: number): void => {
  if (index < 0 || index >= OTP_LENGTH) return;
  void nextTick(() => inputRefs.value[index]?.focus());
};

const emitCode = (): void => {
  emit('update:modelValue', code.value);

  if (code.value.length === OTP_LENGTH) {
    emit('complete', code.value);
  }
};

/**
 * Avance automatico. Se dispara en `update:model-value` y no en `keyup` porque
 * asi cubre tambien el dictado por voz y el autorrelleno del SMS/correo, que no
 * generan pulsaciones de tecla.
 */
const onDigitInput = (index: number, rawValue: string | number | null): void => {
  const onlyDigits = String(rawValue ?? '').replace(/\D/g, '');

  // Pegar el codigo entero en cualquier casilla lo reparte por las siguientes.
  if (onlyDigits.length > 1) {
    const chars = onlyDigits.slice(0, OTP_LENGTH - index).split('');
    chars.forEach((char, offset) => {
      digits.value[index + offset] = char;
    });

    focusAt(Math.min(index + chars.length, OTP_LENGTH - 1));
    emitCode();
    return;
  }

  digits.value[index] = onlyDigits;
  if (onlyDigits) focusAt(index + 1);

  emitCode();
};

/** Retroceso sobre una casilla vacia: salta a la anterior y la borra. */
const onBackspace = (index: number): void => {
  if (digits.value[index]) return;

  digits.value[Math.max(0, index - 1)] = '';
  focusAt(index - 1);
  emitCode();
};

// Cuando el padre limpia el codigo (por ejemplo tras un 401), se vacian las
// casillas y el foco vuelve a la primera.
watch(
  () => props.modelValue,
  (value) => {
    if (value === code.value) return;

    digits.value = Array.from({ length: OTP_LENGTH }, (_, index) => value[index] ?? '');

    if (!value) focusAt(0);
  },
);

defineExpose({ focusFirst: () => focusAt(0) });
</script>

<template>
  <div class="otp-grid" role="group" aria-label="Codigo de acceso de 6 digitos">
    <q-input
      v-for="(digit, index) in digits"
      :key="index"
      :ref="(element) => setInputRef(element, index)"
      :model-value="digit"
      outlined
      dense
      hide-bottom-space
      inputmode="numeric"
      maxlength="6"
      :disable="disable"
      :autofocus="autofocus && index === 0"
      :aria-label="`Digito ${index + 1} de ${OTP_LENGTH}`"
      class="otp-grid__cell pd-mono"
      @update:model-value="(value) => onDigitInput(index, value)"
      @keydown.backspace="onBackspace(index)"
      @keydown.left="focusAt(index - 1)"
      @keydown.right="focusAt(index + 1)"
    />
  </div>
</template>

<style scoped lang="scss">
.otp-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.otp-grid__cell {
  :deep(input) {
    text-align: center;
    font-size: 20px;
    font-weight: 700;
    padding: 0;
  }

  :deep(.q-field__control) {
    background: var(--pd-card-bg);
    height: 48px;
  }

  :deep(.q-field__control::before) {
    border-color: var(--pd-border);
  }

  // Foco activo con el azul de marca, para que se vea que casilla se rellena.
  :deep(.q-field--focused .q-field__control::after) {
    border-color: var(--pd-primary-light);
  }
}
</style>
