import { api } from '@boot/axios';

import type {
  AuditEventPage,
  AuditEventsFilter,
  AuditEventsQuery,
  AuditReportFormat,
} from '@/types/audit';

// Unica capa que conoce las rutas de `AuditController`. Devuelve la data ya
// desestructurada; los errores HTTP se propagan al store y de ahi al
// componente, que decide el mensaje.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const AUDIT_PATH = '/audit';

/** Pagina del historial de acciones humanas con los filtros indicados. */
export const fetchAuditEvents = async (query: AuditEventsQuery = {}): Promise<AuditEventPage> => {
  const { data } = await api.get<AuditEventPage>(`${AUDIT_PATH}/events`, { params: query });

  return data;
};

/**
 * Bytes del informe de auditoria en el formato pedido. `responseType: 'blob'`
 * es obligatorio: con el `json` por defecto Axios corromperia el PDF.
 */
export const downloadAuditReport = async (
  format: AuditReportFormat,
  filter: AuditEventsFilter = {},
): Promise<Blob> => {
  const { data } = await api.get<Blob>(`${AUDIT_PATH}/reports/export`, {
    params: { ...filter, format },
    responseType: 'blob',
  });

  return data;
};
