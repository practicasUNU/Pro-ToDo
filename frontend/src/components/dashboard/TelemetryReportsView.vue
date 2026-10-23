<script setup lang="ts">
import { onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import ExportReportBar from '@components/dashboard/ExportReportBar.vue';
import TelemetryCostChart from '@components/dashboard/TelemetryCostChart.vue';
import TelemetryDateRangeFilter from '@components/dashboard/TelemetryDateRangeFilter.vue';
import TelemetryHistoryTable from '@components/dashboard/TelemetryHistoryTable.vue';
import TelemetryModelBreakdownTable from '@components/dashboard/TelemetryModelBreakdownTable.vue';
import TelemetrySummaryCards from '@components/dashboard/TelemetrySummaryCards.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

/**
 * Informes de consumo de IA: periodo elegible, KPIs, desglose por modelo,
 * detalle por inferencia y descarga CSV/PDF del mismo periodo.
 */
const $q = useQuasar();
const telemetryStore = useTelemetryStore();

/** KPIs, desglose y primera pagina del detalle, para el periodo vigente. */
const loadReport = async (): Promise<void> => {
  try {
    await Promise.all([telemetryStore.loadDashboard(), telemetryStore.loadHistory({ offset: 0 })]);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el informe de consumo.'),
    });
  }
};

onMounted(loadReport);
</script>

<template>
  <div class="pd-reports">
    <header class="pd-reports__header">
      <div>
        <h1 class="pd-h1">Informes de consumo de IA</h1>
        <p class="pd-subtitle pd-text-secondary">
          Tokens, coste estimado y detalle por inferencia del periodo elegido.
        </p>
      </div>
      <ExportReportBar />
    </header>

    <section class="pd-card pd-reports__filter" aria-label="Periodo del informe">
      <TelemetryDateRangeFilter @apply="loadReport" />
    </section>

    <TelemetrySummaryCards :summary="telemetryStore.summary" :loading="telemetryStore.isLoading" />

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
