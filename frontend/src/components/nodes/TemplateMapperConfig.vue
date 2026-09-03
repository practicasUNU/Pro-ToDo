<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';

import TemplateEditorDialog from '@components/templates/TemplateEditorDialog.vue';
import TemplatePreviewDialog from '@components/templates/TemplatePreviewDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import { OUTPUT_NAMESPACE_PATTERN } from '@/types/pipeline';

import type { HtmlTemplate } from '@/types/html-template';

interface Props {
  /** Identificador del nodo dentro del pipeline_schema (contrato §3.1). */
  nodeId: string;
}

defineProps<Props>();

const $q = useQuasar();
// Este componente NO llama a la red: todo pasa por su store (regla §3.1).
const templateMapperStore = useTemplateMapperStore();

const isPreviewOpen = ref(false);
const isEditorOpen = ref(false);

// Opciones del selector cerrado: el operador elige, jamas teclea un UUID.
const templateOptions = computed(() =>
  templateMapperStore.availableTemplates.map((template) => ({
    label: template.name,
    value: template.id,
  })),
);

// Raices distintas de las variables que faltan: el banner nombra namespaces, no
// rutas completas, porque lo que hay que anadir al flujo es un nodo que produzca
// el namespace entero.
const missingNamespaces = computed(() => [
  ...new Set(
    templateMapperStore.missingRequiredVariables.map((path) => path.split('.')[0] ?? path),
  ),
]);

const isMissingVariable = (variable: string): boolean =>
  templateMapperStore.missingRequiredVariables.includes(variable);

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
  <section class="pd-card pd-card--accent q-pa-md">
    <header class="q-mb-md">
      <h2 class="pd-h2">Mapeador de plantilla</h2>
      <p class="pd-subtitle">
        Compila una plantilla del catalogo contra el contexto acumulado del flujo.
      </p>
      <p class="pd-subtitle pd-mono">{{ nodeId }}</p>
    </header>

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

    <div class="q-mb-md">
      <label class="pd-label" for="template-mapper-namespace">
        Namespace de salida<span class="pd-required">*</span>
      </label>
      <q-input
        id="template-mapper-namespace"
        :model-value="templateMapperStore.config.outputNamespace"
        outlined
        dense
        class="q-mt-xs pd-mono"
        input-class="pd-mono"
        :rules="[
          (val: string) =>
            OUTPUT_NAMESPACE_PATTERN.test(val) ||
            'Solo minusculas, digitos y guion bajo (ej. rendered_html)',
        ]"
        @update:model-value="templateMapperStore.setOutputNamespace(String($event))"
      />
    </div>

    <!-- Bloquea el avance, no es un simple aviso: de ahi el rojo y no el ambar -->
    <div
      v-if="templateMapperStore.missingRequiredVariables.length > 0"
      class="pd-contract-banner q-mb-md"
      role="alert"
    >
      <q-icon name="error_outline" size="20px" class="pd-contract-icon" />
      <div>
        <div class="pd-label pd-contract-title">Incompatibilidad de contrato</div>
        <p class="pd-subtitle q-mb-none">
          El flujo actual no provee los namespaces requeridos por esta plantilla:
          <span class="pd-mono">{{ missingNamespaces.join(', ') }}</span
          >. Anade un nodo previo que los produzca o elige otra plantilla.
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
            Ningun nodo previo produce este namespace
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

    <TemplateEditorDialog v-model="isEditorOpen" :template="null" @saved="onTemplateCreated" />
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

.pd-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
