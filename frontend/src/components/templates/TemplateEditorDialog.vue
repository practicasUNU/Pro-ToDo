<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

import { useNodeCatalogStore } from '@stores/node-catalog.store';
import { useTemplatesStore } from '@stores/templates.store';

import { extractApiErrorMessage, extractApiViolations } from '@/utils/api-error';
import { buildContextForNamespaces } from '@/utils/upstream-catalog';

import {
  TEMPLATE_NAMESPACES,
  type HtmlTemplate,
  type TemplateViolation,
} from '@/types/html-template';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { NodeOutputField } from '@/types/node-catalog';

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
  /**
   * Namespaces del flujo desde el que se abre el dialogo, con sus campos.
   *
   * OPCIONAL, y su ausencia no es un caso degradado: el gestor de plantillas
   * abre este mismo dialogo sin ningun flujo detras, y ahi no hay topologia que
   * consultar. Con contexto, el explorador ofrece lo que ESE flujo publica de
   * verdad; sin el, cae al catalogo global (ver `variableContext`).
   */
  upstreamContext?: readonly UpstreamNamespace[];
}

const props = withDefaults(defineProps<Props>(), { upstreamContext: () => [] });

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [template: HtmlTemplate];
}>();

const $q = useQuasar();
const templatesStore = useTemplatesStore();
// El catalogo es estado compartido y este componente lo consume de su store, no
// de un servicio: la frontera HTTP sigue siendo `node-catalog.service.ts`.
const nodeCatalogStore = useNodeCatalogStore();

// Los ejemplos con llaves viven aqui y no en la plantilla: el compilador de Vue
// no sabe distinguir unas llaves literales de una interpolacion anidada.
const VARIABLE_SYNTAX_EXAMPLE = '{{namespace.campo}}';
const FORBIDDEN_BLOCK_EXAMPLE = '{{#if}}';
const FORBIDDEN_TRIPLE_STASH_EXAMPLE = '{{{}}}';

// `InstanceType<typeof ...>` no resuelve a traves de defineAsyncComponent, de
// ahi la interfaz explicita.
const codeEditorRef = ref<TemplateCodeEditorInstance | null>(null);

// Seleccion del explorador de variables. Se declara antes del `watch` de
// apertura porque ese lo lee: en `<script setup>` el orden de declaracion es el
// de ejecucion.
const selectedNamespace = ref<string | null>(null);
const selectedField = ref<NodeOutputField | null>(null);

const isEditMode = computed(() => !!props.template);

watch(
  () => props.modelValue,
  (isOpen) => {
    // El borrador se inicializa AL ABRIR, no al montar: el dialogo permanece en
    // el arbol cerrado, y `props.template` cambia entre un alta y una edicion.
    if (!isOpen) return;

    templatesStore.initDraft(props.template ?? undefined);
    selectedNamespace.value = null;
    selectedField.value = null;

    // Tambien al abrir y no en `onMounted`, por lo mismo: montado esta desde que
    // se pinta el gestor, y ahi no hay nadie mirando el explorador. La llamada
    // es memoizada, asi que si el asistente ya cargo el catalogo no cuesta una
    // peticion.
    void nodeCatalogStore.fetchCatalog();
  },
);

/**
 * De donde salen los origenes que el explorador ofrece.
 *
 * La prop MANDA cuando viene con algo, porque es la respuesta mas especifica:
 * un flujo concreto sabe que namespaces publica de verdad y con que campos. El
 * catalogo global solo sabe que publicaria cada tipo de nodo SI alguien lo
 * colocara, que es exactamente lo que necesita el gestor de plantillas —donde no
 * hay flujo y la plantilla debe poder escribirse para cualquiera.
 */
const variableContext = computed<readonly UpstreamNamespace[]>(() =>
  props.upstreamContext.length > 0
    ? props.upstreamContext
    : buildContextForNamespaces(TEMPLATE_NAMESPACES, nodeCatalogStore.findByCode),
);

/** Paso 1 del explorador. El `nodeType` va en la etiqueta, no en el valor. */
const namespaceOptions = computed(() =>
  variableContext.value.map(({ namespace, nodeType }) => ({
    label: nodeType === undefined ? namespace : `${namespace} (${nodeType})`,
    value: namespace,
  })),
);

/**
 * Paso 2: campos del origen elegido.
 *
 * Vacio mientras no haya origen, y tambien cuando el origen no declara campos
 * —un tipo sin `outputFields`, o el catalogo aun viajando—. El selector queda
 * entonces sin opciones, que es honesto: no hay nada que ofrecer todavia.
 */
const availableFields = computed<readonly NodeOutputField[]>(
  () =>
    variableContext.value.find(({ namespace }) => namespace === selectedNamespace.value)?.fields ??
    [],
);

/** Marcador resultante, o cadena vacia mientras la eleccion este incompleta. */
const interpolatedToken = computed<string>(() =>
  selectedNamespace.value !== null && selectedField.value !== null
    ? `{{${selectedNamespace.value}.${selectedField.value.name}}}`
    : '',
);

// Cambiar de origen invalida el campo: pertenecia al anterior, y dejarlo
// compondria un marcador que mezcla dos namespaces.
watch(selectedNamespace, () => {
  selectedField.value = null;
});

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

/** Copia el marcador al portapapeles, para pegarlo donde el autor decida. */
const handleCopyToken = async (): Promise<void> => {
  if (interpolatedToken.value === '') return;

  try {
    await copyToClipboard(interpolatedToken.value);
    $q.notify({ type: 'positive', message: 'Marcador copiado al portapapeles' });
  } catch {
    // El portapapeles exige contexto seguro y permiso del navegador. Si lo
    // niega, el marcador sigue a la vista en la tarjeta: se copia a mano.
    $q.notify({
      type: 'warning',
      message: `Copia manualmente: ${interpolatedToken.value}`,
    });
  }
};

/**
 * Inserta el marcador completo en el cursor del editor (Poka-Yoke).
 *
 * Se despacha sobre el EDITOR y no sobre el store porque CodeMirror es el dueno
 * del cursor y del historial: `insertTextAtCursor` reemplaza el rango de
 * `view.state.selection.main` —que sobrevive a perder el foco, asi que el clic
 * en el boton no lo pierde— y el store se sincroniza solo por
 * `update:modelValue`. Escribir tambien en el store insertaria el texto dos
 * veces.
 *
 * Offset `0`: el marcador esta completo y el caret debe quedar DETRAS. La
 * version anterior insertaba `{{ns.}}` y retrocedia dos posiciones para que el
 * autor escribiera el campo — que es justo la errata que el explorador elimina.
 */
const handleInsertToken = (): void => {
  if (interpolatedToken.value === '') return;

  if (codeEditorRef.value) {
    codeEditorRef.value.insertTextAtCursor(interpolatedToken.value, 0);
    return;
  }

  // Red por si el editor aun no ha resuelto su carga diferida.
  templatesStore.insertTextAtCursor(interpolatedToken.value);
};

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

            <!-- Explorador Poka-Yoke: origen y campo se eligen, no se teclean -->
            <div class="q-mb-md" data-test="variable-explorer">
              <div class="pd-label">Variables disponibles</div>
              <p class="pd-subtitle q-mt-xs q-mb-sm">
                Elige el origen y el campo. El marcador se compone solo.
              </p>

              <div data-test="namespace-field">
                <q-select
                  v-model="selectedNamespace"
                  :options="namespaceOptions"
                  label="1. Selecciona Origen / Namespace"
                  dense
                  outlined
                  emit-value
                  map-options
                  class="q-mb-sm"
                />
              </div>

              <div data-test="variable-field">
                <q-select
                  v-model="selectedField"
                  :options="availableFields"
                  option-label="name"
                  label="2. Campo a inyectar"
                  dense
                  outlined
                  :disable="selectedNamespace === null"
                />
              </div>

              <div v-if="selectedField" class="pd-token-card q-mt-sm" data-test="token-detail">
                <div class="pd-mono pd-token-value">{{ interpolatedToken }}</div>
                <div class="row items-center q-gutter-xs q-mt-xs">
                  <span class="pd-badge pd-badge--role">{{ selectedField.type }}</span>
                  <span v-if="selectedField.description" class="col pd-subtitle q-mb-none">
                    {{ selectedField.description }}
                  </span>
                </div>
              </div>

              <div class="row q-gutter-sm q-mt-sm">
                <q-btn
                  icon="content_copy"
                  label="Copiar"
                  outline
                  no-caps
                  dense
                  class="pd-btn-secondary"
                  data-test="copy-token"
                  :disable="!interpolatedToken"
                  @click="handleCopyToken"
                />
                <q-btn
                  icon="add"
                  label="Insertar en plantilla"
                  no-caps
                  dense
                  class="pd-btn-primary"
                  data-test="insert-token"
                  :disable="!interpolatedToken"
                  @click="handleInsertToken"
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
