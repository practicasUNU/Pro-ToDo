<script setup lang="ts">
import { useQuasar } from 'quasar';

import { useAuditStore } from '@stores/audit.store';

import { extractApiErrorMessage } from '@/utils/api-error';
import { AUDIT_REPORT_FILENAMES, saveBlob } from '@/utils/file-download';

import type { AuditReportFormat } from '@/types/audit';

/**
 * Descarga de los informes de auditoria que genera el servidor con los filtros
 * del store. Un indicador de carga POR BOTON: el PDF lo imprime Chromium y
 * tarda segundos, y no debe bloquear la exportacion CSV mientras tanto.
 */
const $q = useQuasar();
const auditStore = useAuditStore();

const LABELS: Record<AuditReportFormat, string> = {
  csv: 'informe CSV',
  pdf: 'informe PDF',
};

const download = async (format: AuditReportFormat): Promise<void> => {
  try {
    const blob = await auditStore.exportReport(format);
    saveBlob(blob, AUDIT_REPORT_FILENAMES[format]);
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
  <div class="pd-export-bar" role="group" aria-label="Exportar informe de auditoría">
    <q-btn
      class="pd-btn-secondary"
      flat
      no-caps
      icon="table_view"
      label="Exportar CSV"
      :loading="auditStore.exporting.csv"
      :disable="!auditStore.isRangeValid"
      data-test="audit-export-csv"
      @click="download('csv')"
    />
    <q-btn
      class="pd-btn-primary"
      unelevated
      no-caps
      icon="picture_as_pdf"
      icon-right="north_east"
      label="Descargar informe PDF"
      :loading="auditStore.exporting.pdf"
      :disable="!auditStore.isRangeValid"
      data-test="audit-export-pdf"
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
