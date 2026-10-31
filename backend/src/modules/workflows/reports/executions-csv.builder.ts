import { buildCsvDocument, escapeCsvText } from '@common/utils/csv.util';

import type { ExecutionExportRow } from '@modules/workflows/executions.service';

// Reexportados: el formato es comun a todos los informes (`common/utils/csv.util`).
export { CSV_SEPARATOR, escapeCsvText } from '@common/utils/csv.util';

/**
 * Cabeceras en castellano, en el orden de las columnas.
 *
 * "Última actualización" y no "Fin": `fecha_actualizacion` es el ultimo
 * checkpoint, que solo coincide con el cierre cuando la ejecucion termino. Es
 * el mismo rotulo que la tabla del historial, para que el fichero diga lo mismo
 * que la pantalla.
 */
export const CSV_HEADERS: readonly string[] = [
  'Ejecución',
  'Flujo',
  'ID flujo',
  'Estado',
  'Inicio',
  'Última actualización',
  'Paso actual',
  'Alertas',
  'Motivo',
];

// TODAS las celdas de texto pasan por `escapeCsvText`, tambien las que hoy
// genera el sistema (ids, fechas, estado): el nombre del flujo y el motivo los
// escribe una persona, y un `=HYPERLINK(...)` se ejecutaria al abrir el informe.
const toRecord = (row: ExecutionExportRow): string[] => [
  escapeCsvText(row.executionId),
  // Sin nombre (flujo borrado), su identificador: igual que la tabla.
  escapeCsvText(row.flowName ?? row.flowId),
  escapeCsvText(row.flowId),
  escapeCsvText(row.state),
  escapeCsvText(row.startedAt),
  escapeCsvText(row.updatedAt),
  escapeCsvText(row.activeCursor ?? ''),
  row.hasAlerts ? 'Sí' : 'No',
  escapeCsvText(row.failureReason ?? ''),
];

/**
 * Informe CSV del historial de ejecuciones: cabecera mas una fila por ejecucion.
 *
 * Funcion PURA: recibe las filas ya consultadas y devuelve los bytes;
 * `MAX_EXPORT_ROWS` acota el tamano. Las fechas salen tal cual del resumen, en
 * ISO 8601 UTC: un informe que se compara entre equipos no debe depender de la
 * zona horaria del servidor que lo genero.
 */
export const buildExecutionsCsv = (
  rows: readonly ExecutionExportRow[],
): Buffer => buildCsvDocument(CSV_HEADERS, rows.map(toRecord));
