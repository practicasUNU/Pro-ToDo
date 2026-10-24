<script setup lang="ts">
import { computed } from 'vue';

import { useConfirmCountdown } from '@/composables/useConfirmCountdown';

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

// RNF: el boton de confirmacion permanece deshabilitado durante 5 s forzados.
const { secondsRemaining, isLocked } = useConfirmCountdown(() => props.modelValue);

const confirmButtonLabel = computed(() =>
  isLocked.value ? `Espera ${secondsRemaining.value}s` : props.confirmLabel,
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const onConfirm = (): void => {
  if (isLocked.value) return;

  emit('confirm');
  emit('update:modelValue', false);
};

const onCancel = (): void => {
  emit('cancel');
  emit('update:modelValue', false);
};
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
        <q-btn flat no-caps label="Cancelar" class="pd-btn-secondary" @click="onCancel" />
        <q-btn
          class="pd-btn-danger"
          unelevated
          no-caps
          :label="confirmButtonLabel"
          :disable="isLocked"
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
</style>
