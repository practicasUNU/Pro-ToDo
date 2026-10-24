<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';
import { formatInteger, formatUsd } from '@/utils/number-format';
import { sortRows } from '@/utils/table-sort';

import { TelemetryOperationOrigin } from '@/types/telemetry';

import type { QTableColumn, QTableProps } from 'quasar';
import type { TelemetryHistoryItem } from '@/types/telemetry';

/**
 * Detalle de consumos: una fila por inferencia de IA, paginada en el servidor.
 *
 * Las inferencias con coste aproximado llevan icono + texto "Aproximado"; el
 * color de aviso solo refuerza.
 */
const $q = useQuasar();
const telemetryStore = useTelemetryStore();

const columns: QTableColumn<TelemetryHistoryItem>[] = [
  {
    name: 'createdAt',
    label: 'Fecha',
    field: 'createdAt',
    align: 'left',
    sortable: true,
    format: (value: string) => formatDateTime(value),
  },
  {
    name: 'flow',
    label: 'Flujo',
    // El asistente de prompts no corre dentro de ningun flujo: se nombra su
    // origen en lugar de dejar la celda vacia.
    field: (row) =>
      row.operationOrigin === TelemetryOperationOrigin.PROMPT_OPTIMIZATION
        ? 'Optimización de prompt'
        : (row.flowName ?? row.flowId ?? '—'),
    align: 'left',
    sortable: true,
    classes: 'pd-cell--long',
  },
  {
    name: 'nodeId',
    label: 'Nodo',
    field: (row) => row.nodeId ?? '—',
    align: 'left',
    sortable: true,
  },
  { name: 'aiModel', label: 'Modelo', field: 'aiModel', align: 'left', sortable: true },
  {
    name: 'totalTokens',
    label: 'Tokens',
    field: 'totalTokens',
    align: 'right',
    sortable: true,
    format: (value: number) => formatInteger(value),
  },
  {
    name: 'estimatedCostUsd',
    label: 'Coste (USD)',
    field: 'estimatedCostUsd',
    align: 'right',
    sortable: true,
    format: (value: number) => formatUsd(value),
  },
];

// Orden de la PAGINA CARGADA: la paginacion es del servidor, asi que la
// cabecera reordena lo visible y no el historial entero.
const sortBy = ref<string | null>(null);
const descending = ref(false);

/**
 * Columnas cuyo `field` no es una clave de la fila.
 *
 * `flow` pinta el nombre del flujo, su id o el origen del asistente de
 * prompts; `nodeId` pinta un guion cuando falta. Ordenar por el texto que se
 * ve mezclaria los huecos entre los valores reales.
 */
const SORT_RESOLVERS = {
  flow: (row: TelemetryHistoryItem) =>
    row.operationOrigin === TelemetryOperationOrigin.PROMPT_OPTIMIZATION
      ? 'Optimización de prompt'
      : (row.flowName ?? row.flowId),
  nodeId: (row: TelemetryHistoryItem) => row.nodeId,
};

const sortedRows = computed(() =>
  sortRows(telemetryStore.historyItems, sortBy.value, descending.value, SORT_RESOLVERS),
);

const pagination = computed(() => ({
  page: Math.floor(telemetryStore.historyOffset / telemetryStore.historyLimit) + 1,
  rowsPerPage: telemetryStore.historyLimit,
  rowsNumber: telemetryStore.historyTotal,
  sortBy: sortBy.value,
  descending: descending.value,
}));

const loadPage = async (page: { limit: number; offset: number }): Promise<void> => {
  try {
    await telemetryStore.loadHistory(page);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el detalle de consumos.'),
    });
  }
};

/**
 * Paginacion server-side: QTable pide la pagina y el store la trae.
 *
 * El criterio de orden viaja en el mismo evento y se guarda para el `computed`;
 * no se manda al backend, que no admite `sortBy`.
 */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || telemetryStore.historyLimit;

  sortBy.value = requested.sortBy ?? null;
  descending.value = requested.descending;

  void loadPage({ limit: rowsPerPage, offset: (requested.page - 1) * rowsPerPage });
};
</script>

<template>
  <q-table
    class="pd-card pd-table"
    flat
    title="Detalle de consumos"
    :rows="sortedRows"
    :columns="columns"
    row-key="id"
    :loading="telemetryStore.isLoadingHistory"
    :pagination="pagination"
    :rows-per-page-options="[25, 50, 100]"
    rows-per-page-label="Filas por página"
    no-data-label="No hay inferencias registradas en el periodo."
    @request="onRequest"
  >
    <template #body-cell-nodeId="cellProps">
      <q-td :props="cellProps">
        <span class="pd-mono">{{ cellProps.value }}</span>
      </q-td>
    </template>

    <template #body-cell-aiModel="cellProps">
      <q-td :props="cellProps">
        <span class="pd-mono">{{ cellProps.value }}</span>
        <span class="pd-history__provider">{{ cellProps.row.aiProvider }}</span>
      </q-td>
    </template>

    <template #body-cell-estimatedCostUsd="cellProps">
      <q-td :props="cellProps">
        {{ cellProps.value }}
        <span v-if="cellProps.row.isEstimated" class="pd-history__estimated">
          <q-icon name="info_outline" size="14px" aria-hidden="true" />
          Aproximado
          <q-tooltip>
            El proveedor no informó del uso o el modelo no tenía tarifa propia.
          </q-tooltip>
        </span>
      </q-td>
    </template>
  </q-table>
</template>

<style scoped lang="scss">
.pd-history__provider {
  display: block;
  font-size: 11px;
  color: var(--pd-text-secondary);
}

.pd-history__estimated {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--pd-text-secondary);
  border-bottom: 2px solid var(--pd-warning);
}
</style>
