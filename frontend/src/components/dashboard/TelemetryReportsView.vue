<script setup lang="ts">
import { onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import { usePanelRefresh } from '@/composables/usePanelRefresh';

import ExportReportBar from '@components/dashboard/ExportReportBar.vue';
import TelemetryCostChart from '@components/dashboard/TelemetryCostChart.vue';
import TelemetryHistoryTable from '@components/dashboard/TelemetryHistoryTable.vue';
import TelemetryModelBreakdownTable from '@components/dashboard/TelemetryModelBreakdownTable.vue';
import TelemetryReportFilters from '@components/dashboard/TelemetryReportFilters.vue';
import TelemetrySummaryCards from '@components/dashboard/TelemetrySummaryCards.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

/**
 * Informes de consumo de IA: periodo y filtros elegibles, KPIs, desglose por
 * modelo, detalle por inferencia y descarga CSV/PDF con esos mismos filtros.
 */
const $q = useQuasar();
const telemetryStore = useTelemetryStore();

/**
 * KPIs, desglose, primera pagina del detalle y opciones de los filtros, para
 * el periodo y los filtros vigentes.
 */
const loadReport = async (): Promise<void> => {
  try {
    await Promise.all([
      telemetryStore.loadDashboard(),
      telemetryStore.loadHistory({ offset: 0 }),
      telemetryStore.loadFilterOptions(),
    ]);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el informe de consumo.'),
    });
  }
};

onMounted(loadReport);

// Recarga CONSERVANDO el periodo elegido: `loadReport` no toca el rango del
// store, de modo que un informe acotado a una semana concreta no salta a los
// ultimos 30 dias porque haya terminado una ejecucion.
usePanelRefresh(loadReport, { onFlowCompleted: true });
</script>

<template>
  <div class="pd-reports">
    <header class="pd-reports__header">
      <div>
        <h1 class="pd-h1">Informes de consumo de IA</h1>
        <p class="pd-subtitle pd-text-secondary">
          Tokens, coste estimado, tasa de éxito y detalle por inferencia del periodo elegido.
        </p>
      </div>
      <ExportReportBar />
    </header>

    <section class="pd-card pd-reports__filter" aria-label="Filtros del informe">
      <TelemetryReportFilters @apply="loadReport" />
    </section>

    <TelemetrySummaryCards
      :summary="telemetryStore.summary"
      :breakdown="telemetryStore.breakdown"
      :loading="telemetryStore.isLoading"
    />

    <div class="pd-reports__grid">
      <TelemetryCostChart
        :breakdown="telemetryStore.breakdown"
        :loading="telemetryStore.isLoading"
      />
      <TelemetryModelBreakdownTable
        :breakdown="telemetryStore.breakdown"
        :loading="telemetryStore.isLoading"
      />
    </div>

    <TelemetryHistoryTable />
  </div>
</template>

<style scoped lang="scss">
.pd-reports {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pd-reports__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.pd-reports__header .pd-h1 {
  margin: 0;
}

.pd-subtitle {
  margin: 4px 0 0;
}

.pd-reports__filter {
  padding: 12px 16px 0;
}

.pd-reports__grid {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(0, 2fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1023px) {
  .pd-reports__grid {
    grid-template-columns: 1fr;
  }
}
</style>
