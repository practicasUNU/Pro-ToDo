// Helper de presentacion sin estado (frontend-architecture.md §2.1): ofrece al
// navegador unos bytes como descarga. No hace I/O de red; los bytes ya los
// trajo `reports.service.ts`.

import { toDateInputValue } from '@/utils/date-range';

/** Nombres de descarga, iguales a los que fija el backend en `Content-Disposition`. */
export const REPORT_FILENAMES = {
  csv: 'informe-telemetria.csv',
  pdf: 'informe-telemetria.pdf',
} as const;

/** Nombres del informe de auditoria, iguales a los de `AuditController`. */
export const AUDIT_REPORT_FILENAMES = {
  csv: 'informe-auditoria.csv',
  pdf: 'informe-auditoria.pdf',
} as const;

/**
 * Nombre del historial de ejecuciones, fechado con el dia LOCAL de la descarga.
 *
 * A diferencia de los informes de telemetria, lleva fecha: el historial se
 * exporta a menudo para comparar dias, y varios ficheros con el mismo nombre
 * acaban como `(1)`, `(2)` en la carpeta de descargas. El dia es el local y no
 * el UTC, que de madrugada en Espana seria todavia "ayer".
 */
export const executionsHistoryFilename = (now: Date = new Date()): string =>
  `historial-ejecuciones-${toDateInputValue(now)}.csv`;

/**
 * Guarda un `Blob` con el nombre indicado.
 *
 * Se usa un enlace temporal con `download` y no `window.open`: abrir el blob en
 * otra pestana lo bloquean los navegadores como ventana emergente, y un CSV ni
 * siquiera se mostraria. La URL se revoca enseguida para no retener los bytes en
 * memoria mientras la pestana siga abierta.
 */
export const saveBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);

  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
};
