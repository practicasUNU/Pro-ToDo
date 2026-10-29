<script setup lang="ts">
import { computed } from 'vue';

import { useTelemetryStore } from '@stores/telemetry.store';

import TelemetryDateRangeFilter from '@components/dashboard/TelemetryDateRangeFilter.vue';

import { TELEMETRY_BREAKDOWN_SORT_KEYS } from '@/types/sort';

import type { TelemetryBreakdownSortKey } from '@/types/sort';
import type { TelemetryFilters } from '@/types/telemetry';

/**
 * Barra de filtros del informe de consumo: periodo, proveedor, modelo, flujo,
 * nodo y criterio de orden del desglose.
 *
 * Selectores CERRADOS (Poka-Yoke): las opciones salen de
 * `GET /telemetry/filter-options`, de modo que solo se puede filtrar por lo que
 * existe en el periodo. Cada cambio se aplica en el acto y emite `apply`; el
 * periodo conserva su boton porque una fecha a medio teclear no es un rango.
 * Las exportaciones leen los mismos filtros del store.
 */
const emit = defineEmits<{ apply: [] }>();

const telemetryStore = useTelemetryStore();

interface SelectOption<T extends string = string> {
  readonly label: string;
  readonly value: T;
}

const SORT_LABELS: Readonly<Record<TelemetryBreakdownSortKey, string>> = {
  invocations: 'Invocaciones',
  promptTokens: 'Tokens de prompt',
  completionTokens: 'Tokens de completación',
  reasoningTokens: 'Tokens de razonamiento',
  totalTokens: 'Tokens totales',
  costUsd: 'Coste (USD)',
};

const SORT_OPTIONS: SelectOption<TelemetryBreakdownSortKey>[] = TELEMETRY_BREAKDOWN_SORT_KEYS.map(
  (key) => ({ label: SORT_LABELS[key], value: key }),
);

const DIRECTION_OPTIONS: SelectOption<'DESC' | 'ASC'>[] = [
  { label: 'Mayor a menor', value: 'DESC' },
  { label: 'Menor a mayor', value: 'ASC' },
];

const providerOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.providers.map((provider) => ({ label: provider, value: provider })),
);

/** Modelos del proveedor elegido, o todos si no hay proveedor. */
const modelOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.models
    .filter(
      (model) =>
        telemetryStore.filters.aiProvider === undefined ||
        model.aiProvider === telemetryStore.filters.aiProvider,
    )
    .map((model) => ({ label: model.aiModel, value: model.aiModel })),
);

const flowOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.flows.map((flow) => ({ label: flow.name, value: flow.id })),
);

/** Nodos del flujo elegido, sin repetir un mismo `nodeId` de varios flujos. */
const nodeOptions = computed<SelectOption[]>(() => {
  const nodeIds = telemetryStore.filterOptions.nodes
    .filter(
      (node) =>
        telemetryStore.filters.flowId === undefined ||
        node.flowId === telemetryStore.filters.flowId,
    )
    .map((node) => node.nodeId);

  return [...new Set(nodeIds)].map((nodeId) => ({ label: nodeId, value: nodeId }));
});

/**
 * Aplica un filtro. Cambiar el proveedor o el flujo vacia el modelo o el nodo
 * dependiente: conservarlo dejaria una combinacion imposible y un informe vacio
 * sin motivo aparente.
 */
const updateFilter = (key: keyof TelemetryFilters, value: string | null): void => {
  const next: Record<string, string | undefined> = {
    ...telemetryStore.filters,
    [key]: value ?? undefined,
  };

  if (key === 'aiProvider') next.aiModel = undefined;
  if (key === 'flowId') next.nodeId = undefined;

  telemetryStore.setFilters(next);
  emit('apply');
};

const sortBy = computed(() => telemetryStore.breakdownSort.sortBy);
const sortDirection = computed<'DESC' | 'ASC'>(() =>
  telemetryStore.breakdownSort.descending ? 'DESC' : 'ASC',
);

const updateSortBy = (value: TelemetryBreakdownSortKey | null): void => {
  telemetryStore.setBreakdownSort({
    sortBy: value,
    descending: telemetryStore.breakdownSort.descending,
  });
  emit('apply');
};

const updateSortDirection = (value: 'DESC' | 'ASC'): void => {
  telemetryStore.setBreakdownSort({
    sortBy: telemetryStore.breakdownSort.sortBy,
    descending: value === 'DESC',
  });
  emit('apply');
};
</script>

<template>
  <div class="pd-report-filters">
    <TelemetryDateRangeFilter @apply="emit('apply')" />

    <div class="pd-report-filters__row" role="group" aria-label="Filtros del informe">
      <q-select
        :model-value="telemetryStore.filters.aiProvider ?? null"
        class="pd-report-filters__field"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="providerOptions"
        label="Proveedor"
        data-test="filter-provider"
        @update:model-value="updateFilter('aiProvider', $event)"
      />
      <q-select
        :model-value="telemetryStore.filters.aiModel ?? null"
        class="pd-report-filters__field"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="modelOptions"
        label="Modelo"
        data-test="filter-model"
        @update:model-value="updateFilter('aiModel', $event)"
      />
      <q-select
        :model-value="telemetryStore.filters.flowId ?? null"
        class="pd-report-filters__field"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="flowOptions"
        label="Flujo"
        data-test="filter-flow"
        @update:model-value="updateFilter('flowId', $event)"
      />
      <q-select
        :model-value="telemetryStore.filters.nodeId ?? null"
        class="pd-report-filters__field"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="nodeOptions"
        label="Nodo"
        data-test="filter-node"
        @update:model-value="updateFilter('nodeId', $event)"
      />
      <q-select
        :model-value="sortBy"
        class="pd-report-filters__field"
        dense
        outlined
        clearable
        emit-value
        map-options
        :options="SORT_OPTIONS"
        label="Ordenar desglose por"
        data-test="filter-sort-by"
        @update:model-value="updateSortBy"
      />
      <q-select
        :model-value="sortDirection"
        class="pd-report-filters__field"
        dense
        outlined
        emit-value
        map-options
        :options="DIRECTION_OPTIONS"
        :disable="sortBy === null"
        label="Sentido"
        data-test="filter-sort-direction"
        @update:model-value="updateSortDirection"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.pd-report-filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pd-report-filters__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-bottom: 12px;
}

.pd-report-filters__field {
  min-width: 180px;
  flex: 1 1 180px;
}
</style>
