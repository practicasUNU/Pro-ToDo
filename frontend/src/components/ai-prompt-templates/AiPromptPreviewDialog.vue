<script setup lang="ts">
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { AiPromptTemplateDetail } from '@/types/ai-prompt-template';

interface Props {
  modelValue: boolean;
  /** Plantilla a mostrar, o `null` si todavia no hay ninguna elegida. */
  promptId: string | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const $q = useQuasar();
// Cero llamadas HTTP en el componente: todo pasa por el store (§2.1).
const promptsStore = useAiPromptTemplatesStore();

/**
 * Detalle cargado, con su `promptText`.
 *
 * Estado LOCAL y no del store: es lo que este dialogo esta mirando ahora mismo,
 * no un dato compartido. `GET /ai-prompt-templates` omite `promptText` a
 * proposito, asi que el listado que alimenta el selector no basta y hay que
 * pedir el detalle.
 */
const detail = ref<AiPromptTemplateDetail | null>(null);
const isLoading = ref(false);

const loadDetail = async (): Promise<void> => {
  const { promptId } = props;

  if (promptId === null) return;

  isLoading.value = true;
  detail.value = null;

  try {
    detail.value = await promptsStore.loadPromptById(promptId);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar la plantilla de prompt'),
    });
    emit('update:modelValue', false);
  } finally {
    isLoading.value = false;
  }
};

// `QDialog` mantiene el componente montado entre aperturas, asi que sin este
// `watch` se mostraria el prompt de la apertura anterior.
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) void loadDetail();
  },
);
</script>

<template>
  <q-dialog :model-value="props.modelValue" @update:model-value="emit('update:modelValue', $event)">
    <q-card class="pd-card pd-prompt-preview">
      <q-card-section>
        <div class="pd-h2">{{ detail?.name ?? 'Plantilla de prompt' }}</div>
        <p v-if="detail?.description" class="pd-subtitle q-mt-xs q-mb-none">
          {{ detail.description }}
        </p>
      </q-card-section>

      <q-card-section class="pd-prompt-preview__body">
        <q-inner-loading :showing="isLoading" />

        <!-- SOLO LECTURA: este dialogo existe para comprobar que la plantilla
             elegida es la que se creia, no para editarla. Editar desde aqui
             cambiaria un activo compartido por varios flujos sin decirlo. -->
        <pre v-if="detail" class="pd-mono pd-prompt-preview__text" data-test="prompt-text">{{
          detail.promptText
        }}</pre>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn
          flat
          no-caps
          class="pd-btn-secondary"
          label="Cerrar"
          @click="emit('update:modelValue', false)"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-prompt-preview {
  width: 92vw;
  max-width: 760px;
}

.pd-prompt-preview__body {
  position: relative;
  min-height: 120px;
  max-height: 60vh;
  overflow-y: auto;
}

// `pre` conserva los saltos del prompt, que son parte de su significado: una
// instruccion por linea se lee distinto que un parrafo corrido.
.pd-prompt-preview__text {
  margin: 0;
  padding: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}
</style>
