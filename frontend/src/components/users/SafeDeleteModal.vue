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

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card pd-card--accent pd-accent-urgente">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="warning_amber" size="20px" class="pd-danger-icon" />
        </span>
        <div class="pd-h2">{{ title }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none pd-text-secondary">
        {{ message }}
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancelar" class="pd-btn-cancel" @click="onCancel" />
        <q-btn
          class="pd-btn-danger"
          unelevated
          no-caps
          :label="confirmButtonLabel"
          :disable="secondsRemaining > 0"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-danger-icon {
  color: var(--pd-negative);
}

.pd-btn-cancel {
  color: var(--pd-text-secondary);
}
</style>
