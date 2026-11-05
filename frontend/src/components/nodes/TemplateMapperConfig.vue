<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';

import TemplateEditorDialog from '@components/templates/TemplateEditorDialog.vue';
import TemplatePreviewDialog from '@components/templates/TemplatePreviewDialog.vue';

import { useSelectFilter } from '@/composables/useSelectFilter';

import { extractApiErrorMessage } from '@/utils/api-error';

import { NODE_OUTPUT_NAMESPACES } from '@/types/pipeline';

import type { HtmlTemplate } from '@/types/html-template';

interface Props {
  /** Identificador del nodo dentro del pipeline_schema (contrato §3.1). */
  nodeId: string;
}

const props = defineProps<Props>();

const $q = useQuasar();
// Este componente NO llama a la red: todo pasa por su store (regla §3.1), y ese
// store es el de ESTE nodo: dos mapeadores en el mismo flujo eligen plantillas
// distintas sin pisarse.
//
// Tampoco carga el catalogo de nodos: es estado del ANFITRION, y los dos que
// existen ya lo piden —el agregador en paralelo con las plantillas, el banco de
// pruebas en su `onMounted`—. Un tercer cargador desde aqui haria que el
// componente alcanzara un store global que no es el suyo.
const templateMapperStore = useTemplateMapperStore(props.nodeId);

const isPreviewOpen = ref(false);
const isEditorOpen = ref(false);

// Opciones del selector cerrado: el operador elige, jamas teclea un UUID.
const templateOptions = computed(() =>
  templateMapperStore.availableTemplates.map((template) => ({
    label: template.name,
    value: template.id,
  })),
);

// Lista cerrada, la misma que el validador de topologia acepta: se elige, no se
// teclea. Un guion o una mayuscula aqui eran un 400 al guardar el flujo entero.
const namespaceOptions = computed(() => [...NODE_OUTPUT_NAMESPACES]);

const { filteredOptions: filteredTemplateOptions, filterFn: filterTemplates } =
  useSelectFilter(templateOptions);
const { filteredOptions: filteredNamespaceOptions, filterFn: filterNamespaces } =
  useSelectFilter(namespaceOptions);

const loadTemplates = async (): Promise<void> => {
  try {
    await templateMapperStore.loadTemplates();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las plantillas'),
    });
  }
};

const onTemplateCreated = async (template: HtmlTemplate): Promise<void> => {
  // La plantilla recien creada debe quedar seleccionada sin obligar a buscarla.
  await loadTemplates();
  templateMapperStore.setTemplateId(template.id);
  $q.notify({ type: 'positive', message: 'Plantilla creada y seleccionada' });
};

onMounted(loadTemplates);
</script>

<template>
  <section class="pd-card pd-card--accent q-pa-md" :data-node-id="nodeId">
    <header class="q-mb-md">
      <h2 class="pd-h2">Mapeador de plantilla</h2>
      <p class="pd-subtitle">
        Inyecta la plantilla base ya saneada en su namespace de salida para que un PROCESADOR_IA
        posterior la rellene. Este nodo ya no interpola variables.
      </p>
      <p class="pd-subtitle pd-mono">{{ nodeId }}</p>
    </header>

    <!-- Selector determinista (Poka-Yoke): CERRADO, sin texto libre.
         `use-input` habilita teclear para FILTRAR, no para inventar: lo que
         daria de alta un valor nuevo es `new-value-mode`, que no esta. Con
         decenas de plantillas, elegir sin filtro era desplazarse a ojo. -->
    <div class="q-mb-md">
      <label class="pd-label" for="template-mapper-select">
        Plantilla<span class="pd-required">*</span>
      </label>
      <q-select
        id="template-mapper-select"
        :model-value="templateMapperStore.config.templateId"
        :options="filteredTemplateOptions"
        outlined
        dense
        emit-value
        map-options
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        class="q-mt-xs"
        :loading="templateMapperStore.isLoading"
        placeholder="Selecciona una plantilla"
        @filter="filterTemplates"
        @update:model-value="templateMapperStore.setTemplateId($event)"
      />
    </div>

    <div class="q-mb-md" data-test="output-namespace-field">
      <label class="pd-label" for="template-mapper-namespace">
        Namespace de salida<span class="pd-required">*</span>
      </label>
      <q-select
        id="template-mapper-namespace"
        :model-value="templateMapperStore.config.outputNamespace"
        :options="filteredNamespaceOptions"
        outlined
        dense
        use-input
        fill-input
        hide-selected
        input-debounce="0"
        class="q-mt-xs pd-mono"
        @filter="filterNamespaces"
        @update:model-value="templateMapperStore.setOutputNamespace(String($event))"
      />
    </div>

    <div class="pd-actions">
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon="visibility"
        label="Previsualizar"
        :disable="templateMapperStore.config.templateId === null"
        @click="isPreviewOpen = true"
      />
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon="add"
        label="Nueva plantilla"
        @click="isEditorOpen = true"
      />
    </div>

    <!-- Avisos que NO bloquean el avance: una plantilla con marcadores sigue
         siendo guardable, aunque su ejecucion vaya a fallar. Quien decide es el
         operador, y el aviso nombra el codigo del motor para que reconozca el
         mismo problema cuando lo vea en la trazabilidad. -->
    <q-banner
      v-for="warning in templateMapperStore.configWarnings"
      :key="warning"
      dense
      class="pd-warn-banner q-mt-md"
      data-test="template-mapper-warning"
    >
      <template #avatar>
        <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      </template>
      {{ warning }}
    </q-banner>

    <TemplatePreviewDialog
      v-model="isPreviewOpen"
      :template="templateMapperStore.selectedTemplate"
    />

    <!-- Ya NO se le pasa el contexto del flujo: el editor dejo de ofrecer un
         insertador de marcadores. Una plantilla de este nodo se estructura con
         selectores CSS vacios y la rellena el PROCESADOR_IA de detras, asi que
         no hay ninguna ruta `{{ns.campo}}` que componer aqui. -->
    <TemplateEditorDialog v-model="isEditorOpen" :template="null" @saved="onTemplateCreated" />
  </section>
</template>

<style scoped lang="scss">
// Aviso ambar: informa, no bloquea. Mismo tratamiento que en WebScraperConfig.
.pd-warn-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  background: var(--pd-surface-muted);
  color: var(--pd-text-secondary);
}

.pd-warn-icon {
  color: var(--pd-warning);
  flex: 0 0 auto;
}

.pd-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios). Mismo
// bloque que en `ParserEmailConfig.vue`, `TriggerImapConfig.vue` y
// `WebScraperConfig.vue`; con la cuarta copia, candidato claro a subir a app.scss.
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}

:deep(.q-field__messages) {
  color: var(--pd-text-secondary);
}
</style>
