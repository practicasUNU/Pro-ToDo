<script setup lang="ts">
import { computed, defineAsyncComponent, reactive, ref, watch } from 'vue';
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
import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

// CodeMirror pesa unos cientos de KB y este dialogo se monta con el gestor de
// prompts aunque nadie lo abra; en diferido solo se descarga al editar.
const PromptCodeEditor = defineAsyncComponent(
  () => import('@components/shared/PromptCodeEditor.vue'),
);

/** Contrato imperativo que `PromptCodeEditor` expone con `defineExpose`. */
interface PromptCodeEditorInstance {
  insertTextAtCursor: (text: string) => void;
}

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

// `InstanceType<typeof ...>` no resuelve a traves de `defineAsyncComponent`,
// de ahi la interfaz explicita.
const promptEditorRef = ref<PromptCodeEditorInstance | null>(null);
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
 * Inserta el marcador en el cursor del editor (Poka-Yoke).
 *
 * Se despacha sobre el EDITOR y no sobre `form.promptText`, igual que en el
 * dialogo de plantillas: CodeMirror es el dueno del cursor y del historial, y
 * el formulario se sincroniza solo por `update:modelValue`. Escribir tambien
 * aqui insertaria el texto dos veces.
 *
 * La version anterior manipulaba `selectionStart` del textarea nativo y
 * recolocaba el caret en un `setTimeout(0)` porque Vue aun no habia propagado
 * el `v-model`. Nada de eso hace falta con una transaccion.
 */
const handleInsertToken = (token: string): void => {
  if (promptEditorRef.value) {
    promptEditorRef.value.insertTextAtCursor(token);
    return;
  }

  // Red por si el editor aun no ha resuelto su carga diferida: se anade al
  // final en vez de descartar la insercion.
  form.promptText = `${form.promptText}${token}`;
};

/**
 * El formulario esta completo y se puede enviar.
 *
 * Sustituye al `:rules` que llevaba el `<q-input type="textarea">` de la
 * instruccion: `QForm` valida recorriendo las reglas de sus hijos, y el editor
 * de codigo no es un campo de Quasar, de modo que sin esto un prompt vacio
 * llegaria al backend y volveria como 400. Se bloquea el boton ademas de
 * pintar el mensaje: el aviso explica, el bloqueo impide.
 */
const isFormValid = computed<boolean>(
  () =>
    form.name.trim() !== '' &&
    form.name.length <= MAX_NAME_LENGTH &&
    form.description.length <= MAX_DESCRIPTION_LENGTH &&
    form.promptText.trim() !== '',
);

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

          <!-- Mismo editor de codigo que las plantillas HTML, sin la gramatica
               de marcado: el texto lleva marcadores {{nodo.campo}} y resaltarlos
               es lo que permite verlos entre la prosa de la instruccion. -->
          <div>
            <label class="pd-label" for="prompt-text">
              Instruccion<span class="pd-required">*</span>
            </label>
            <div id="prompt-text" class="q-mt-xs">
              <PromptCodeEditor
                ref="promptEditorRef"
                :model-value="form.promptText"
                @update:model-value="form.promptText = $event"
              />
            </div>
            <p
              v-if="form.promptText.trim() === ''"
              class="pd-required q-mt-xs q-mb-none"
              data-test="prompt-text-error"
            >
              La instruccion es obligatoria
            </p>
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
            :disable="!isFormValid"
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
