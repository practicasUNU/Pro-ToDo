import { api } from '@boot/axios';

import type { ReportFormat, TelemetryQuery } from '@/types/telemetry';

// Descarga de los informes que genera el SERVIDOR (`/telemetry/export/*`). El
// frontend no compone ni el CSV ni el PDF: solo pide los bytes. Guardarlos en
// disco es cosa del componente (`utils/file-download.ts`), porque toca el DOM.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const EXPORT_PATH = '/telemetry/export';

/**
 * Bytes del informe en el formato pedido.
 *
 * `responseType: 'blob'` es obligatorio: con el `json` por defecto Axios
 * intentaria parsear el PDF y lo corromperia.
 */
const downloadReport = async (format: ReportFormat, query: TelemetryQuery): Promise<Blob> => {
  const { data } = await api.get<Blob>(`${EXPORT_PATH}/${format}`, {
    params: query,
    responseType: 'blob',
  });

  return data;
};

/** Informe CSV del consumo del rango (todas las filas). */
export const downloadCsv = (query: TelemetryQuery = {}): Promise<Blob> =>
  downloadReport('csv', query);

/** Informe PDF con totales, desglose por modelo, detalle y firma institucional. */
export const downloadPdf = (query: TelemetryQuery = {}): Promise<Blob> =>
  downloadReport('pdf', query);
