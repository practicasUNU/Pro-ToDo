<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { copyToClipboard, useQuasar } from 'quasar';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';

import TemplateEditorDialog from '@components/templates/TemplateEditorDialog.vue';
import TemplatePreviewDialog from '@components/templates/TemplatePreviewDialog.vue';

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

const NO_UPSTREAM_WARNING =
  'Ningun paso anterior de este flujo publica campos interpolables. Una plantilla con variables no podra resolverse aqui: coloca por delante un nodo que las produzca —un PARSER_PRE_IA expone el correo ya saneado— o usa una plantilla estatica.';
const VARIABLES_HINT = 'Elige una para copiar su marcador y pegarlo en la plantilla';
const NO_VARIABLES_HINT = 'Sin pasos anteriores que publiquen campos';

const isPreviewOpen = ref(false);
const isEditorOpen = ref(false);
const variableFilter = ref<string>('');

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

// Filtrado en cliente del selector de variables. Vive en el componente y no en
// el store porque es estado de ESTA interfaz: otro consumidor de las mismas
// opciones no hereda el texto que alguien tecleo en este desplegable.
const filteredVariableOptions = computed(() => {
  const needle = variableFilter.value.trim().toLowerCase();

  if (needle === '') return templateMapperStore.variableOptions;

  return templateMapperStore.variableOptions.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) || option.group.toLowerCase().includes(needle),
  );
});

const isMissingVariable = (variable: string): boolean =>
  templateMapperStore.missingRequiredVariables.includes(variable);

// Los dos fallos posibles piden arreglos distintos, y el tooltip debe decir
// cual: anadir un nodo al flujo, o corregir la plantilla.
const missingVariableReason = (variable: string): string =>
  templateMapperStore.missingUpstreamFields.includes(variable)
    ? 'El namespace existe, pero el nodo que lo escribe no publica este campo'
    : 'Ningun nodo previo produce este namespace';

const onVariableFilter = (needle: string, update: (callback: () => void) => void): void => {
  update(() => {
    variableFilter.value = needle;
  });
};

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

const onCopyVariable = async (marker: string): Promise<void> => {
  try {
    await copyToClipboard(marker);
    $q.notify({ type: 'positive', message: `${marker} copiado al portapapeles` });
  } catch {
    // El portapapeles exige contexto seguro y permiso del navegador. Si lo
    // niega, el marcador sigue a la vista en la opcion: se puede copiar a mano.
    $q.notify({ type: 'warning', message: `Copia manualmente: ${marker}` });
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
        Compila una plantilla del catalogo contra el contexto acumulado del flujo.
      </p>
      <p class="pd-subtitle pd-mono">{{ nodeId }}</p>
    </header>

    <!-- Aviso de topologia: no bloquea. Una plantilla estatica es legitima -->
    <div
      v-if="!templateMapperStore.hasUpstreamVariables"
      class="pd-warn-banner q-mb-md"
      data-test="no-upstream-variables"
    >
      <q-icon name="warning_amber" size="20px" class="pd-warn-icon" />
      <span>{{ NO_UPSTREAM_WARNING }}</span>
    </div>

    <!-- Selector determinista (Poka-Yoke): sin use-input, sin texto libre -->
    <div class="q-mb-md">
      <label class="pd-label" for="template-mapper-select">
        Plantilla<span class="pd-required">*</span>
      </label>
      <q-select
        id="template-mapper-select"
        :model-value="templateMapperStore.config.templateId"
        :options="templateOptions"
        outlined
        dense
        emit-value
        map-options
        class="q-mt-xs"
        :loading="templateMapperStore.isLoading"
        placeholder="Selecciona una plantilla"
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
        :options="namespaceOptions"
        outlined
        dense
        class="q-mt-xs pd-mono"
        @update:model-value="templateMapperStore.setOutputNamespace(String($event))"
      />
    </div>

    <!-- Inventario real de lo que el flujo publica, agrupado por paso -->
    <div class="q-mb-md" data-test="upstream-variables-field">
      <label class="pd-label" for="template-mapper-variables">Variables disponibles</label>
      <q-select
        id="template-mapper-variables"
        :model-value="null"
        :options="filteredVariableOptions"
        outlined
        dense
        use-input
        emit-value
        map-options
        input-debounce="0"
        class="q-mt-xs"
        :disable="!templateMapperStore.hasUpstreamVariables"
        :hint="templateMapperStore.hasUpstreamVariables ? VARIABLES_HINT : NO_VARIABLES_HINT"
        @filter="onVariableFilter"
        @update:model-value="onCopyVariable(String($event))"
      >
        <template #option="scope">
          <q-item v-bind="scope.itemProps">
            <q-item-section avatar>
              <q-icon name="data_object" size="18px" class="pd-option-icon" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ scope.opt.label }}</q-item-label>
              <q-item-label caption class="pd-mono pd-variable-option">
                {{ scope.opt.value }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </template>
      </q-select>
    </div>

    <!-- Bloquea el avance, no es un simple aviso: de ahi el rojo y no el ambar -->
    <div
      v-if="templateMapperStore.missingRequiredVariables.length > 0"
      class="pd-contract-banner q-mb-md"
      role="alert"
      data-test="broken-contract-banner"
    >
      <q-icon name="error_outline" size="20px" class="pd-contract-icon" />
      <div>
        <div class="pd-label pd-contract-title">Incompatibilidad de contrato</div>
        <p
          v-if="templateMapperStore.missingUpstreamNamespaces.length > 0"
          class="pd-subtitle q-mb-none"
        >
          El flujo actual no provee los namespaces requeridos por esta plantilla:
          <span class="pd-mono">{{ templateMapperStore.missingUpstreamNamespaces.join(', ') }}</span
          >. Añade un nodo previo que los produzca o elige otra plantilla.
        </p>
        <p
          v-if="templateMapperStore.missingUpstreamFields.length > 0"
          class="pd-subtitle q-mb-none"
        >
          Estas variables apuntan a campos que el nodo que escribe ese namespace no publica:
          <span class="pd-mono">{{ templateMapperStore.missingUpstreamFields.join(', ') }}</span
          >. Corrige la plantilla con una de las variables disponibles.
        </p>
      </div>
    </div>

    <div v-if="templateMapperStore.requiredVariables.length > 0" class="q-mb-md">
      <div class="pd-label">Variables que exige al contexto</div>
      <div class="pd-chip-bar q-mt-xs">
        <q-chip
          v-for="variable in templateMapperStore.requiredVariables"
          :key="variable"
          dense
          class="pd-variable-chip pd-mono"
          :class="{ 'pd-variable-chip--missing': isMissingVariable(variable) }"
          :label="variable"
        >
          <q-tooltip v-if="isMissingVariable(variable)">
            {{ missingVariableReason(variable) }}
          </q-tooltip>
        </q-chip>
      </div>
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

    <TemplatePreviewDialog
      v-model="isPreviewOpen"
      :template="templateMapperStore.selectedTemplate"
    />

    <!-- El editor recibe el contexto del flujo: con el, sus chips insertan la
         ruta completa en vez de dejar al autor terminando el nombre a mano. -->
    <TemplateEditorDialog
      v-model="isEditorOpen"
      :template="null"
      :upstream-context="templateMapperStore.availableUpstreamContext"
      @saved="onTemplateCreated"
    />
  </section>
</template>

<style scoped lang="scss">
.pd-chip-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.pd-variable-chip {
  background: var(--pd-surface-muted);
  color: var(--pd-accent-text);
  border: 1px solid var(--pd-border);
}

// La variable que rompe el contrato, distinguible de un vistazo entre las demas.
.pd-variable-chip--missing {
  background: var(--pd-row-urgente);
  color: var(--pd-negative);
  border-color: var(--pd-negative);
}

.pd-contract-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--pd-negative);
  border-radius: $generic-border-radius;
  background: var(--pd-row-urgente);
}

.pd-contract-icon {
  color: var(--pd-negative);
  flex: 0 0 auto;
}

.pd-contract-title {
  color: var(--pd-negative);
}

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

.pd-option-icon {
  color: var(--pd-accent);
}

.pd-variable-option {
  color: var(--pd-accent-text);
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
