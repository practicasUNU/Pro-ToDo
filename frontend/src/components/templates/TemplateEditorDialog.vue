<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { useQuasar, type QInput } from 'quasar';

import { useTemplatesStore } from '@stores/templates.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import { TEMPLATE_NAMESPACES, type HtmlTemplate } from '@/types/html-template';

interface Props {
  modelValue: boolean;
  template: HtmlTemplate | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [template: HtmlTemplate];
}>();

const $q = useQuasar();
const templatesStore = useTemplatesStore();

// Los ejemplos con llaves viven aqui y no en la plantilla: el compilador de Vue
// no sabe distinguir unas llaves literales de una interpolacion anidada.
const HTML_PLACEHOLDER = '<h1>{{parsed_email.clean_title}}</h1>';
const FORBIDDEN_BLOCK_EXAMPLE = '{{#if}}';

const htmlInput = ref<QInput | null>(null);

const form = reactive<{ name: string; description: string; htmlContent: string }>({
  name: '',
  description: '',
  htmlContent: '',
});

const isEditMode = computed(() => !!props.template);

const resetForm = (): void => {
  form.name = props.template?.name ?? '';
  form.description = props.template?.description ?? '';
  form.htmlContent = props.template?.htmlContent ?? '';
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

/**
 * Inserta `{{namespace.}}` en la posicion del cursor (Poka-Yoke).
 *
 * El autor elige el namespace de la lista blanca en vez de teclearlo: es la
 * unica forma de no equivocarse ANTES de que el backend rechace la plantilla.
 * El cursor queda entre el punto y las llaves, listo para escribir el campo.
 */
const insertNamespace = (namespace: string): void => {
  const snippet = `{{${namespace}.}}`;

  // `nativeEl` es el <textarea> real; el ref de una QInput apunta al componente,
  // que no tiene selectionStart. Si aun no esta montado, se anade al final.
  const textarea = htmlInput.value?.nativeEl;

  if (!textarea) {
    form.htmlContent += snippet;
    return;
  }

  const selectionStart = textarea.selectionStart ?? form.htmlContent.length;
  const selectionEnd = textarea.selectionEnd ?? selectionStart;

  form.htmlContent = `${form.htmlContent.slice(0, selectionStart)}${snippet}${form.htmlContent.slice(selectionEnd)}`;

  // El caret queda entre el punto y las llaves, listo para escribir el campo.
  // Hay que esperar al repintado: antes de el, el textarea aun tiene el texto
  // viejo y setSelectionRange se aplicaria sobre indices que ya no valen.
  const caretPosition = selectionStart + snippet.length - 2;

  void nextTick(() => {
    textarea.focus();
    textarea.setSelectionRange(caretPosition, caretPosition);
  });
};

const onSubmit = async (): Promise<void> => {
  const description = form.description.trim();

  try {
    // `exactOptionalPropertyTypes`: la clave se omite en vez de enviarse como
    // `undefined`, que el tipo del payload no admite.
    const payload = {
      name: form.name.trim(),
      htmlContent: form.htmlContent,
      ...(description ? { description } : {}),
    };

    const saved =
      isEditMode.value && props.template
        ? await templatesStore.updateTemplate(props.template.id, payload)
        : await templatesStore.createTemplate(payload);

    emit('saved', saved);
    closeDialog();
  } catch (error) {
    // El 400 del backend cita la variable invalida (`invalidVariable`): se
    // muestra tal cual porque es exactamente lo que el autor necesita corregir.
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo guardar la plantilla'),
      timeout: 6000,
    });
  }
};
</script>

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card pd-editor-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="description" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar plantilla' : 'Nueva plantilla' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <div>
            <label class="pd-label" for="template-name">
              Nombre<span class="pd-required">*</span>
            </label>
            <q-input
              id="template-name"
              v-model="form.name"
              outlined
              dense
              class="q-mt-xs"
              maxlength="120"
              placeholder="noticia-basica"
              :rules="[(val: string) => !!val.trim() || 'El nombre es obligatorio']"
            />
          </div>

          <div>
            <label class="pd-label" for="template-description">Descripcion</label>
            <q-input
              id="template-description"
              v-model="form.description"
              outlined
              dense
              class="q-mt-xs"
              maxlength="255"
              placeholder="Cuerpo de noticia con titular y resumen"
            />
          </div>

          <!-- Chips Poka-Yoke: el namespace se elige, no se teclea -->
          <div>
            <div class="pd-label">Namespaces disponibles</div>
            <p class="pd-subtitle q-mt-xs q-mb-sm">
              Pulsa uno para insertarlo en el cursor. Solo estos estan permitidos.
            </p>
            <div class="pd-chip-bar">
              <q-chip
                v-for="namespace in TEMPLATE_NAMESPACES"
                :key="namespace"
                clickable
                dense
                class="pd-namespace-chip pd-mono"
                :label="namespace"
                @click="insertNamespace(namespace)"
              />
            </div>
          </div>

          <div>
            <label class="pd-label" for="template-html">
              Contenido HTML<span class="pd-required">*</span>
            </label>
            <q-input
              id="template-html"
              ref="htmlInput"
              v-model="form.htmlContent"
              type="textarea"
              outlined
              class="q-mt-xs pd-mono"
              input-class="pd-mono"
              :rows="10"
              :placeholder="HTML_PLACEHOLDER"
              :rules="[(val: string) => !!val.trim() || 'El contenido es obligatorio']"
            />
            <p class="pd-subtitle q-mt-xs">
              Solo sustitucion de variables. Prohibidos los bloques
              <span class="pd-mono">{{ FORBIDDEN_BLOCK_EXAMPLE }}</span
              >, los parciales y el triple-stash.
            </p>
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancelar" class="pd-btn-cancel" @click="closeDialog" />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            label="Guardar"
            icon-right="north_east"
            type="submit"
            :loading="templatesStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
// Solo maquetacion y tokens: ningun color literal.
.pd-editor-card {
  min-width: 620px;
}

.pd-dialog-icon {
  color: var(--pd-primary);
}

.pd-btn-cancel {
  color: var(--pd-text-secondary);
}

.pd-chip-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pd-namespace-chip {
  background: var(--pd-surface-muted);
  color: var(--pd-accent-text);
  border: 1px solid var(--pd-border);
}

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
