<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useTemplatesStore } from '@stores/templates.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { HtmlTemplate } from '@/types/html-template';

interface Props {
  modelValue: boolean;
  template: HtmlTemplate | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const $q = useQuasar();
const templatesStore = useTemplatesStore();

const compiledMarkup = ref<string | null>(null);
const isCompiling = ref(false);

const loadPreview = async (): Promise<void> => {
  if (!props.template) return;

  isCompiling.value = true;
  compiledMarkup.value = null;

  try {
    // La compilacion la hace el BACKEND, con el mismo TemplateRendererService
    // que usa el nodo en produccion. Compilar aqui exigiria duplicar Handlebars
    // y cualquier divergencia futura daria una vista previa que miente.
    compiledMarkup.value = await templatesStore.previewTemplate(props.template.id);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo compilar la vista previa'),
      timeout: 6000,
    });
    emit('update:modelValue', false);
  } finally {
    isCompiling.value = false;
  }
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) void loadPreview();
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);
</script>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card pd-preview-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="visibility" size="20px" class="pd-dialog-icon" />
        </span>
        <div>
          <div class="pd-h2">Vista previa</div>
          <div class="pd-subtitle pd-mono">{{ template?.name ?? '' }}</div>
        </div>
      </q-card-section>

      <q-card-section class="q-pt-none">
        <p class="pd-subtitle q-mb-sm">
          Las variables sin valor se muestran como marcadores
          <span class="pd-mono">«namespace.campo»</span>.
        </p>

        <!--
          iframe con `sandbox` SIN ningun token allow-*: desactiva scripts,
          formularios y navegacion por completo. El HTML de una plantilla es
          markup arbitrario escrito por un editor, y un v-html ejecutaria
          cualquier <script> que contenga en el mismo origen que la sesion.
        -->
        <div class="pd-preview-frame">
          <q-inner-loading :showing="isCompiling" />
          <iframe
            v-if="compiledMarkup !== null"
            sandbox=""
            title="Vista previa de la plantilla"
            class="pd-preview-iframe"
            :srcdoc="compiledMarkup"
          ></iframe>
        </div>
      </q-card-section>

      <q-card-section v-if="template && template.requiredVariables.length > 0" class="q-pt-none">
        <div class="pd-label">Variables requeridas</div>
        <div class="pd-chip-bar q-mt-xs">
          <q-chip
            v-for="variable in template.requiredVariables"
            :key="variable"
            dense
            class="pd-variable-chip pd-mono"
            :label="variable"
          />
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cerrar" class="pd-btn-cancel" @click="closeDialog" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-preview-card {
  min-width: 680px;
}

.pd-dialog-icon {
  color: var(--pd-primary);
}

.pd-btn-cancel {
  color: var(--pd-text-secondary);
}

.pd-preview-frame {
  position: relative;
  min-height: 240px;
  border: 1px solid var(--pd-border);
  border-radius: 8px;
  overflow: hidden;
  // Fondo blanco fijo y no un token: dentro del iframe se ve el articulo tal y
  // como se publicara en Drupal, no la maqueta de Proto-Do.
  background: #ffffff;
}

.pd-preview-iframe {
  display: block;
  width: 100%;
  min-height: 240px;
  border: 0;
}

.pd-chip-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pd-variable-chip {
  background: var(--pd-surface-muted);
  color: var(--pd-accent-text);
  border: 1px solid var(--pd-border);
}
</style>
