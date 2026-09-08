<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import WorkflowTemplateDialog from './WorkflowTemplateDialog.vue';

import { NODE_TYPE_LABELS } from '@/types/pipeline';
import { extractApiErrorMessage } from '@/utils/api-error';

import type { WorkflowTemplateSummary } from '@/types/pipeline';

const $q = useQuasar();
const templatesStore = useWorkflowTemplatesStore();

const isEditorOpen = ref(false);
const isDeleteDialogOpen = ref(false);

const editedTemplate = ref<WorkflowTemplateSummary | null>(null);
const templateToDeactivate = ref<WorkflowTemplateSummary | null>(null);

// Admite `null` porque el boton `clearable` de QInput escribe eso, no una cadena
// vacia (mismo criterio que en las demas tablas administrativas).
const filter = ref<string | null>('');

/** Cadena de nodos legible, para la columna de topologia. */
const describeTopology = (template: WorkflowTemplateSummary): string =>
  template.topology.map((step) => NODE_TYPE_LABELS[step.nodeType]).join(' → ');

const columns: QTableColumn<WorkflowTemplateSummary>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  {
    name: 'description',
    label: 'Descripcion',
    field: (row: WorkflowTemplateSummary) => row.description ?? '—',
    align: 'left',
  },
  {
    name: 'nodes',
    label: 'Nodos',
    field: (row: WorkflowTemplateSummary) => row.topology.length,
    align: 'center',
    sortable: true,
  },
  { name: 'status', label: 'Estado', field: 'active', align: 'center', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadTemplates = async (): Promise<void> => {
  try {
    // Con las retiradas incluidas: esta es la vista donde se vuelven a activar,
    // y ocultarlas las dejaria sin forma de recuperarse desde la interfaz.
    await templatesStore.fetchTemplates(true);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de plantillas'),
    });
  }
};

const openCreateDialog = (): void => {
  editedTemplate.value = null;
  isEditorOpen.value = true;
};

const openEditDialog = (template: WorkflowTemplateSummary): void => {
  editedTemplate.value = template;
  isEditorOpen.value = true;
};

const onTemplateSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Plantilla guardada correctamente' });
};

const onToggleActive = async (
  template: WorkflowTemplateSummary,
  active: boolean,
): Promise<void> => {
  try {
    await templatesStore.setActive(template.id, active);
    $q.notify({
      type: 'positive',
      message: active
        ? `Plantilla "${template.name}" disponible en el asistente.`
        : `Plantilla "${template.name}" retirada del catalogo.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cambiar el estado de la plantilla'),
    });
  }
};

const requestDeactivation = (template: WorkflowTemplateSummary): void => {
  templateToDeactivate.value = template;
  isDeleteDialogOpen.value = true;
};

const confirmDeactivation = async (): Promise<void> => {
  if (!templateToDeactivate.value) return;

  await onToggleActive(templateToDeactivate.value, false);
  templateToDeactivate.value = null;
};

onMounted(loadTemplates);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="wf-templates-header">
      <div>
        <h1 class="pd-h1">Plantillas de Flujo</h1>
        <p class="pd-subtitle">
          Topologias base de las que parten los flujos. Una plantilla no se ejecuta nunca: define
          que nodos existiran en cada flujo que se instancie a partir de ella.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nueva Plantilla"
        icon-right="north_east"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="templatesStore.templates"
      :columns="columns"
      row-key="id"
      :loading="templatesStore.isLoading"
      :filter="filter"
      no-results-label="Ningun resultado para la busqueda"
      no-data-label="Aun no hay plantillas de flujo registradas"
    >
      <template #top-right>
        <q-input
          v-model="filter"
          dense
          outlined
          clearable
          debounce="300"
          placeholder="Buscar..."
          class="pd-search-input"
          aria-label="Filtrar la tabla"
        >
          <template #append>
            <q-icon name="search" />
          </template>
        </q-input>
      </template>

      <template #body-cell-name="cellProps">
        <q-td :props="cellProps">
          {{ cellProps.value }}
          <q-tooltip anchor="top middle" self="bottom middle">
            <span class="pd-mono">{{ cellProps.row.id }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-nodes="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge pd-badge--role">{{ cellProps.value }}</q-badge>
          <q-tooltip v-if="cellProps.row.topology.length > 0">
            <span class="pd-mono">{{ describeTopology(cellProps.row) }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-toggle
            :model-value="cellProps.row.active"
            color="primary"
            :aria-label="`Publicar ${cellProps.row.name}`"
            :disable="templatesStore.isLoading"
            @update:model-value="onToggleActive(cellProps.row, $event)"
          />
          <q-tooltip>
            {{
              cellProps.row.active
                ? 'Disponible en el selector del asistente'
                : 'Retirada: no se puede instanciar'
            }}
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-actions="cellProps">
        <q-td :props="cellProps" class="q-gutter-x-xs">
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="edit"
            :aria-label="`Editar ${cellProps.row.name}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Editar plantilla</q-tooltip>
          </q-btn>

          <q-btn
            v-if="cellProps.row.active"
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Retirar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Retirar del catalogo</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <WorkflowTemplateDialog
      v-model="isEditorOpen"
      :template="editedTemplate"
      @saved="onTemplateSaved"
    />

    <!-- Retirar una plantilla deja al asistente sin ella: temporizador de 5
         segundos como toda accion critica (regla §4). La fila no se borra, para
         no romper la trazabilidad de los flujos que ya la instanciaron. -->
    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Retirar plantilla del catalogo"
      :message="`¿Seguro que deseas retirar la plantilla ${templateToDeactivate?.name ?? ''}? Dejara de aparecer en el asistente. Los flujos que ya la instanciaron NO se ven afectados: cada uno tiene su propia copia de la topologia.`"
      confirm-label="Retirar"
      @confirm="confirmDeactivation"
    />
  </q-page>
</template>

<style scoped lang="scss">
.wf-templates-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
</style>
