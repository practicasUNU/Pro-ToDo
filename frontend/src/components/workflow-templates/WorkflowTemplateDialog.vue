<script setup lang="ts">
import { computed, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { WorkflowTemplateSummary } from '@/types/pipeline';

interface Props {
  modelValue: boolean;
  /** Plantilla a editar, o `null` para un alta. */
  template: WorkflowTemplateSummary | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
}>();

const $q = useQuasar();
// Cero llamadas HTTP en el componente: todo pasa por el store (§3.1 / §2.1).
const templatesStore = useWorkflowTemplatesStore();

const isEditing = computed<boolean>(() => props.template !== null);

/**
 * Prepara el borrador al abrir.
 *
 * En edicion se pide el DETALLE, porque el listado no trae `pipelineSchema`: los
 * `params` de cada nodo no viajan en el catalogo, y son justo lo que hay que
 * editar aqui. `QDialog` mantiene el componente montado entre aperturas, asi que
 * sin este `watch` se editaria el borrador de la plantilla anterior.
 */
watch(
  () => props.modelValue,
  async (isOpen) => {
    if (!isOpen) return;

    if (props.template === null) {
      templatesStore.initDraft();
      return;
    }

    try {
      await templatesStore.loadForEdit(props.template.id);
    } catch (error) {
      $q.notify({
        type: 'negative',
        message: extractApiErrorMessage(error, 'No se pudo cargar la plantilla'),
      });
      emit('update:modelValue', false);
    }
  },
);

const onSubmit = async (): Promise<void> => {
  try {
    await templatesStore.saveDraft();
    emit('saved');
    emit('update:modelValue', false);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo guardar la plantilla'),
    });
  }
};
</script>

<template>
  <q-dialog :model-value="props.modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pd-card pd-template-dialog">
      <q-card-section>
        <div class="pd-h2">
          {{ isEditing ? 'Editar plantilla de flujo' : 'Nueva plantilla de flujo' }}
        </div>
        <p class="pd-subtitle q-mt-xs q-mb-none">
          La topologia base de la que partiran los flujos. El servidor valida el grafo completo
          —forma, tipos e integridad— antes de guardarlo.
        </p>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md">
          <div>
            <label class="pd-label" for="template-name">
              Nombre<span class="pd-required">*</span>
            </label>
            <q-input
              id="template-name"
              :model-value="templatesStore.activeDraft.name"
              outlined
              dense
              class="q-mt-xs"
              maxlength="100"
              placeholder="Notiweb - correo a CMS"
              :rules="[(val: string) => !!val?.trim() || 'El nombre es obligatorio']"
              @update:model-value="templatesStore.patchDraft({ name: String($event ?? '') })"
            />
          </div>

          <div>
            <label class="pd-label" for="template-description">Descripcion</label>
            <q-input
              id="template-description"
              :model-value="templatesStore.activeDraft.description ?? ''"
              outlined
              dense
              class="q-mt-xs"
              maxlength="1000"
              placeholder="Que hace esta topologia y cuando conviene partir de ella"
              @update:model-value="templatesStore.patchDraft({ description: String($event ?? '') })"
            />
          </div>

          <div>
            <label class="pd-label" for="template-schema">
              Topologia (pipeline_schema)<span class="pd-required">*</span>
            </label>
            <q-input
              id="template-schema"
              :model-value="templatesStore.activeDraft.schemaText"
              outlined
              type="textarea"
              class="q-mt-xs pd-mono"
              input-class="pd-mono"
              rows="16"
              :error="templatesStore.schemaSyntaxError !== null"
              :error-message="templatesStore.schemaSyntaxError ?? undefined"
              @update:model-value="templatesStore.patchDraft({ schemaText: String($event ?? '') })"
            />
            <p class="pd-subtitle q-mt-xs q-mb-none">
              Aqui solo se comprueba que el JSON parsee. La coherencia del grafo la decide el
              servidor, que es la unica autoridad sobre la topologia.
            </p>
          </div>

          <q-toggle
            :model-value="templatesStore.activeDraft.active"
            color="primary"
            label="Disponible en el asistente"
            @update:model-value="templatesStore.patchDraft({ active: $event })"
          />
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
            :label="isEditing ? 'Guardar cambios' : 'Crear plantilla'"
            icon-right="north_east"
            :disable="!templatesStore.isDraftValid"
            :loading="templatesStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-template-dialog {
  width: 760px;
  max-width: 92vw;
}

// Los inputs consumen los tokens de superficie y borde (regla §2).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
