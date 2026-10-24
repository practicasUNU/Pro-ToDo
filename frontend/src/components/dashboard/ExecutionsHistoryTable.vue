<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useExecutionsStore } from '@stores/executions.store';
import { useWorkflowsStore } from '@stores/workflows.store';

import LogViewerModal from '@components/shared/LogViewerModal.vue';

import { ExecutionState } from '@/types/execution';
import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';
import { sortRows } from '@/utils/table-sort';
import { canInspectLog } from '@/utils/execution-log';
import { describeExecutionState } from '@/utils/execution-state-display';

import type { QTableColumn, QTableProps } from 'quasar';
import type { ExecutionSummary } from '@/types/execution';

/**
 * Historial de ejecuciones, paginado en el servidor.
 *
 * El estado se comunica con icono, texto y color a la vez (WCAG 1.4.1): el
 * color solo refuerza. El filtro es un `q-select` cerrado con los estados del
 * motor (Poka-Yoke): no hay texto libre que pueda pedir un estado inexistente.
 *
 * `compact` es la variante del dashboard: sin filtro y con menos filas.
 */
const props = defineProps<{
  compact?: boolean;
}>();

const $q = useQuasar();
const executionsStore = useExecutionsStore();
const workflowsStore = useWorkflowsStore();

const STATE_OPTIONS = Object.values(ExecutionState).map((state) => ({
  value: state,
  label: describeExecutionState(state).label,
}));

/** Nombre del flujo, o su id si el catalogo no lo trae (flujo sin esquema). */
const flowNames = computed(
  () => new Map(workflowsStore.workflows.map((workflow) => [workflow.id, workflow.name])),
);

const columns: QTableColumn<ExecutionSummary>[] = [
  { name: 'state', label: 'Estado', field: 'state', align: 'left', sortable: true },
  {
    name: 'flow',
    label: 'Flujo',
    field: (row) => flowNames.value.get(row.flowId) ?? row.flowId,
    align: 'left',
    // SIN `sortable`: el nombre no esta en la fila, se resuelve contra el
    // catalogo de flujos, y una ejecucion de un flujo que el catalogo todavia
    // no trajo caeria a su UUID. Ordenar mezclaria nombres con identificadores
    // y el resultado cambiaria segun lo que hubiera cargado en ese momento.
  },
  {
    name: 'startedAt',
    label: 'Inicio',
    field: 'startedAt',
    align: 'left',
    sortable: true,
    format: (value: string) => formatDateTime(value),
  },
  {
    name: 'updatedAt',
    label: 'Última actualización',
    field: 'updatedAt',
    align: 'left',
    sortable: true,
    format: (value: string) => formatDateTime(value),
  },
  {
    name: 'detail',
    label: 'Detalle',
    field: (row) => row.failureReason ?? row.activeCursor ?? '',
    align: 'left',
    classes: 'pd-cell--long',
  },
  { name: 'actions', label: 'Traza', field: 'executionId', align: 'center' },
];

/** Ejecucion cuya traza esta abierta en el visor. */
const isLogViewerOpen = ref(false);
const inspectedExecutionId = ref<string | null>(null);

const openLog = (execution: ExecutionSummary): void => {
  inspectedExecutionId.value = execution.executionId;
  isLogViewerOpen.value = true;
};

// Orden de la PAGINA CARGADA: la paginacion es del servidor, asi que la
// cabecera reordena lo visible y no el historial entero.
const sortBy = ref<string | null>(null);
const descending = ref(false);

const sortedRows = computed(() =>
  sortRows(executionsStore.items, sortBy.value, descending.value),
);

const pagination = computed(() => ({
  page: Math.floor(executionsStore.offset / executionsStore.limit) + 1,
  rowsPerPage: executionsStore.limit,
  rowsNumber: executionsStore.total,
  sortBy: sortBy.value,
  descending: descending.value,
}));

const stateFilter = computed<ExecutionState | null>({
  get: () => executionsStore.filters.state ?? null,
  set: (state) => {
    executionsStore.setFilters(state === null ? {} : { state });
    void loadPage();
  },
});

const loadPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
  try {
    await executionsStore.fetchPage(page);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el historial de ejecuciones.'),
    });
  }
};

/** Paginacion server-side: QTable pide la pagina y el store la trae. */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || executionsStore.limit;

  // El orden se guarda para el `computed` y no se manda al backend, que no
  // admite `sortBy`; reordenar lo que ya esta en memoria no pide otro viaje.
  sortBy.value = requested.sortBy ?? null;
  descending.value = requested.descending;

  void loadPage({ limit: rowsPerPage, offset: (requested.page - 1) * rowsPerPage });
};

onMounted(async () => {
  // El nombre del flujo sale del catalogo; si otra vista ya lo cargo, no se
  // repite la peticion.
  if (workflowsStore.workflows.length === 0) {
    try {
      await workflowsStore.fetchWorkflows();
    } catch {
      // Sin catalogo la tabla sigue siendo util: muestra el id del flujo.
    }
  }

  await loadPage({ limit: props.compact ? 5 : executionsStore.limit, offset: 0 });
});
</script>

<template>
  <q-table
    class="pd-card pd-table"
    flat
    title="Historial de ejecuciones"
    :rows="sortedRows"
    :columns="columns"
    row-key="executionId"
    :loading="executionsStore.isLoading"
    :pagination="pagination"
    :rows-per-page-options="compact ? [5] : [10, 25, 50]"
    rows-per-page-label="Filas por página"
    no-data-label="No hay ejecuciones registradas."
    @request="onRequest"
  >
    <template v-if="!compact" #top-right>
      <q-select
        v-model="stateFilter"
        class="pd-search-input"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="STATE_OPTIONS"
        label="Filtrar por estado"
        aria-label="Filtrar ejecuciones por estado"
        data-test="state-filter"
      />
    </template>

    <template #body-cell-state="cellProps">
      <q-td :props="cellProps">
        <q-badge
          class="pd-badge pd-execution-badge"
          :class="describeExecutionState(cellProps.row.state).badgeClass"
          :data-test="`state-${cellProps.row.state}`"
        >
          <q-icon
            :name="describeExecutionState(cellProps.row.state).icon"
            size="14px"
            aria-hidden="true"
          />
          {{ describeExecutionState(cellProps.row.state).label }}
        </q-badge>
        <q-tooltip>{{ describeExecutionState(cellProps.row.state).description }}</q-tooltip>
      </q-td>
    </template>

    <!-- Visor de logs SOLO donde hay algo que inspeccionar: fallo, pausa o
         alertas. En una ejecucion en curso o exitosa sin observaciones el
         boton seria ruido en cada fila. -->
    <template #body-cell-actions="cellProps">
      <q-td :props="cellProps">
        <q-btn
          v-if="canInspectLog(cellProps.row)"
          class="pd-btn-icon"
          outline
          dense
          size="sm"
          icon="terminal"
          :aria-label="`Ver log de la ejecución ${cellProps.row.executionId}`"
          :data-test="`view-log-${cellProps.row.executionId}`"
          @click="openLog(cellProps.row)"
        >
          <q-tooltip>Ver log</q-tooltip>
        </q-btn>
      </q-td>
    </template>

    <template #body-cell-detail="cellProps">
      <q-td :props="cellProps">
        <span :class="{ 'pd-mono': cellProps.row.failureReason === null }">
          {{ cellProps.value }}
        </span>
      </q-td>
    </template>
  </q-table>

  <LogViewerModal v-model="isLogViewerOpen" :execution-id="inspectedExecutionId" />
</template>

<style scoped lang="scss">
.pd-execution-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>
