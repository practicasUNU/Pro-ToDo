<script setup lang="ts">
import { computed } from 'vue';

import { useConfirmCountdown } from '@/composables/useConfirmCountdown';

/**
 * Confirmacion de una escritura con efecto amplio que NO es un borrado (por
 * ejemplo, registrar una tarifa de IA: cambia el coste de toda inferencia
 * futura y pasa la vigente a historico).
 *
 * Misma espera forzada de 5 s que `SafeDeleteModal` (`useConfirmCountdown`) y
 * mismo contrato de props/emits, pero con estetica de AVISO (`--pd-warning`,
 * boton primario con degradado) y no de peligro: pintar de rojo un guardado
 * legitimo ensenaria al operador a ignorar el rojo.
 *
 * Persistente: ni el clic fuera ni `Esc` lo cierran. La unica salida sin
 * confirmar es "Cancelar", que nunca emite `confirm`.
 *
 * El slot por defecto admite el resumen de lo que se va a guardar.
 */
interface Props {
  modelValue: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: 'Revisa antes de guardar',
  message: 'Este cambio tiene efecto inmediato. ¿Deseas continuar?',
  confirmLabel: 'Guardar',
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  confirm: [];
  cancel: [];
}>();

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
    <q-card class="pd-dialog-card pd-card--accent pd-accent-grave" data-test="warning-modal">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="mdi-alert-outline" size="20px" class="pd-warning-icon" />
        </span>
        <div class="pd-h2">{{ title }}</div>
      </q-card-section>

      <q-card-section class="q-pt-none pd-text-secondary">
        {{ message }}
      </q-card-section>

      <q-card-section v-if="$slots.default" class="q-pt-none">
        <slot />
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          flat
          no-caps
          label="Cancelar"
          class="pd-btn-secondary"
          data-test="warning-cancel"
          @click="onCancel"
        />
        <q-btn
          class="pd-btn-primary"
          unelevated
          no-caps
          :label="confirmButtonLabel"
          :icon-right="isLocked ? undefined : 'north_east'"
          :disable="isLocked"
          data-test="warning-confirm"
          @click="onConfirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-warning-icon {
  color: var(--pd-warning);
}
</style>
