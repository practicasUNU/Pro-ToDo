import type { TelemetryHistoryItemResponseDto } from '@modules/telemetry/dto/telemetry-report-response.dto';

/**
 * Separador de campo. Punto y coma y no coma: el informe lo abre sobre todo
 * Excel en configuracion es-ES, que usa la coma como separador DECIMAL y parte
 * en columnas por `;`. Con coma, cada importe se partiria en dos celdas.
 */
export const CSV_SEPARATOR = ';';

/**
 * Marca de orden de bytes UTF-8. Sin ella Excel abre el fichero como Windows-1252
 * y "Completación" sale como "CompletaciÃ³n".
 */
const UTF8_BOM = '\uFEFF';

/** Fin de registro de RFC 4180. */
const CRLF = '\r\n';

/**
 * Prefijos con los que una hoja de calculo interpreta una celda como formula.
 * Un nombre de flujo como `=HYPERLINK(...)` se ejecutaria al abrir el informe
 * (inyeccion CSV, OWASP); se neutraliza anteponiendo una comilla simple.
 */
const FORMULA_PREFIXES: ReadonlySet<string> = new Set([
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
]);

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
];

/**
 * Celda de texto escapada segun RFC 4180: entre comillas si contiene el
 * separador, comillas o saltos de linea, con las comillas internas duplicadas.
 */
export const escapeCsvText = (value: string): string => {
  const neutralized = FORMULA_PREFIXES.has(value.charAt(0))
    ? `'${value}`
    : value;

  return /[";\r\n]/.test(neutralized)
    ? `"${neutralized.replace(/"/g, '""')}"`
    : neutralized;
};

/**
 * Importe con coma decimal, coherente con el separador `;`. Seis decimales: la
 * escala de `costo_estimado_usd` y de las tarifas.
 */
export const formatCsvDecimal = (value: number): string =>
  value.toFixed(6).replace('.', ',');

const toRecord = (item: TelemetryHistoryItemResponseDto): string =>
  [
    escapeCsvText(item.createdAt),
    escapeCsvText(item.flowName ?? item.flowId),
    escapeCsvText(item.executionId),
    escapeCsvText(item.nodeId),
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
  ].join(CSV_SEPARATOR);

/**
 * Informe CSV del consumo de IA: cabecera mas una fila por inferencia.
 *
 * Funcion PURA: recibe las filas ya consultadas y devuelve los bytes. Se monta
 * en memoria y no en streaming porque `MAX_EXPORT_ROWS` acota el tamano, y asi
 * no hace falta ninguna dependencia nueva para escribir un formato tan simple.
 */
export const buildTelemetryCsv = (
  items: readonly TelemetryHistoryItemResponseDto[],
): Buffer => {
  const lines = [
    CSV_HEADERS.map(escapeCsvText).join(CSV_SEPARATOR),
    ...items.map(toRecord),
  ];

  return Buffer.from(`${UTF8_BOM}${lines.join(CRLF)}${CRLF}`, 'utf8');
};
