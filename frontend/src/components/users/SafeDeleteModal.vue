<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card style="min-width: 360px">
      <q-card-section class="row items-center q-gutter-sm">
        <q-icon name="warning" color="warning" size="28px" />
        <div class="text-h6">{{ title }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        {{ message }}
      </q-card-section>

      <q-card-actions align="right">
        <q-btn flat label="Cancelar" color="primary" @click="onCancel" />
        <q-btn
          flat
          :label="confirmButtonLabel"
          color="negative"
          :disable="secondsRemaining > 0"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';

// RNF: el boton de confirmacion permanece deshabilitado durante este tiempo forzado
const COUNTDOWN_SECONDS = 5;

interface Props {
  modelValue: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: 'Confirmar accion',
  message: 'Esta accion no se puede deshacer de inmediato. ¿Deseas continuar?',
  confirmLabel: 'Confirmar',
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const secondsRemaining = ref(COUNTDOWN_SECONDS);
let intervalId: ReturnType<typeof setInterval> | undefined;

const confirmButtonLabel = computed(() =>
  secondsRemaining.value > 0 ? `Espera ${secondsRemaining.value}s` : props.confirmLabel,
);

const clearCountdown = (): void => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
};

const startCountdown = (): void => {
  clearCountdown();
  secondsRemaining.value = COUNTDOWN_SECONDS;

  intervalId = setInterval(() => {
    if (secondsRemaining.value <= 1) {
      secondsRemaining.value = 0;
      clearCountdown();
      return;
    }

    secondsRemaining.value -= 1;
  }, 1000);
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      startCountdown();
    } else {
      clearCountdown();
    }
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const onConfirm = (): void => {
  if (secondsRemaining.value > 0) return;

  emit('confirm');
  emit('update:modelValue', false);
};

const onCancel = (): void => {
  emit('cancel');
  emit('update:modelValue', false);
};

onBeforeUnmount(clearCountdown);
</script>
