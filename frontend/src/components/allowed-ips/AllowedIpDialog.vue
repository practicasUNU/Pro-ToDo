<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useAllowedIpsStore } from '@stores/allowed-ips.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { UpdateAllowedIpPayload, AllowedIp } from '@/types/allowed-ip';

interface Props {
  modelValue: boolean;
  entry: AllowedIp | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
  // Editar una IP es tan critico como borrarla (puede abrir/cerrar el perimetro),
  // asi que no se persiste aqui: el padre confirma con el temporizador de 5s
  // (SafeDeleteModal) antes de invocar al store.
  requestUpdate: [{ id: string; payload: UpdateAllowedIpPayload }];
}>();

const $q = useQuasar();
const allowedIpsStore = useAllowedIpsStore();

const form = reactive<{ ipOrCidr: string; description: string }>({
  ipOrCidr: '',
  description: '',
});

const isEditMode = computed(() => !!props.entry);

const resetForm = (): void => {
  form.ipOrCidr = props.entry?.ipOrCidr ?? '';
  form.description = props.entry?.description ?? '';
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = async (): Promise<void> => {
  if (isEditMode.value && props.entry) {
    emit('requestUpdate', {
      id: props.entry.id,
      payload: { ipOrCidr: form.ipOrCidr, description: form.description },
    });
    closeDialog();
    return;
  }

  try {
    await allowedIpsStore.createAllowedIp({
      ipOrCidr: form.ipOrCidr,
      description: form.description,
    });

    emit('saved');
    closeDialog();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo registrar la IP autorizada'),
    });
  }
};
</script>

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="shield" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar IP autorizada' : 'Nueva IP autorizada' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <div>
            <label class="pd-label" for="allowed-ip-value">
              IP o rango CIDR<span class="pd-required">*</span>
            </label>
            <q-input
              id="allowed-ip-value"
              v-model="form.ipOrCidr"
              outlined
              dense
              class="q-mt-xs pd-mono"
              placeholder="192.168.1.0/24"
              :rules="[(val: string) => !!val || 'La IP o rango CIDR es obligatoria']"
            />
          </div>

          <div>
            <label class="pd-label" for="allowed-ip-description">
              Descripcion<span class="pd-required">*</span>
            </label>
            <q-input
              id="allowed-ip-description"
              v-model="form.description"
              outlined
              dense
              class="q-mt-xs"
              placeholder="VPN Corporativa Madrid"
              :rules="[(val: string) => !!val || 'La descripcion es obligatoria']"
            />
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancelar" class="pd-btn-secondary" @click="closeDialog" />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            label="Guardar"
            icon-right="north_east"
            type="submit"
            :loading="allowedIpsStore.isLoading"
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

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}
</style>
