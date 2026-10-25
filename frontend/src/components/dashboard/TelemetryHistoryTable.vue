<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';
import { formatInteger, formatUsd } from '@/utils/number-format';
import { toTableSort } from '@/utils/table-sort';

import { TELEMETRY_HISTORY_SORT_KEYS } from '@/types/sort';
import { TELEMETRY_ORIGIN_LABELS, TelemetryOperationOrigin } from '@/types/telemetry';

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
    // El asistente de prompts y el banco de pruebas no corren dentro de ningun
    // flujo: se nombra su origen en lugar de dejar la celda vacia.
    field: (row) =>
      row.operationOrigin === TelemetryOperationOrigin.FLOW_EXECUTION
        ? (row.flowName ?? row.flowId ?? '—')
        : TELEMETRY_ORIGIN_LABELS[row.operationOrigin],
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

/**
 * Paginacion de la tabla, con el STORE como unica fuente de verdad.
 *
 * Escribible y ligada con `v-model:pagination` y no con `:pagination` a secas:
 * Quasar solo fusiona esta prop en su estado interno cuando existe un listener
 * `onUpdate:pagination`. Sin el, la prop valia como valor INICIAL y nada mas, de
 * modo que a partir del primer repintado la cabecera llevaba su propio
 * `sortBy`/`descending` y el store llevaba el de la consulta: dos estados que
 * divergian, y la flecha acababa senalando un orden que los datos no tenian.
 *
 * El `set` solo recoge el criterio de orden. La pagina la sigue pidiendo
 * `onRequest`, y el `get` la refleja cuando el store ya tiene la respuesta.
 */
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({
    page: Math.floor(telemetryStore.historyOffset / telemetryStore.historyLimit) + 1,
    rowsPerPage: telemetryStore.historyLimit,
    rowsNumber: telemetryStore.historyTotal,
    sortBy: telemetryStore.historySort.sortBy,
    descending: telemetryStore.historySort.descending,
  }),
  set: (next) => {
    telemetryStore.setHistorySort(
      toTableSort(TELEMETRY_HISTORY_SORT_KEYS, next.sortBy, next.descending ?? false),
    );
  },
});

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
 * El criterio de orden viaja en el mismo evento y se manda al backend, que lo
 * valida contra su lista blanca y ordena el historial ENTERO.
 */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || telemetryStore.historyLimit;

  telemetryStore.setHistorySort(
    toTableSort(TELEMETRY_HISTORY_SORT_KEYS, requested.sortBy, requested.descending),
  );

  void loadPage({ limit: rowsPerPage, offset: (requested.page - 1) * rowsPerPage });
};
</script>

<template>
  <q-table
    class="pd-card pd-table"
    flat
    title="Detalle de consumos"
    :rows="telemetryStore.historyItems"
    :columns="columns"
    row-key="id"
    :loading="telemetryStore.isLoadingHistory"
    v-model:pagination="pagination"
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
  font-size: 0.6875rem;
  color: var(--pd-text-secondary);
}

.pd-history__estimated {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 6px;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--pd-text-secondary);
  border-bottom: 2px solid var(--pd-warning);
}
</style>
