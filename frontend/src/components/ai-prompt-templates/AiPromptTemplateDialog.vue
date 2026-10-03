<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';
import { useNodeCatalogStore } from '@stores/node-catalog.store';
import VariableExplorer from '@components/shared/VariableExplorer.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import {
  CODE_PATTERN,
  MAX_CODE_LENGTH,
  deriveCodeFromName,
  sanitizeCodeInput,
} from '@/utils/prompt-code';
import { buildPromptContextFromCatalog, filterPromptContext } from '@/utils/prompt-namespaces';

import type { AiPromptTemplateDetail } from '@/types/ai-prompt-template';
import type { QInput } from 'quasar';
import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

/** Replican los limites de `plantillas_prompts_ia` y del DTO del backend. */
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

/** Contrato imperativo de `VariableExplorer`. */
interface VariableExplorerInstance {
  reset: () => void;
}

interface Props {
  modelValue: boolean;
  /** Plantilla a editar, con su instruccion ya cargada; `null` para un alta. */
  prompt: AiPromptTemplateDetail | null;
  /**
   * Escenario B: lo que publican los nodos ANTERIORES al de IA en el flujo.
   *
   * OPCIONAL, y su ausencia no es un caso degradado: el gestor de plantillas
   * abre este mismo dialogo sin ningun flujo detras, y entonces cae al catalogo
   * global (Escenario A). La prop MANDA cuando viene con algo, porque un flujo
   * concreto sabe que namespaces publica de verdad y con que campos.
   *
   * La pasa `LlmExtractorConfig.vue` al abrir este dialogo desde el paso de IA
   * del asistente, con los namespaces que publican los nodos anteriores de ESE
   * flujo.
   */
  upstreamContext?: readonly UpstreamNamespace[];
}

const props = withDefaults(defineProps<Props>(), { upstreamContext: () => [] });

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  /**
   * La plantilla guardada, con su `promptText`.
   *
   * Viaja con CARGA, igual que en `TemplateEditorDialog`: quien abre este
   * dialogo desde el configurador de un nodo necesita seleccionar lo que acaba
   * de crear, y sin el identificador tendria que adivinarlo diffeando el
   * listado. El gestor de plantillas simplemente ignora el argumento.
   */
  saved: [prompt: AiPromptTemplateDetail];
}>();

const $q = useQuasar();
const aiPromptTemplatesStore = useAiPromptTemplatesStore();
const nodeCatalogStore = useNodeCatalogStore();

const promptTextRef = ref<QInput | null>(null);
const variableExplorerRef = ref<VariableExplorerInstance | null>(null);

const form = reactive<{
  code: string;
  name: string;
  description: string;
  promptText: string;
}>({
  code: '',
  name: '',
  description: '',
  promptText: '',
});

/**
 * ¿Ha tocado el operador el codigo a mano?
 *
 * Mientras valga `false`, el codigo sigue al nombre. En cuanto se teclea en el
 * campo deja de seguirlo para siempre (hasta cerrar el dialogo): sobrescribir
 * lo que alguien acaba de escribir es la peor clase de ayuda.
 */
const isCodeTouched = ref(false);

const isEditMode = computed(() => !!props.prompt);

/**
 * Enlace saneado del campo de codigo.
 *
 * Es un `computed` con setter y no un `@update:model-value` junto al `v-model`:
 * eso serian dos escrituras sobre la misma propiedad, y el valor que entrega
 * `QInput` llega tipado `string | number | null`, que en modo estricto no
 * admite `.toUpperCase()` sin mas.
 */
const codeInput = computed<string>({
  get: () => form.code,
  set: (value: string) => {
    isCodeTouched.value = true;
    form.code = sanitizeCodeInput(value);
  },
});

// El codigo sigue al nombre mientras nadie lo haya tocado. Solo en el alta: en
// la edicion es inmutable y el servicio lo ignora, asi que moverlo seria
// ensenar algo que no se va a guardar.
watch(
  () => form.name,
  (name) => {
    if (isCodeTouched.value || isEditMode.value) return;

    form.code = deriveCodeFromName(name);
  },
);

const resetForm = (): void => {
  form.code = props.prompt?.code ?? '';
  isCodeTouched.value = false;
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
    if (!isOpen) return;

    resetForm();
    variableExplorerRef.value?.reset();

    // Al abrir y no en `onMounted`: montado esta desde que se pinta el gestor, y
    // ahi no hay nadie mirando el explorador. La llamada esta memoizada, asi que
    // si el asistente ya cargo el catalogo no cuesta una peticion.
    void nodeCatalogStore.fetchCatalog();
  },
);

/**
 * Origenes que el explorador puede ofrecer.
 *
 * Con flujo detras (Escenario B) manda la prop, ya filtrada; sin el
 * (Escenario A) se cae al catalogo global. Ambas ramas pasan por el mismo filtro
 * Poka-Yoke, que es lo que garantiza que un destino o el propio `llm_response`
 * no se cuelen por ninguna de las dos.
 */
const variableContext = computed<readonly UpstreamNamespace[]>(() =>
  props.upstreamContext.length > 0
    ? filterPromptContext(props.upstreamContext)
    : buildPromptContextFromCatalog(nodeCatalogStore.entries),
);

/**
 * Inserta el marcador en la posicion del cursor del textarea.
 *
 * Se escribe a mano porque aqui NO hay CodeMirror: el prompt se edita en un
 * `q-input type="textarea"`, asi que no existe un `insertTextAtCursor` que
 * despachar. Se lee el caret real del elemento nativo —y no un espejo en el
 * store, como hace el fallback de `templates.store`— porque el textarea es el
 * unico que lo conoce.
 *
 * `selectionStart`/`selectionEnd` cubren tambien el caso de que haya texto
 * seleccionado: el marcador lo REEMPLAZA, que es lo que espera cualquiera que
 * seleccione algo antes de pulsar Insertar.
 *
 * El caret se recoloca en un `setTimeout` de 0: Vue todavia no ha propagado el
 * `v-model` al DOM cuando esta funcion termina, y fijar la posicion antes la
 * perderia al repintar.
 */
const handleInsertToken = (token: string): void => {
  const input = promptTextRef.value?.nativeEl as HTMLTextAreaElement | undefined;

  if (!input) {
    // Sin referencia al textarea no hay cursor que respetar; se anade al final
    // en vez de descartar la insercion.
    form.promptText = `${form.promptText}${token}`;
    return;
  }

  const start = input.selectionStart ?? form.promptText.length;
  const end = input.selectionEnd ?? start;

  form.promptText = `${form.promptText.slice(0, start)}${token}${form.promptText.slice(end)}`;

  const caret = start + token.length;

  setTimeout(() => {
    input.focus();
    input.setSelectionRange(caret, caret);
  }, 0);
};

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = async (): Promise<void> => {
  // Una descripcion vaciada se envia como cadena vacia y no se omite: omitirla
  // dejaria la anterior intacta, que es lo contrario de lo que pidio el usuario.
  const description = form.description.trim();
  const code = form.code.trim();

  try {
    const saved =
      isEditMode.value && props.prompt
        ? await aiPromptTemplatesStore.updatePrompt(props.prompt.id, {
            name: form.name.trim(),
            description,
            promptText: form.promptText,
          })
        : await aiPromptTemplatesStore.createPrompt({
            name: form.name.trim(),
            description,
            promptText: form.promptText,
            // Un codigo vacio se OMITE en vez de enviarse: `@IsOptional` del
            // backend salta con `undefined`, pero una cadena vacia llegaria al
            // `@Matches` y daria 400. Omitido, lo deriva el servicio.
            ...(code.length > 0 && { code }),
          });

    emit('saved', saved);
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
            <label class="pd-label" for="prompt-code">Codigo identificador</label>
            <q-input
              id="prompt-code"
              v-model="codeInput"
              outlined
              dense
              class="q-mt-xs pd-mono"
              placeholder="NOTIWEB_DEFAULT"
              :maxlength="MAX_CODE_LENGTH"
              :disable="isEditMode"
              :hint="
                isEditMode
                  ? 'Inmutable: identifica esta plantilla en los flujos ya guardados'
                  : 'Lo que escribiras en promptCode del nodo de IA. Vacio, se deriva del nombre'
              "
              :rules="[
                (val: string) =>
                  !val || CODE_PATTERN.test(val) || 'Solo mayusculas, digitos y guion bajo',
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
              ref="promptTextRef"
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
            <p class="pd-subtitle q-mt-xs q-mb-sm">
              Admite marcadores <span class="pd-mono">{{ MARKER_EXAMPLE }}</span
              >, que el motor resuelve contra el contexto en tiempo de ejecucion.
            </p>

            <!-- Explorador determinista: el mismo que el editor de plantillas
                 HTML. Los origenes llegan ya filtrados, sin destinos ni la
                 propia salida de la IA. -->
            <VariableExplorer
              ref="variableExplorerRef"
              :context="variableContext"
              insert-label="Insertar en el prompt"
              @insert="handleInsertToken"
            />
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
            :loading="aiPromptTemplatesStore.isLoading"
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
