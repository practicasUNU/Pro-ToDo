import {
  buildCsvDocument,
  escapeCsvText,
  formatCsvDecimal,
} from '@common/utils/csv.util';
import { TELEMETRY_ORIGIN_LABELS } from '@modules/telemetry/enums/telemetry-origin.enum';
import { describeTelemetrySource } from '@modules/telemetry/reports/telemetry-source.util';

import type { TelemetryHistoryItemResponseDto } from '@modules/telemetry/dto/telemetry-report-response.dto';

// Reexportados: el formato es comun a todos los informes (`common/utils/csv.util`).
export {
  CSV_SEPARATOR,
  escapeCsvText,
  formatCsvDecimal,
} from '@common/utils/csv.util';

/** Cabeceras en castellano, en el orden de las columnas. */
export const CSV_HEADERS: readonly string[] = [
  'Fecha',
  'Flujo',
  'ID ejecución',
  'Nodo',
  'Proveedor',
  'Modelo',
  'Tokens prompt',
  'Tokens completación',
  'Tokens razonamiento',
  'Tokens totales',
  'Tarifa prompt (USD/MTok)',
  'Tarifa completación (USD/MTok)',
  'Tarifa razonamiento (USD/MTok)',
  'Coste estimado (USD)',
  'Coste aproximado',
  'Origen',
];

const toRecord = (item: TelemetryHistoryItemResponseDto): string[] => [
  escapeCsvText(item.createdAt),
  escapeCsvText(describeTelemetrySource(item)),
  escapeCsvText(item.executionId ?? ''),
  escapeCsvText(item.nodeId ?? ''),
  escapeCsvText(item.aiProvider),
  escapeCsvText(item.aiModel),
  String(item.promptTokens),
  String(item.completionTokens),
  String(item.reasoningTokens),
  String(item.totalTokens),
  formatCsvDecimal(item.promptRateUsd),
  formatCsvDecimal(item.completionRateUsd),
  formatCsvDecimal(item.reasoningRateUsd),
  formatCsvDecimal(item.estimatedCostUsd),
  item.isEstimated ? 'Sí' : 'No',
  escapeCsvText(TELEMETRY_ORIGIN_LABELS[item.operationOrigin]),
];

/**
 * Informe CSV del consumo de IA: cabecera mas una fila por inferencia.
 *
 * Funcion PURA: recibe las filas ya consultadas y devuelve los bytes;
 * `MAX_EXPORT_ROWS` acota el tamano.
 */
export const buildTelemetryCsv = (
  items: readonly TelemetryHistoryItemResponseDto[],
): Buffer => buildCsvDocument(CSV_HEADERS, items.map(toRecord));
