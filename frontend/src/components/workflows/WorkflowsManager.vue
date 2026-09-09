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
 * Aplica el cambio de estado contra la API.
 *
 * UNICO punto que muta el estado, y por eso es privado a las dos acciones de
 * abajo: no lo invoca ningun control de la tabla directamente. Habilitar entra
 * por `onActivate` y retirar SOLO por la confirmacion del dialogo, de modo que
 * no exista ninguna via de desactivar un flujo con un solo clic.
 *
 * El backend revalida el esquema antes de activar y devuelve 400 si el flujo no
 * tiene ninguno, asi que el fallo llega como mensaje concreto y la fila se queda
 * como estaba: el store escribe la respuesta del servidor, no un parche
 * optimista.
 */
const applyActiveState = async (workflow: PipelineSummary, active: boolean): Promise<void> => {
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

/**
 * Habilita el flujo sin confirmacion.
 *
 * Asimetria deliberada (Poka-Yoke, CU-10): activar no destruye nada y es
 * reversible en un clic, asi que interponer un dialogo solo anadiria friccion.
 * El unico riesgo real —un grafo roto expuesto a los disparadores— lo cubre el
 * backend, que revalida el esquema antes de habilitar.
 */
const onActivate = async (workflow: PipelineSummary): Promise<void> => {
  await applyActiveState(workflow, true);
};

/** Abre la confirmacion con temporizador. NO muta nada por si misma. */
const requestDeactivation = (workflow: PipelineSummary): void => {
  workflowToDeactivate.value = workflow;
  isDeleteDialogOpen.value = true;
};

/**
 * Unica via de desactivar un flujo.
 *
 * La llama `SafeDeleteModal` tras su cuenta atras de 5 segundos
 * (`frontend-quasar.md` §4): desactivar corta la ingesta de un flujo en marcha,
 * y un correo que llega mientras esta retirado no se recupera —queda en el buzon
 * sin procesar hasta que alguien lo note.
 *
 * El estado reactivo lo sincroniza el store con la respuesta del backend, asi
 * que la tabla y el `q-badge` se repintan sin recargar el catalogo.
 */
const confirmDeactivation = async (): Promise<void> => {
  if (!workflowToDeactivate.value) return;

  await applyActiveState(workflowToDeactivate.value, false);
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

      <!-- La columna de estado solo INFORMA. Antes llevaba un `q-toggle`, que
           duplicaba la conmutacion con el boton de la botonera y —peor— dejaba
           desactivar un flujo en marcha con un solo clic, saltandose el
           temporizador que exige CU-10. -->
      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-badge
            class="pd-badge"
            :class="cellProps.row.active ? 'pd-badge--active' : 'pd-badge--inactive'"
          >
            {{ cellProps.row.active ? 'Activo' : 'Inactivo' }}
          </q-badge>
          <q-tooltip>
            {{
              cellProps.row.active
                ? 'Habilitado frente a los disparadores automaticos'
                : 'No se disparara hasta que lo habilites'
            }}
          </q-tooltip>
        </q-td>
      </template>

      <!-- Toda la conmutacion de estado vive AQUI, en un solo control por fila y
           excluyente: o se ofrece activar, o se ofrece desactivar. -->
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

          <!-- Activar es directo: no destruye nada y es reversible. -->
          <q-btn
            v-if="!cellProps.row.active"
            class="pd-btn-primary"
            unelevated
            dense
            no-caps
            size="sm"
            label="Activar"
            icon-right="play_arrow"
            :disable="workflowsStore.isLoading"
            :aria-label="`Activar ${cellProps.row.name}`"
            @click="onActivate(cellProps.row)"
          >
            <q-tooltip>Habilitar frente a los disparadores</q-tooltip>
          </q-btn>

          <!-- Desactivar es critico y pasa SIEMPRE por la cuenta atras. -->
          <q-btn
            v-else
            class="pd-btn-danger"
            unelevated
            dense
            no-caps
            size="sm"
            label="Desactivar"
            icon-right="block"
            :disable="workflowsStore.isLoading"
            :aria-label="`Desactivar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Requiere confirmacion de 5 segundos</q-tooltip>
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
