<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useTemplatesStore } from '@stores/templates.store';

import { extractApiErrorMessage, extractApiViolations } from '@/utils/api-error';

import type { HtmlTemplate, TemplateViolation } from '@/types/html-template';

// CodeMirror pesa unos cientos de KB y este dialogo lo importan dos componentes
// distintos; en diferido solo se descarga al abrir el editor.
const TemplateCodeEditor = defineAsyncComponent(
  () => import('@components/templates/TemplateCodeEditor.vue'),
);

/** Contrato imperativo que `TemplateCodeEditor` expone con `defineExpose`. */
interface TemplateCodeEditorInstance {
  insertTextAtCursor: (text: string, cursorOffset?: number) => void;
  setViolations: (violations: TemplateViolation[]) => void;
  formatDocument: () => void;
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

/**
 * Como se estructura hoy una plantilla de este gestor.
 *
 * El MAPEADOR_PLANTILLA dejo de interpolar: entrega el esqueleto saneado para
 * que lo rellene un PROCESADOR_IA posterior, y rechaza con
 * ERR_TEMPLATE_PENDING_VARS cualquier plantilla cuyas `variables_esperadas` no
 * vengan vacias. Un hueco a rellenar solo es expresable como POSICION del DOM,
 * de ahi que se nombre por clase y se deje vacio. Esas mismas clases son las
 * que el ESCUDO_POST_IA autodetecta despues para proponer sus
 * `requiredSelectors`.
 */
const STRUCTURE_NOTICE =
  'Las plantillas para MAPEADOR_PLANTILLA deben estructurarse mediante selectores CSS vacios (ej. <span class="campo"></span>). No utilice marcadores Handlebars: el motor los rechaza con ERR_TEMPLATE_PENDING_VARS.';

// `InstanceType<typeof ...>` no resuelve a traves de defineAsyncComponent, de
// ahi la interfaz explicita.
const codeEditorRef = ref<TemplateCodeEditorInstance | null>(null);

const isEditMode = computed(() => !!props.template);

watch(
  () => props.modelValue,
  (isOpen) => {
    // El borrador se inicializa AL ABRIR, no al montar: el dialogo permanece en
    // el arbol cerrado, y `props.template` cambia entre un alta y una edicion.
    if (!isOpen) return;

    templatesStore.initDraft(props.template ?? undefined);
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

/**
 * Reindenta el HTML del editor.
 *
 * Delega en el editor por el mismo motivo que `handleInsertToken`: CodeMirror es
 * el dueno del documento y del historial, asi que el formateo tiene que
 * despacharse como una transaccion suya. Sin red hacia el store, a diferencia
 * de la insercion: no hay nada que formatear hasta que el editor este montado y
 * visible.
 */
const formatHtmlCode = (): void => codeEditorRef.value?.formatDocument();

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
    // Diagnostico visual (Poka-Yoke): el backend no solo dice que algo sobra,
    // dice QUE construccion es. El editor la subraya para que el autor no tenga
    // que buscarla a ojo en un documento largo.
    const violations = extractApiViolations(error);

    codeEditorRef.value?.setViolations(violations);

    // El mensaje generico SOLO sustituye al del backend cuando hay algo
    // subrayado. En los demas 400 —nombre duplicado, namespace concreto— el
    // texto del backend es mas util que cualquier frase fija.
    $q.notify({
      type: 'negative',
      message:
        violations.length > 0
          ? 'La plantilla contiene marcado no permitido. Revise las lineas resaltadas en el editor.'
          : extractApiErrorMessage(error, 'No se pudo guardar la plantilla'),
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

            <!-- Las plantillas de este gestor alimentan al MAPEADOR_PLANTILLA,
                 que YA NO interpola: entrega el esqueleto saneado para que lo
                 rellene un PROCESADOR_IA posterior. Ofrecer aqui un insertador
                 de marcadores seria invitar a escribir plantillas que el nodo
                 rechaza en ejecucion, con el flujo ya PAUSADO. -->
            <q-banner dense class="pd-structure-banner q-mb-md" data-test="structure-notice">
              <template #avatar>
                <q-icon name="info_outline" size="20px" class="pd-banner-icon" />
              </template>
              {{ STRUCTURE_NOTICE }}
            </q-banner>

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
                En las plantillas heredadas que aun interpolan, solo se admite sustitucion
                determinista de variables (<span class="pd-mono">{{ VARIABLE_SYNTAX_EXAMPLE }}</span
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
              <div class="row items-center q-gutter-xs">
                <span class="pd-mono pd-editor-badge">Editor HTML Handlebars</span>
                <q-btn
                  flat
                  dense
                  round
                  size="sm"
                  icon="auto_fix_high"
                  color="primary"
                  aria-label="Formatear HTML"
                  @click="formatHtmlCode"
                >
                  <q-tooltip>Formatear HTML</q-tooltip>
                </q-btn>
              </div>
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
// Solo maquetacion: el color proviene de los tokens --pd-*.
.pd-structure-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-banner-icon {
  color: var(--pd-accent);
}

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

// Tarjeta del marcador compuesto: lo que se va a insertar, antes de insertarlo.
.pd-token-card {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;
  padding: 10px 12px;
}

.pd-token-value {
  color: var(--pd-accent-text);
  word-break: break-all;
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
