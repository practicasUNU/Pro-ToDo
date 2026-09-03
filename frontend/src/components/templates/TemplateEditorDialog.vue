<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useTemplatesStore } from '@stores/templates.store';

import { extractApiErrorMessage } from '@/utils/api-error';

import { TEMPLATE_NAMESPACES, type HtmlTemplate } from '@/types/html-template';

// CodeMirror pesa unos cientos de KB y este dialogo lo importan dos componentes
// distintos; en diferido solo se descarga al abrir el editor.
const TemplateCodeEditor = defineAsyncComponent(
  () => import('@components/templates/TemplateCodeEditor.vue'),
);

/** Contrato imperativo que `TemplateCodeEditor` expone con `defineExpose`. */
interface TemplateCodeEditorInstance {
  insertTextAtCursor: (text: string, cursorOffset?: number) => void;
}

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
const VARIABLE_SYNTAX_EXAMPLE = '{{namespace.campo}}';
const FORBIDDEN_BLOCK_EXAMPLE = '{{#if}}';
const FORBIDDEN_TRIPLE_STASH_EXAMPLE = '{{{}}}';

/** Retroceso del caret tras insertar, para dejarlo en `{{namespace.|}}`. */
const CARET_OFFSET_INSIDE_BRACES = -2;

// `InstanceType<typeof ...>` no resuelve a traves de defineAsyncComponent, de
// ahi la interfaz explicita.
const codeEditorRef = ref<TemplateCodeEditorInstance | null>(null);

const isEditMode = computed(() => !!props.template);

watch(
  () => props.modelValue,
  (isOpen) => {
    // El borrador se inicializa AL ABRIR, no al montar: el dialogo permanece en
    // el arbol cerrado, y `props.template` cambia entre un alta y una edicion.
    if (isOpen) templatesStore.initDraft(props.template ?? undefined);
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

/**
 * Inserta `{{namespace.}}` en el cursor (Poka-Yoke).
 *
 * El autor elige el namespace de la lista blanca en vez de teclearlo: es la
 * unica forma de no equivocarse ANTES de que el backend rechace la plantilla.
 *
 * CodeMirror es el dueno del cursor, asi que la insercion se despacha sobre el
 * editor y el store se sincroniza solo por `update:modelValue`. Hacerlo tambien
 * desde el store insertaria el texto dos veces.
 */
const insertNamespace = (namespace: string): void => {
  const snippet = `{{${namespace}.}}`;

  if (codeEditorRef.value) {
    codeEditorRef.value.insertTextAtCursor(snippet, CARET_OFFSET_INSIDE_BRACES);
    return;
  }

  // Red por si el editor aun no ha resuelto su carga diferida.
  templatesStore.insertMarker(namespace);
};

const onSubmit = async (): Promise<void> => {
  const { name, description, htmlContent } = templatesStore.activeDraft;
  const trimmedDescription = description?.trim();

  try {
    // `exactOptionalPropertyTypes`: la clave se omite en vez de enviarse como
    // `undefined`, que el tipo del payload no admite.
    const payload = {
      name: name.trim(),
      htmlContent,
      ...(trimmedDescription ? { description: trimmedDescription } : {}),
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
      <q-card-section class="row items-center no-wrap q-gutter-sm pd-editor-header">
        <span class="pd-icon-circle">
          <q-icon name="description" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar plantilla' : 'Nueva plantilla' }}</div>
      </q-card-section>

      <q-form class="pd-editor-form" @submit.prevent="onSubmit">
        <div class="row q-col-gutter-md pd-editor-columns">
          <!-- Columna izquierda: metadatos y Poka-Yoke de variables -->
          <div class="col-12 col-md-4 q-pr-sm pd-editor-side">
            <div class="q-mb-md">
              <label class="pd-label" for="template-name">
                Nombre<span class="pd-required">*</span>
              </label>
              <q-input
                id="template-name"
                v-model="templatesStore.activeDraft.name"
                outlined
                dense
                class="q-mt-xs"
                maxlength="120"
                placeholder="noticia-basica"
                :rules="[(val: string) => !!val.trim() || 'El nombre es obligatorio']"
              />
            </div>

            <div class="q-mb-md">
              <label class="pd-label" for="template-description">Descripcion</label>
              <q-input
                id="template-description"
                v-model="templatesStore.activeDraft.description"
                outlined
                dense
                class="q-mt-xs"
                maxlength="255"
                placeholder="Cuerpo de noticia con titular y resumen"
              />
            </div>

            <!-- Chips Poka-Yoke: el namespace se elige, no se teclea -->
            <div class="q-mb-md">
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
              <div class="pd-label">Variables detectadas</div>
              <p class="pd-subtitle q-mt-xs q-mb-sm">
                Lo que el backend guardara en <span class="pd-mono">requiredVariables</span>.
              </p>
              <div v-if="templatesStore.detectedVariables.length > 0" class="pd-chip-bar">
                <q-chip
                  v-for="variable in templatesStore.detectedVariables"
                  :key="variable"
                  dense
                  class="pd-detected-chip pd-mono"
                  :label="variable"
                />
              </div>
              <p v-else class="pd-subtitle">Ninguna todavia.</p>
            </div>

            <q-separator class="q-my-md pd-editor-separator" />

            <!-- Las acciones viven en esta columna, no en un q-card-actions al
                 pie de la tarjeta: alli se superponian sobre las ultimas lineas
                 del editor, que ocupa toda la altura de la columna derecha. -->
            <div>
              <div class="pd-label">Acciones de la Plantilla</div>

              <p class="pd-subtitle q-mt-xs q-mb-none">
                Solo se permite sustitucion determinista de variables (<span class="pd-mono">{{
                  VARIABLE_SYNTAX_EXAMPLE
                }}</span
                >). Quedan prohibidos bloques (<span class="pd-mono">{{
                  FORBIDDEN_BLOCK_EXAMPLE
                }}</span
                >), parciales y escapes triples (<span class="pd-mono">{{
                  FORBIDDEN_TRIPLE_STASH_EXAMPLE
                }}</span
                >).
              </p>

              <div class="row q-gutter-sm q-mt-sm">
                <q-btn
                  flat
                  no-caps
                  label="Cancelar"
                  class="pd-btn-secondary"
                  @click="closeDialog"
                />
                <q-btn
                  unelevated
                  no-caps
                  label="Guardar Plantilla"
                  icon-right="north_east"
                  type="submit"
                  class="pd-btn-primary"
                  :disable="!templatesStore.isDraftValid"
                  :loading="templatesStore.isLoading"
                />
              </div>
            </div>
          </div>

          <!-- Columna derecha: editor de codigo -->
          <div class="col-12 col-md-8 pd-editor-main">
            <div class="row items-center justify-between q-mb-xs">
              <span class="pd-label"> Contenido HTML<span class="pd-required">*</span> </span>
              <span class="pd-mono pd-editor-badge">Editor HTML Handlebars</span>
            </div>

            <TemplateCodeEditor
              ref="codeEditorRef"
              :model-value="templatesStore.activeDraft.htmlContent"
              @update:model-value="templatesStore.updateHtmlContent"
              @cursor-change="templatesStore.setCursorPosition"
            />
          </div>
        </div>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
// Modal ancho: la autoria de HTML necesita sitio. Sobrescribe el min-width de
// 380px que impone .pd-dialog-card.
.pd-editor-card {
  display: flex;
  flex-direction: column;
  width: 92vw;
  max-width: 1400px;
  height: 85vh;
  max-height: 900px;
  min-width: 0;
}

// Cadena flex: la cabecera a tamano natural, el cuerpo se queda todo el resto.
//
// `min-height: 0` en CADA eslabon es lo que decide si esto funciona: un item
// flex tiene `min-height: auto` y se niega a encogerse por debajo de su
// contenido, asi que sin esto el editor empujaria el modal mas alla del 85vh en
// vez de hacer scroll interno.
.pd-editor-header {
  flex: 0 0 auto;
}

// El padding inferior lo pone ahora el formulario: ya no hay un q-card-actions
// al pie de la tarjeta que lo aportara.
.pd-editor-form {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 16px 16px;
}

.pd-editor-columns {
  flex: 1 1 auto;
  min-height: 0;
}

// La columna de configuracion scrollea por su cuenta, sin arrastrar al editor.
.pd-editor-side {
  overflow-y: auto;
  max-height: 100%;
}

// `overflow: hidden` es la guarda real contra el solape: sin el, un documento
// largo desborda la columna y CodeMirror se pinta por encima de lo que haya
// debajo, en vez de hacer scroll dentro de su propia caja.
.pd-editor-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

// El editor ocupa todo el hueco que deja la cabecera del panel.
.pd-editor-main > .pd-code-editor,
.pd-editor-main :deep(.pd-code-editor) {
  flex: 1 1 auto;
  min-height: 0;
}

// QSeparator trae su propio color; se fuerza al token del sistema.
.pd-editor-separator {
  background: var(--pd-border);
}

.pd-editor-badge {
  color: var(--pd-text-secondary);
  font-size: 11.5px;
}

.pd-dialog-icon {
  color: var(--pd-primary);
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

// Detectadas: mismo lenguaje visual que el chip del editor, para que se lean
// como lo mismo en dos sitios distintos.
.pd-detected-chip {
  background: var(--pd-accent-soft);
  color: var(--pd-accent);
  border: 1px solid var(--pd-accent);
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
