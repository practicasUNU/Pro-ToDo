<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { useTelemetryStore } from '@stores/telemetry.store';

import { TELEMETRY_BREAKDOWN_SORT_KEYS } from '@/types/sort';
import { datePickerBounds, defaultDateRange, isFutureDate, toIsoRange } from '@/utils/date-range';

import type { TelemetryBreakdownSortKey } from '@/types/sort';
import type { TelemetryFilters } from '@/types/telemetry';

/**
 * Barra de filtros del informe de consumo: periodo, proveedor, modelo, flujo,
 * nodo y criterio de orden del desglose.
 *
 * UN solo formulario, como en Auditoria: todo se edita en un BORRADOR local y
 * se vuelca al store de una vez con "Aplicar", que dispara una sola consulta.
 * Con un `v-model` directo, cada tecla de una fecha y cada selector lanzaban la
 * suya. Selectores CERRADOS (Poka-Yoke): las opciones salen de
 * `GET /telemetry/filter-options`, de modo que solo se puede filtrar por lo que
 * existe en el periodo. Las exportaciones leen los mismos filtros del store.
 */
const emit = defineEmits<{ apply: [] }>();

const telemetryStore = useTelemetryStore();

interface SelectOption<T extends string = string> {
  readonly label: string;
  readonly value: T;
}

type SortDirection = 'DESC' | 'ASC';

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

const DIRECTION_OPTIONS: SelectOption<SortDirection>[] = [
  { label: 'Mayor a menor', value: 'DESC' },
  { label: 'Menor a mayor', value: 'ASC' },
];

// --- Borrador. `null` es lo que deja el boton de borrar de cada selector.
const from = ref(telemetryStore.dateRange.from);
const to = ref(telemetryStore.dateRange.to);
const provider = ref<string | null>(null);
const model = ref<string | null>(null);
const flowId = ref<string | null>(null);
const nodeId = ref<string | null>(null);
const sortBy = ref<TelemetryBreakdownSortKey | null>(null);
const sortDirection = ref<SortDirection>('DESC');

/** Copia el estado aplicado del store al borrador. */
const syncDraft = (): void => {
  from.value = telemetryStore.dateRange.from;
  to.value = telemetryStore.dateRange.to;
  provider.value = telemetryStore.filters.aiProvider ?? null;
  model.value = telemetryStore.filters.aiModel ?? null;
  flowId.value = telemetryStore.filters.flowId ?? null;
  nodeId.value = telemetryStore.filters.nodeId ?? null;
  sortBy.value = telemetryStore.breakdownSort.sortBy;
  sortDirection.value = telemetryStore.breakdownSort.descending ? 'DESC' : 'ASC';
};

syncDraft();

// Si otra vista cambia el estado aplicado (el panel fija los ultimos 30 dias),
// el borrador lo refleja en vez de quedarse con valores que ya no rigen.
watch(
  () => [telemetryStore.dateRange, telemetryStore.filters, telemetryStore.breakdownSort],
  syncDraft,
);

// Un modelo o un nodo que no pertenece al proveedor o al flujo elegidos daria
// una combinacion imposible y un informe vacio sin motivo aparente.
const onProviderChange = (value: string | null): void => {
  provider.value = value;
  model.value = null;
};

const onFlowChange = (value: string | null): void => {
  flowId.value = value;
  nodeId.value = null;
};

const providerOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.providers.map((name) => ({ label: name, value: name })),
);

/** Modelos del proveedor elegido, o todos si no hay proveedor. */
const modelOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.models
    .filter((option) => provider.value === null || option.aiProvider === provider.value)
    .map((option) => ({ label: option.aiModel, value: option.aiModel })),
);

const flowOptions = computed<SelectOption[]>(() =>
  telemetryStore.filterOptions.flows.map((flow) => ({ label: flow.name, value: flow.id })),
);

/** Nodos del flujo elegido, sin repetir un mismo `nodeId` de varios flujos. */
const nodeOptions = computed<SelectOption[]>(() => {
  const nodeIds = telemetryStore.filterOptions.nodes
    .filter((node) => flowId.value === null || node.flowId === flowId.value)
    .map((node) => node.nodeId);

  return [...new Set(nodeIds)].map((id) => ({ label: id, value: id }));
});

/**
 * Dias elegibles en el calendario: ni futuros ni mas antiguos que el historial.
 * `q-date` entrega la fecha en el mismo formato que `datePickerBounds`, asi que
 * la comparacion es textual.
 */
const { min: MIN_DATE, max: MAX_DATE } = datePickerBounds();

const isSelectableDate = (date: string): boolean => date >= MIN_DATE && date <= MAX_DATE;

/**
 * Mensaje de validacion compartido por los dos campos de fecha.
 *
 * Comprueba el futuro APARTE del rango invertido porque son dos errores
 * distintos y el operador necesita saber cual cometio.
 */
const rangeRule = (): true | string => {
  if (isFutureDate(from.value) || isFutureDate(to.value)) {
    return 'No se pueden consultar fechas futuras.';
  }

  return (
    toIsoRange({ from: from.value, to: to.value }) !== null ||
    'La fecha de inicio debe ser anterior o igual a la de fin.'
  );
};

/** Vuelca el borrador entero al store y pide recargar. */
const apply = (): void => {
  if (rangeRule() !== true) return;

  // Solo las claves elegidas: `undefined` en el store es "sin filtrar".
  const filters: TelemetryFilters = {
    ...(provider.value !== null ? { aiProvider: provider.value } : {}),
    ...(model.value !== null ? { aiModel: model.value } : {}),
    ...(flowId.value !== null ? { flowId: flowId.value } : {}),
    ...(nodeId.value !== null ? { nodeId: nodeId.value } : {}),
  };

  telemetryStore.setDateRange({ from: from.value, to: to.value });
  telemetryStore.setFilters(filters);
  telemetryStore.setBreakdownSort({
    sortBy: sortBy.value,
    descending: sortDirection.value === 'DESC',
  });
  emit('apply');
};

/**
 * Devuelve el periodo al de partida, quita proveedor, modelo, flujo, nodo y
 * orden, y recarga.
 *
 * Reutiliza `defaultDateRange()` en vez de vaciar las fechas: el informe no
 * admite un rango abierto —el backend exige las dos— y dejarlas en blanco daria
 * un formulario invalido en lugar de una vista limpia.
 */
const clear = (): void => {
  telemetryStore.setDateRange(defaultDateRange());
  telemetryStore.setFilters({});
  telemetryStore.setBreakdownSort({ sortBy: null, descending: true });
  syncDraft();
  emit('apply');
};
</script>

<template>
  <q-form class="pd-report-filters" aria-label="Filtros del informe" @submit.prevent="apply">
    <!--
      `q-date` en un popup y no `type="date"`: aquel abre el selector NATIVO del
      navegador, que se pinta con el tema del sistema operativo y no admite CSS,
      de modo que en modo oscuro aparecia un recuadro blanco en mitad del panel.
    -->
    <q-input
      v-model="from"
      dense
      outlined
      label="Desde"
      stack-label
      mask="####-##-##"
      :rules="[rangeRule]"
      data-test="range-from"
    >
      <template #append>
        <q-icon name="event" class="cursor-pointer">
          <q-popup-proxy cover transition-show="scale" transition-hide="scale">
            <q-date
              v-model="from"
              mask="YYYY-MM-DD"
              class="pd-date-popup"
              :options="isSelectableDate"
            >
              <div class="row items-center justify-end">
                <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
              </div>
            </q-date>
          </q-popup-proxy>
        </q-icon>
      </template>
    </q-input>
    <q-input
      v-model="to"
      dense
      outlined
      label="Hasta"
      stack-label
      mask="####-##-##"
      :rules="[rangeRule]"
      data-test="range-to"
    >
      <template #append>
        <q-icon name="event" class="cursor-pointer">
          <q-popup-proxy cover transition-show="scale" transition-hide="scale">
            <q-date
              v-model="to"
              mask="YYYY-MM-DD"
              class="pd-date-popup"
              :options="isSelectableDate"
            >
              <div class="row items-center justify-end">
                <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
              </div>
            </q-date>
          </q-popup-proxy>
        </q-icon>
      </template>
    </q-input>
    <q-select
      :model-value="provider"
      dense
      outlined
      clearable
      emit-value
      map-options
      :options="providerOptions"
      label="Proveedor"
      data-test="filter-provider"
      @update:model-value="onProviderChange"
    />
    <q-select
      v-model="model"
      dense
      outlined
      clearable
      emit-value
      map-options
      :options="modelOptions"
      label="Modelo"
      data-test="filter-model"
    />
    <q-select
      :model-value="flowId"
      dense
      outlined
      clearable
      emit-value
      map-options
      :options="flowOptions"
      label="Flujo"
      data-test="filter-flow"
      @update:model-value="onFlowChange"
    />
    <q-select
      v-model="nodeId"
      dense
      outlined
      clearable
      emit-value
      map-options
      :options="nodeOptions"
      label="Nodo"
      data-test="filter-node"
    />
    <q-select
      v-model="sortBy"
      dense
      outlined
      clearable
      emit-value
      map-options
      :options="SORT_OPTIONS"
      label="Ordenar desglose por"
      data-test="filter-sort-by"
    />
    <q-select
      v-model="sortDirection"
      dense
      outlined
      emit-value
      map-options
      :options="DIRECTION_OPTIONS"
      :disable="sortBy === null"
      label="Sentido"
      data-test="filter-sort-direction"
    />

    <div class="pd-report-filters__actions">
      <q-btn
        type="button"
        class="pd-btn-secondary"
        flat
        no-caps
        icon="filter_alt_off"
        label="Limpiar filtros"
        data-test="range-clear"
        @click="clear"
      />
      <q-btn
        type="submit"
        class="pd-btn-primary"
        unelevated
        no-caps
        icon="filter_alt"
        label="Aplicar"
        data-test="range-apply"
      />
    </div>
  </q-form>
</template>

<style scoped lang="scss">
// Misma rejilla que la barra de Auditoria: los campos se reparten el ancho y
// las acciones cierran la fila por la derecha.
.pd-report-filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  align-items: start;
}

.pd-report-filters__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  min-height: 40px;
}
</style>
