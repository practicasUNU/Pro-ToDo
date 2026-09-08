<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useWorkflowTemplatesStore } from '@stores/workflow-templates.store';
import { useWorkflowsStore } from '@stores/workflows.store';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import WorkflowDialog from './WorkflowDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { PipelineSummary } from '@/types/pipeline';

const $q = useQuasar();
const workflowsStore = useWorkflowsStore();
// Solo para resolver el NOMBRE de la plantilla de origen: la tabla recibe un
// `templateId`, y un UUID no le dice nada al operador.
const templatesStore = useWorkflowTemplatesStore();

const isEditorOpen = ref(false);
const isDeleteDialogOpen = ref(false);

const editedWorkflow = ref<PipelineSummary | null>(null);
const workflowToDeactivate = ref<PipelineSummary | null>(null);

// Admite `null` porque el boton `clearable` de QInput escribe eso, no una cadena
// vacia. QTable declara su prop `filter` como `any`, asi que el compilador no
// delataria la mentira: mas vale que el ref diga la verdad.
const filter = ref<string | null>('');

/** `id` de plantilla -> nombre, para la columna de procedencia. */
const templateNames = computed<Record<string, string>>(() =>
  Object.fromEntries(templatesStore.templates.map((template) => [template.id, template.name])),
);

const resolveTemplateName = (workflow: PipelineSummary): string =>
  workflow.templateId === null
    ? '—'
    : (templateNames.value[workflow.templateId] ?? 'Plantilla retirada');

const columns: QTableColumn<PipelineSummary>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  {
    name: 'description',
    label: 'Descripcion',
    field: (row: PipelineSummary) => row.description ?? '—',
    align: 'left',
  },
  {
    name: 'template',
    label: 'Plantilla de origen',
    field: resolveTemplateName,
    align: 'left',
    sortable: true,
  },
  {
    name: 'nodes',
    label: 'Nodos',
    field: (row: PipelineSummary) => row.topology.length,
    align: 'center',
    sortable: true,
  },
  { name: 'status', label: 'Estado', field: 'active', align: 'center', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadCatalog = async (): Promise<void> => {
  try {
    // Las plantillas se piden en paralelo y con las retiradas incluidas: un
    // flujo puede venir de una que ya se retiro, y sin ella su procedencia
    // apareceria como desconocida.
    await Promise.all([workflowsStore.fetchWorkflows(), templatesStore.fetchTemplates(true)]);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de flujos'),
    });
  }
};

const openEditDialog = (workflow: PipelineSummary): void => {
  editedWorkflow.value = workflow;
  isEditorOpen.value = true;
};

const onWorkflowSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Flujo actualizado correctamente' });
};

/**
 * Habilita el flujo frente a los disparadores automaticos.
 *
 * El backend revalida el esquema antes de activar y devuelve 400 si el flujo no
 * tiene ninguno, asi que el fallo llega como mensaje concreto y el interruptor
 * se queda donde estaba: el store escribe la respuesta del servidor, no un
 * parche optimista.
 */
const onToggleActive = async (workflow: PipelineSummary, active: boolean): Promise<void> => {
  try {
    await workflowsStore.setActive(workflow.id, active);
    $q.notify({
      type: 'positive',
      message: active
        ? `Flujo "${workflow.name}" habilitado. El sondeo lo recogera en menos de un minuto.`
        : `Flujo "${workflow.name}" retirado de los disparadores.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cambiar el estado del flujo'),
    });
  }
};

const requestDeactivation = (workflow: PipelineSummary): void => {
  workflowToDeactivate.value = workflow;
  isDeleteDialogOpen.value = true;
};

const confirmDeactivation = async (): Promise<void> => {
  if (!workflowToDeactivate.value) return;

  await onToggleActive(workflowToDeactivate.value, false);
  workflowToDeactivate.value = null;
};

onMounted(loadCatalog);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="workflows-header">
      <div>
        <h1 class="pd-h1">Flujos</h1>
        <p class="pd-subtitle">
          Flujos instanciados a partir de una plantilla. Cada uno lleva su propia copia de la
          topologia: editar la plantilla de origen no los altera.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nuevo Flujo"
        icon-right="north_east"
        to="/flujos/nuevo"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="workflowsStore.workflows"
      :columns="columns"
      row-key="id"
      :loading="workflowsStore.isLoading"
      :filter="filter"
      no-results-label="Ningun resultado para la busqueda"
      no-data-label="Aun no hay flujos creados"
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
            <span class="pd-mono">
              {{
                cellProps.row.topology.map((step: { nodeId: string }) => step.nodeId).join(' → ')
              }}
            </span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-toggle
            :model-value="cellProps.row.active"
            color="primary"
            :aria-label="`Habilitar ${cellProps.row.name}`"
            :disable="workflowsStore.isLoading"
            @update:model-value="onToggleActive(cellProps.row, $event)"
          />
          <q-tooltip>
            {{
              cellProps.row.active
                ? 'Habilitado frente a los disparadores automaticos'
                : 'No se disparara hasta que lo habilites'
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
            <q-tooltip>Editar flujo</q-tooltip>
          </q-btn>

          <q-btn
            v-if="cellProps.row.active"
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Desactivar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Desactivar flujo</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <WorkflowDialog v-model="isEditorOpen" :workflow="editedWorkflow" @saved="onWorkflowSaved" />

    <!-- Desactivar un flujo en marcha corta la ingesta: pasa por el temporizador
         de 5 segundos como toda accion critica (regla §4). El interruptor de la
         tabla queda para el sentido contrario, habilitar, que no destruye nada. -->
    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Desactivar flujo"
      :message="`¿Seguro que deseas desactivar el flujo ${workflowToDeactivate?.name ?? ''}? Dejara de procesar correos entrantes hasta que lo habilites de nuevo.`"
      confirm-label="Desactivar"
      @confirm="confirmDeactivation"
    />
  </q-page>
</template>

<style scoped lang="scss">
.workflows-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
</style>
