<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useWorkflowsStore } from '@stores/workflows.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { PipelineSummary } from '@/types/pipeline';

interface Props {
  modelValue: boolean;
  workflow: PipelineSummary | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
}>();

const $q = useQuasar();
const workflowsStore = useWorkflowsStore();

// Estado local del formulario: vive y muere con el dialogo, asi que le
// corresponde al componente y no al store (`frontend-architecture.md` §2.1).
const form = ref<{ name: string; description: string }>({ name: '', description: '' });

/**
 * Reinicia el formulario cada vez que el dialogo se abre.
 *
 * `QDialog` mantiene el componente montado entre aperturas, asi que sin esto
 * editar un flujo, cerrar y abrir otro mostraria los datos del anterior.
 */
watch(
  () => props.modelValue,
  (isOpen) => {
    if (!isOpen) return;

    form.value = {
      name: props.workflow?.name ?? '',
      description: props.workflow?.description ?? '',
    };
  },
);

const onSubmit = async (): Promise<void> => {
  if (props.workflow === null) return;

  try {
    await workflowsStore.updateWorkflow(props.workflow.id, {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
    });

    emit('saved');
    emit('update:modelValue', false);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo actualizar el flujo'),
    });
  }
};
</script>

<template>
  <q-dialog :model-value="props.modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pd-card pd-workflow-dialog">
      <q-card-section>
        <div class="pd-h2">Editar flujo</div>
        <p class="pd-subtitle q-mt-xs q-mb-none">
          Solo el nombre y la descripcion. La topologia se configura en el asistente y el estado con
          el interruptor del catalogo.
        </p>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md">
          <div>
            <label class="pd-label" for="workflow-edit-name">
              Nombre<span class="pd-required">*</span>
            </label>
            <q-input
              id="workflow-edit-name"
              v-model="form.name"
              outlined
              dense
              class="q-mt-xs"
              maxlength="100"
              :rules="[(val: string) => !!val?.trim() || 'El nombre es obligatorio']"
            />
          </div>

          <div>
            <label class="pd-label" for="workflow-edit-description">Descripcion</label>
            <q-input
              id="workflow-edit-description"
              v-model="form.description"
              outlined
              dense
              class="q-mt-xs"
              maxlength="255"
            />
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn
            flat
            no-caps
            class="pd-btn-secondary"
            label="Cancelar"
            @click="emit('update:modelValue', false)"
          />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            type="submit"
            label="Guardar"
            icon-right="north_east"
            :disable="!form.name.trim()"
            :loading="workflowsStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-workflow-dialog {
  width: 520px;
  max-width: 90vw;
}

// Los inputs consumen los tokens de superficie y borde (regla §2).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
