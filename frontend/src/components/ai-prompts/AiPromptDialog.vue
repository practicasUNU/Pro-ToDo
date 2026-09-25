<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useAiPromptsStore } from '@stores/ai-prompts.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { AiPromptDetail } from '@/types/ai-prompt';

/** Replican los limites de `prompts_ia` y del DTO del backend. */
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 255;

/**
 * Ejemplo de marcador para la ayuda del formulario.
 *
 * Vive aqui y no en la plantilla porque unas llaves dobles literales dentro del
 * `<template>` las interpreta el compilador de Vue como una interpolacion y el
 * parser aborta.
 */
const MARKER_EXAMPLE = '{{nodo.campo}}';

interface Props {
  modelValue: boolean;
  /** Prompt a editar, con su instruccion ya cargada; `null` para un alta. */
  prompt: AiPromptDetail | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
}>();

const $q = useQuasar();
const aiPromptsStore = useAiPromptsStore();

const form = reactive<{ name: string; description: string; promptText: string }>({
  name: '',
  description: '',
  promptText: '',
});

const isEditMode = computed(() => !!props.prompt);

const resetForm = (): void => {
  form.name = props.prompt?.name ?? '';
  // La columna es nullable pero el input necesita una cadena: se normaliza aqui
  // y se vuelve a convertir al enviar.
  form.description = props.prompt?.description ?? '';
  form.promptText = props.prompt?.promptText ?? '';
};

// Se resetea al ABRIR y no en `onMounted`: el dialogo se monta una sola vez y se
// reutiliza para todas las filas, asi que sin esto la segunda edicion mostraria
// los datos de la primera.
watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = async (): Promise<void> => {
  // Una descripcion vaciada se envia como cadena vacia y no se omite: omitirla
  // dejaria la anterior intacta, que es lo contrario de lo que pidio el usuario.
  const description = form.description.trim();

  try {
    if (isEditMode.value && props.prompt) {
      await aiPromptsStore.updatePrompt(props.prompt.id, {
        name: form.name.trim(),
        description,
        promptText: form.promptText,
      });
    } else {
      await aiPromptsStore.createPrompt({
        name: form.name.trim(),
        description,
        promptText: form.promptText,
      });
    }

    emit('saved');
    closeDialog();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo guardar el prompt'),
    });
  }
};
</script>

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card pd-prompt-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="psychology" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar prompt' : 'Nuevo prompt' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <div>
            <label class="pd-label" for="prompt-name">
              Nombre<span class="pd-required">*</span>
            </label>
            <q-input
              id="prompt-name"
              v-model="form.name"
              outlined
              dense
              class="q-mt-xs"
              placeholder="extraccion-noticia-es"
              :maxlength="MAX_NAME_LENGTH"
              counter
              :rules="[
                (val: string) => !!val.trim() || 'El nombre es obligatorio',
                (val: string) =>
                  val.length <= MAX_NAME_LENGTH || `Maximo ${MAX_NAME_LENGTH} caracteres`,
              ]"
            />
          </div>

          <div>
            <label class="pd-label" for="prompt-description">Descripcion</label>
            <q-input
              id="prompt-description"
              v-model="form.description"
              outlined
              dense
              class="q-mt-xs"
              placeholder="Para que sirve este prompt"
              :maxlength="MAX_DESCRIPTION_LENGTH"
              counter
              :rules="[
                (val: string) =>
                  val.length <= MAX_DESCRIPTION_LENGTH ||
                  `Maximo ${MAX_DESCRIPTION_LENGTH} caracteres`,
              ]"
            />
          </div>

          <!-- Monoespaciada (.pd-mono): el texto lleva marcadores {{nodo.campo}}
               y una tipografia proporcional dificulta ver un punto de mas. -->
          <div>
            <label class="pd-label" for="prompt-text">
              Instruccion<span class="pd-required">*</span>
            </label>
            <q-input
              id="prompt-text"
              v-model="form.promptText"
              type="textarea"
              outlined
              class="q-mt-xs pd-mono"
              input-class="pd-mono"
              rows="8"
              counter
              placeholder="Extrae el titular de: {{parsed_email.clean_body}}"
              :rules="[(val: string) => !!val.trim() || 'La instruccion es obligatoria']"
            />
            <p class="pd-subtitle q-mt-xs q-mb-none">
              Admite marcadores <span class="pd-mono">{{ MARKER_EXAMPLE }}</span
              >, que el motor resuelve contra el contexto en tiempo de ejecucion.
            </p>
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
            :loading="aiPromptsStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.pd-prompt-card {
  width: 640px;
  max-width: 90vw;
}

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
