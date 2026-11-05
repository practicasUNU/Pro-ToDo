<script setup lang="ts">
import { useQuasar } from 'quasar';

import { useTelemetryStore } from '@stores/telemetry.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import { REPORT_FILENAMES, saveBlob } from '@/utils/file-download';

import type { ReportFormat } from '@/types/telemetry';

/**
 * Descarga de los informes que genera el servidor para el rango del store.
 *
 * Un indicador de carga POR BOTON: el PDF tarda segundos (lo imprime Chromium)
 * y no debe bloquear la exportacion CSV mientras tanto.
 */
const $q = useQuasar();
const telemetryStore = useTelemetryStore();

const LABELS: Record<ReportFormat, string> = {
  csv: 'informe CSV',
  pdf: 'informe PDF',
};

const download = async (format: ReportFormat): Promise<void> => {
  try {
    const blob = await telemetryStore.exportReport(format);
    saveBlob(blob, REPORT_FILENAMES[format]);
    $q.notify({ type: 'positive', message: `Se ha descargado el ${LABELS[format]}.` });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, `No se pudo generar el ${LABELS[format]}.`),
    });
  }
};
</script>

<template>
  <div class="pd-export-bar" role="group" aria-label="Exportar informe de consumo">
    <q-btn
      class="pd-btn-secondary"
      flat
      no-caps
      icon="table_view"
      label="Exportar CSV"
      :loading="telemetryStore.exporting.csv"
      :disable="!telemetryStore.isRangeValid"
      data-test="export-csv"
      @click="download('csv')"
    />
    <q-btn
      class="pd-btn-primary"
      unelevated
      no-caps
      icon="picture_as_pdf"
      icon-right="north_east"
      label="Exportar informe PDF"
      :loading="telemetryStore.exporting.pdf"
      :disable="!telemetryStore.isRangeValid"
      data-test="export-pdf"
      @click="download('pdf')"
    />
  </div>
</template>

<style scoped lang="scss">
.pd-export-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
}
</style>
