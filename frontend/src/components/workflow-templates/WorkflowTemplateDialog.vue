<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import NodeSequenceBuilder from '@components/workflow-templates/NodeSequenceBuilder.vue';
import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';

import { extractApiErrorMessage, extractApiIssues } from '@/utils/api-error';

import type { SchemaIssue, WorkflowTemplateSummary } from '@/types/pipeline';

// CodeMirror pesa unos cientos de KB y este dialogo no siempre se abre; en
// diferido solo se descarga cuando el operador entra a editar.
const JsonPipelinePreview = defineAsyncComponent(
  () => import('@components/JsonPipelinePreview.vue'),
);

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
 * Campos que el backend rechazo en la ultima validacion.
 *
 * Estado LOCAL del dialogo y no del store: es feedback de una accion puntual del
 * operador sobre este formulario, no dato compartido. La regla de desempate de
 * `frontend-architecture.md` §2.1 lo pone aqui —muere con el dialogo.
 */
const validationIssues = ref<SchemaIssue[]>([]);
const isValidating = ref(false);

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

    // Los errores describen el grafo de la apertura anterior; conservarlos
    // subrayaria posiciones de un documento que ya no esta en pantalla.
    validationIssues.value = [];

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

/**
 * Valida el grafo contra el motor SIN guardarlo.
 *
 * El backend es la unica autoridad sobre la topologia: `schemaSyntaxError` del
 * store solo sabe si el texto parsea, no si el grafo tiene ciclos, punteros
 * huerfanos o namespaces duplicados.
 */
const onValidateSchema = async (): Promise<void> => {
  const syntaxError = templatesStore.schemaSyntaxError;

  // Un JSON que no parsea no se puede enviar; el 400 seria seguro y el mensaje
  // del servidor menos util que el del propio motor de JS.
  if (syntaxError !== null) {
    $q.notify({ type: 'negative', message: `JSON invalido: ${syntaxError}` });
    return;
  }

  isValidating.value = true;

  try {
    await templatesStore.validateDraftSchema();

    validationIssues.value = [];
    $q.notify({ type: 'positive', message: 'El esquema es integro.' });
  } catch (error) {
    const issues = extractApiIssues(error);

    validationIssues.value = issues;

    $q.notify({
      type: 'negative',
      message:
        issues.length > 0
          ? `El esquema tiene ${issues.length} error(es); revisa el editor.`
          : extractApiErrorMessage(error, 'No se pudo validar el esquema'),
    });
  } finally {
    isValidating.value = false;
  }
};

const onSubmit = async (): Promise<void> => {
  try {
    await templatesStore.saveDraft();
    emit('saved');
    emit('update:modelValue', false);
  } catch (error) {
    // El guardado tambien valida en el servidor, asi que sus `issues` sirven
    // igual para iluminar el editor.
    validationIssues.value = extractApiIssues(error);

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
      <q-card-section class="pd-template-header">
        <div class="pd-h2">
          {{ isEditing ? 'Editar plantilla de flujo' : 'Nueva plantilla de flujo' }}
        </div>
        <p class="pd-subtitle q-mt-xs q-mb-none">
          La topologia base de la que partiran los flujos. El servidor valida el grafo completo
          —forma, tipos e integridad— antes de guardarlo.
        </p>
      </q-card-section>

      <q-form class="pd-template-form" @submit.prevent="onSubmit">
        <div class="row q-col-gutter-md pd-template-columns">
          <!-- Columna izquierda: metadatos -->
          <div class="col-12 col-md-4 pd-template-side q-gutter-md">
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
                type="textarea"
                rows="3"
                placeholder="Que hace esta topologia y cuando conviene partir de ella"
                @update:model-value="
                  templatesStore.patchDraft({ description: String($event ?? '') })
                "
              />
            </div>

            <!-- Ensamblador de la topologia. Escribe sobre `schemaText` en una
                 sola direccion: el editor JSON de la derecha sigue siendo
                 editable a mano, pero tocar el selector reescribe el grafo. -->
            <NodeSequenceBuilder
              :model-value="templatesStore.sequence"
              @update:model-value="templatesStore.setSequence($event)"
              @update:params="templatesStore.patchStepParams"
            />

            <!-- Estado SOLO informativo, como en `UserDialog.vue`: el estado se
                 conmuta unicamente desde la tabla, con su confirmacion. -->
            <div v-if="isEditing" class="row items-center q-gutter-sm">
              <q-badge
                class="pd-badge"
                :class="
                  templatesStore.activeDraft.active ? 'pd-badge--active' : 'pd-badge--inactive'
                "
              >
                {{ templatesStore.activeDraft.active ? 'Activo' : 'Inactivo' }}
              </q-badge>
              <span class="pd-subtitle">
                El estado se cambia desde el catalogo, con la confirmacion correspondiente.
              </span>
            </div>

            <!-- Resumen de los errores del servidor. El editor los subraya, pero
                 una ruta puede quedar fuera de la parte visible del documento. -->
            <div
              v-if="validationIssues.length > 0"
              class="pd-card pd-card--accent pd-accent-urgente q-pa-md"
              role="alert"
            >
              <div class="pd-label q-mb-xs">Errores del esquema</div>
              <ul class="pd-issue-list">
                <li v-for="(issue, index) in validationIssues" :key="`${issue.path}-${index}`">
                  <span class="pd-mono">{{ issue.path }}</span>
                  <span class="pd-subtitle">{{ issue.message }}</span>
                </li>
              </ul>
            </div>
          </div>

          <!-- Columna derecha: editor del grafo -->
          <div class="col-12 col-md-8 pd-template-main">
            <div class="row items-center justify-between q-mb-xs">
              <span class="pd-label">
                Topologia (pipeline_schema)<span class="pd-required">*</span>
              </span>
              <div class="row items-center q-gutter-xs">
                <span
                  v-if="templatesStore.schemaSyntaxError !== null"
                  class="pd-mono pd-syntax-error"
                >
                  {{ templatesStore.schemaSyntaxError }}
                </span>
                <q-btn
                  flat
                  dense
                  no-caps
                  size="sm"
                  color="primary"
                  icon="rule"
                  label="Validar"
                  :loading="isValidating"
                  @click="onValidateSchema"
                >
                  <q-tooltip>Comprobar el grafo contra el motor, sin guardar</q-tooltip>
                </q-btn>
              </div>
            </div>

            <JsonPipelinePreview
              :model-value="templatesStore.activeDraft.schemaText"
              :validation-errors="validationIssues"
              :readonly="false"
              @update:model-value="templatesStore.patchDraft({ schemaText: $event })"
            />
          </div>
        </div>

        <q-card-actions align="right" class="q-px-md q-pb-md pd-template-actions">
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
// Cadena flex: cabecera y acciones a tamano natural, el cuerpo se queda el resto.
//
// `min-height: 0` en CADA eslabon es lo que decide si esto funciona: un item
// flex tiene `min-height: auto` y se niega a encogerse por debajo de su
// contenido, asi que sin esto el editor empujaria el modal mas alla del 85vh en
// vez de hacer scroll interno.
.pd-template-dialog {
  display: flex;
  flex-direction: column;
  width: 92vw;
  max-width: 1400px;
  height: 85vh;
  max-height: 900px;
  min-width: 0;
}

.pd-template-header {
  flex: 0 0 auto;
}

.pd-template-form {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0 16px 0;
}

.pd-template-columns {
  flex: 1 1 auto;
  min-height: 0;
}

// La columna de metadatos scrollea por su cuenta, sin arrastrar al editor.
.pd-template-side {
  overflow-y: auto;
  max-height: 100%;
}

// `overflow: hidden` es la guarda real contra el solape: sin el, un grafo largo
// desborda la columna y CodeMirror se pinta por encima de lo que haya debajo,
// en vez de hacer scroll dentro de su propia caja.
.pd-template-main {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.pd-template-main > .pd-json-preview,
.pd-template-main :deep(.pd-json-preview) {
  flex: 1 1 auto;
  min-height: 0;
}

.pd-template-actions {
  flex: 0 0 auto;
}

.pd-syntax-error {
  color: var(--pd-negative);
  font-size: 11.5px;
}

.pd-issue-list {
  margin: 0;
  padding-left: 18px;

  li {
    margin-bottom: 6px;
  }

  .pd-mono {
    display: block;
    color: var(--pd-negative);
  }
}

// Los inputs consumen los tokens de superficie y borde (regla §2).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);

  &::before {
    border-color: var(--pd-border);
  }
}
</style>
