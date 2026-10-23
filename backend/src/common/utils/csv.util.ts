/**
 * Separador de campo. Punto y coma y no coma: los informes los abre sobre todo
 * Excel en configuracion es-ES, que usa la coma como separador DECIMAL y parte
 * en columnas por `;`. Con coma, cada importe se partiria en dos celdas.
 */
export const CSV_SEPARATOR = ';';

/**
 * Marca de orden de bytes UTF-8. Sin ella Excel abre el fichero como Windows-1252
 * y "Completación" sale como "CompletaciÃ³n".
 */
const UTF8_BOM = '﻿';

/** Fin de registro de RFC 4180. */
const CRLF = '\r\n';

/**
 * Prefijos con los que una hoja de calculo interpreta una celda como formula.
 * Un nombre como `=HYPERLINK(...)` se ejecutaria al abrir el informe (inyeccion
 * CSV, OWASP); se neutraliza anteponiendo una comilla simple.
 */
const FORMULA_PREFIXES: ReadonlySet<string> = new Set([
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
]);

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
 * escala de los importes en USD y de las tarifas.
 */
export const formatCsvDecimal = (value: number): string =>
  value.toFixed(6).replace('.', ',');

/**
 * Documento CSV completo: cabecera escapada mas registros YA serializados (cada
 * informe decide como escapa sus celdas, porque los numeros no se escapan).
 *
 * Funcion PURA que devuelve los bytes. Se monta en memoria y no en streaming
 * porque cada exportacion acota sus filas con un techo propio.
 */
export const buildCsvDocument = (
  headers: readonly string[],
  records: readonly string[][],
): Buffer => {
  const lines = [
    headers.map(escapeCsvText).join(CSV_SEPARATOR),
    ...records.map((cells) => cells.join(CSV_SEPARATOR)),
  ];

  return Buffer.from(`${UTF8_BOM}${lines.join(CRLF)}${CRLF}`, 'utf8');
};
