<script setup lang="ts">
import { onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import ExecutionsHistoryTable from '@components/dashboard/ExecutionsHistoryTable.vue';
import ExportReportBar from '@components/dashboard/ExportReportBar.vue';
import TelemetryCostChart from '@components/dashboard/TelemetryCostChart.vue';
import TelemetrySummaryCards from '@components/dashboard/TelemetrySummaryCards.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { defaultDateRange } from '@/utils/date-range';

/**
 * Panel principal: KPIs de consumo de IA de los ultimos 30 dias, coste por
 * modelo y las ultimas ejecuciones. El analisis con rango y detalle completo
 * vive en Informes, enlazado desde la cabecera.
 */
const $q = useQuasar();
const telemetryStore = useTelemetryStore();

const loadDashboard = async (): Promise<void> => {
  // El panel es SIEMPRE los ultimos 30 dias: el store guarda el rango que se
  // eligiera en Informes, y heredarlo haria mentir al subtitulo.
  telemetryStore.setDateRange(defaultDateRange());

  try {
    await telemetryStore.loadDashboard();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las métricas de consumo.'),
    });
  }
};

onMounted(loadDashboard);
</script>

<template>
  <div class="pd-dashboard">
    <header class="pd-dashboard__header">
      <div>
        <h1 class="pd-h1">Panel de control</h1>
        <p class="pd-subtitle pd-text-secondary">
          Consumo de IA y actividad de los flujos en los últimos 30 días.
        </p>
      </div>
      <div class="pd-dashboard__actions">
        <q-btn
          class="pd-btn-secondary"
          flat
          no-caps
          icon="assessment"
          label="Ver informes"
          to="/informes"
          data-test="go-reports"
        />
        <ExportReportBar />
      </div>
    </header>

    <TelemetrySummaryCards :summary="telemetryStore.summary" :loading="telemetryStore.isLoading" />

    <div class="pd-dashboard__grid">
      <TelemetryCostChart
        :breakdown="telemetryStore.breakdown"
        :loading="telemetryStore.isLoading"
      />
      <ExecutionsHistoryTable compact />
    </div>
  </div>
</template>

<style scoped lang="scss">
.pd-dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pd-dashboard__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.pd-dashboard__header .pd-h1 {
  margin: 0;
}

.pd-subtitle {
  margin: 4px 0 0;
}

.pd-dashboard__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.pd-dashboard__grid {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(0, 2fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 1023px) {
  .pd-dashboard__grid {
    grid-template-columns: 1fr;
  }
}
</style>
