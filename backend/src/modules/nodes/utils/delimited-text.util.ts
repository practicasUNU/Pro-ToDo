/**
 * Separadores candidatos, en orden de preferencia ante empate.
 *
 * La coma primero porque es la del estandar; el punto y coma esta justo detras
 * porque es lo que exporta Excel en una configuracion regional espanola, y era
 * el caso que dejaba toda la fila dentro de una unica columna.
 */
const DELIMITER_CANDIDATES: readonly string[] = [',', ';', '\t', '|'];

/** Trozo de cabecera que se analiza para decidir el separador. */
const SNIFF_CHARS = 4_096;

/** Marca de orden de bytes de UTF-8, que ningun analizador trata como dato. */
const BYTE_ORDER_MARK = 0xfeff;

/**
 * Retira el BOM inicial.
 *
 * Sin esto el primer encabezado de un CSV exportado por Excel sale con un
 * caracter invisible pegado delante, y deja de coincidir con el nombre de
 * columna que el operador cree tener.
 */
export const stripBom = (text: string): string =>
  text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;

/**
 * Analizador RFC 4180. Devuelve SIEMPRE cadenas: cero coercion de tipos.
 *
 * Es la razon de no delegar en `exceljs.csv.read`, que seria el camino obvio
 * teniendo ya la libreria: su conversor por defecto pasa `"00123"` a `123`
 * —y con ello se pierde un codigo postal, un NIF o un numero de expediente—,
 * convierte las fechas a `Date` segun SUS formatos y no los del fichero,
 * traduce `#N/A` a un objeto de error, no retira el BOM y solo entiende la coma
 * como separador. Ademas construye un libro entero en memoria para algo que ya
 * es texto. Es literalmente "el viaje de ida y vuelta que solo puede perder
 * informacion" contra el que avisaba el comentario original de este modulo.
 *
 * @param text Contenido del fichero, ya sin BOM.
 * @param delimiter Separador de campo de un solo caracter.
 * @returns Filas con al menos un campo no vacio.
 */
export const parseDelimitedText = (
  text: string,
  delimiter: string,
): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }

      // `""` dentro de un campo entrecomillado es UNA comilla literal.
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }

      quoted = false;
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n' || char === '\r') {
      // CRLF cuenta como UN final de linea.
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows
    .map((entry) => entry.map((cell) => cell.trim()))
    .filter((entry) => entry.some((cell) => cell.length > 0));
};

/**
 * Elige el separador que produce MAS columnas en la muestra.
 *
 * No se cuenta por apariciones sueltas: una coma dentro de un campo
 * entrecomillado contaria como separador y ganaria la votacion en un fichero de
 * punto y coma. Se analiza de verdad con cada candidato y gana el ancho mayor,
 * que es la unica senal que no se deja enganar por el contenido.
 */
export const detectDelimiter = (text: string): string => {
  const sample = text.slice(0, SNIFF_CHARS);
  let best = DELIMITER_CANDIDATES[0];
  let bestWidth = 0;

  for (const candidate of DELIMITER_CANDIDATES) {
    const width = parseDelimitedText(sample, candidate).reduce(
      (max, row) => Math.max(max, row.length),
      0,
    );

    if (width > bestWidth) {
      best = candidate;
      bestWidth = width;
    }
  }

  return best;
};

/** Contenido de un fichero delimitado a matriz, detectando BOM y separador. */
export const parseDelimitedDocument = (text: string): string[][] => {
  const clean = stripBom(text);

  return parseDelimitedText(clean, detectDelimiter(clean));
};
