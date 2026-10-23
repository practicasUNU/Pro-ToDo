<script setup lang="ts">
import { formatInteger, formatUsd } from '@/utils/number-format';

import type { QTableColumn } from 'quasar';
import type { ModelBreakdownRow } from '@/types/telemetry';

/**
 * Desglose del consumo por proveedor y modelo, con las cifras exactas que el
 * grafico de barras resume. Presentacional: recibe las filas ya cargadas.
 */
defineProps<{
  breakdown: readonly ModelBreakdownRow[];
  loading?: boolean;
}>();

const columns: QTableColumn<ModelBreakdownRow>[] = [
  { name: 'aiProvider', label: 'Proveedor', field: 'aiProvider', align: 'left', sortable: true },
  { name: 'aiModel', label: 'Modelo', field: 'aiModel', align: 'left', sortable: true },
  {
    name: 'invocations',
    label: 'Invocaciones',
    field: 'invocations',
    align: 'right',
    sortable: true,
    format: (value: number) => formatInteger(value),
  },
  {
    name: 'promptTokens',
    label: 'Tokens prompt',
    field: 'promptTokens',
    align: 'right',
    format: (value: number) => formatInteger(value),
  },
  {
    name: 'completionTokens',
    label: 'Tokens completación',
    field: 'completionTokens',
    align: 'right',
    format: (value: number) => formatInteger(value),
  },
  {
    name: 'reasoningTokens',
    label: 'Tokens razonamiento',
    field: 'reasoningTokens',
    align: 'right',
    format: (value: number) => formatInteger(value),
  },
  {
    name: 'costUsd',
    label: 'Coste (USD)',
    field: 'costUsd',
    align: 'right',
    sortable: true,
    format: (value: number) => formatUsd(value),
  },
];
</script>

<template>
  <q-table
    class="pd-card pd-table"
    flat
    title="Desglose por modelo"
    :rows="breakdown"
    :columns="columns"
    :row-key="(row: ModelBreakdownRow) => `${row.aiProvider}:${row.aiModel}`"
    :loading="loading"
    :pagination="{ rowsPerPage: 0 }"
    hide-pagination
    no-data-label="No hay consumo de IA registrado en el periodo."
  >
    <template #body-cell-aiModel="cellProps">
      <q-td :props="cellProps">
        <span class="pd-mono">{{ cellProps.value }}</span>
      </q-td>
    </template>
  </q-table>
</template>
