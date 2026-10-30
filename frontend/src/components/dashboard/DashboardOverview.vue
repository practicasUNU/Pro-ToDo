<script setup lang="ts">
import { onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import { usePanelRefresh } from '@/composables/usePanelRefresh';

import ExecutionsHistoryTable from '@components/dashboard/ExecutionsHistoryTable.vue';
import ExportReportBar from '@components/dashboard/ExportReportBar.vue';
import TelemetryCostChart from '@components/dashboard/TelemetryCostChart.vue';
import TelemetryModelSuccessChart from '@components/dashboard/TelemetryModelSuccessChart.vue';
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

// Las filas de telemetria se escriben mientras el flujo corre, asi que el
// desenlace es el primer momento en que hay algo nuevo que resumir. Sin esto,
// los KPIs se quedaban congelados hasta que alguien recargaba la pagina.
usePanelRefresh(loadDashboard, { onFlowCompleted: true });
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

    <TelemetrySummaryCards
      :summary="telemetryStore.summary"
      :breakdown="telemetryStore.breakdown"
      :loading="telemetryStore.isLoading"
    />

    <!-- Coste y exito por modelo, mitad y mitad: se leen juntos (un modelo
         barato que falla mucho no sale barato). En movil se apilan. -->
    <div class="row q-col-gutter-md" data-test="model-charts">
      <div class="col-12 col-md-6">
        <TelemetryCostChart
          class="pd-dashboard__chart"
          :breakdown="telemetryStore.breakdown"
          :loading="telemetryStore.isLoading"
        />
      </div>
      <div class="col-12 col-md-6">
        <TelemetryModelSuccessChart
          class="pd-dashboard__chart"
          :breakdown="telemetryStore.breakdown"
          :loading="telemetryStore.isLoading"
        />
      </div>
    </div>

    <!-- El historial, a ancho completo y con sus propios filtros. -->
    <ExecutionsHistoryTable compact class="col-12" />
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

.pd-dashboard__chart {
  height: 100%;
}

.pd-dashboard__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
</style>
