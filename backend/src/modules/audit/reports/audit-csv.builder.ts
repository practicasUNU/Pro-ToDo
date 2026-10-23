import { buildCsvDocument, escapeCsvText } from '@common/utils/csv.util';
import {
  changedAuditKeys,
  labelAuditAction,
  labelAuditTable,
} from '@modules/audit/reports/audit-labels';

import type { AuditEventResponseDto } from '@modules/audit/dto/audit-event-response.dto';

/** Cabeceras en castellano, en el orden de las columnas. */
export const AUDIT_CSV_HEADERS: readonly string[] = [
  'Fecha',
  'Usuario',
  'Acción',
  'Tabla',
  'ID registro',
  'IP de origen',
  'Campos modificados',
  'Datos anteriores (JSON)',
  'Datos nuevos (JSON)',
];

/** Texto de la celda cuando no consta el dato. */
const EMPTY_CELL = '';

const toJsonCell = (data: Record<string, unknown> | null): string =>
  data === null ? EMPTY_CELL : escapeCsvText(JSON.stringify(data));

const toRecord = (event: AuditEventResponseDto): string[] => [
  escapeCsvText(event.createdAt),
  escapeCsvText(event.userEmail ?? event.userId ?? EMPTY_CELL),
  escapeCsvText(labelAuditAction(event.action)),
  escapeCsvText(labelAuditTable(event.affectedTable)),
  escapeCsvText(event.recordId ?? EMPTY_CELL),
  escapeCsvText(event.sourceIp ?? EMPTY_CELL),
  escapeCsvText(changedAuditKeys(event.previousData, event.newData).join(', ')),
  toJsonCell(event.previousData),
  toJsonCell(event.newData),
];

/**
 * Informe CSV de auditoria: cabecera mas una fila por evento, con las dos
 * fotografias completas en JSON (el PDF solo lista los campos modificados).
 *
 * Funcion PURA; `MAX_AUDIT_EXPORT_ROWS` acota el tamano.
 */
export const buildAuditCsv = (
  events: readonly AuditEventResponseDto[],
): Buffer => buildCsvDocument(AUDIT_CSV_HEADERS, events.map(toRecord));
