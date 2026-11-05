/**
 * Tope de columnas de una tabla.
 *
 * Mas alla de esto no es la tabla de una nota de prensa sino un volcado de base
 * de datos, y cada columna se paga en tokens en CADA fila. Una hoja de calculo
 * declara hasta 16 384 columnas: sin este tope, una con formato aplicado de
 * lado a lado produciria una cabecera monstruosa antes de que ningun recorte
 * por longitud llegase a actuar.
 */
export const MAX_TABLE_COLUMNS = 24;

/**
 * Una celda de datos es corta por definicion.
 *
 * Una celda mas larga que esto es prosa, y una "tabla" de prosa es una tabla de
 * MAQUETACION. Es uno de los filtros que separan los datos del andamiaje en el
 * marcado de un correo.
 */
export const MAX_DATA_CELL_CHARS = 200;

/** Minimo de filas para aceptar que una rejilla transporta datos. */
export const MIN_DATA_TABLE_ROWS = 2;

/**
 * Minimo de columnas para lo mismo.
 *
 * Es el filtro que descarta la maquetacion de Outlook, que anida tablas de una
 * sola columna para posicionar bloques. Convertirlas produciria rejillas de una
 * columna llenas de barras verticales que solo gastan tokens del modelo.
 */
export const MIN_DATA_TABLE_COLUMNS = 2;

/** Raiz del nombre sustituto de una columna sin encabezado. */
const UNNAMED_COLUMN_PREFIX = 'COLUMNA_';

/**
 * Aviso de corte por presupuesto de caracteres.
 *
 * @param dataRowNumber Numero de fila de DATOS en la que se interrumpio, sin
 *                      contar la de encabezados.
 */
export const buildTableTruncationNotice = (dataRowNumber: number): string =>
  `[AVISO: Contenido truncado por límite de caracteres en la fila ${dataRowNumber}]`;

/**
 * Pasa a horizontal todo lo vertical de UNA celda, SIN escapar la barra.
 *
 * Se exporta separada de `escapeTableCell` porque quien construye la matriz
 * necesita medir y comparar las celdas ANTES de decidir si la rejilla merece
 * ser una tabla, y el escapado tiene que ocurrir una sola vez: aplicarlo dos
 * veces convertiria un `\|` en `\\|` y la barra volveria a leerse como
 * separador de columna.
 *
 * NO reutiliza `normalizeWhitespace` de `email-sanitizer.util`, y no es
 * duplicacion: aquella CONSERVA los saltos de linea porque separan parrafos, y
 * aqui un salto dentro de una celda rompe la rejilla —precisamente en su
 * pasada 6, `[ \t]*\n[ \t]*` -> `\n`—. Importarla crearia ademas un ciclo, ya
 * que el saneador va a importar este modulo.
 */
export const normalizeCellText = (value: string): string =>
  value
    // 1. Marcas de formato invisibles: ancho cero, juntador, BOM y el guion
    //    blando. `Cf` las cubre todas sin escribir ni un punto de codigo.
    .replace(/\p{Cf}/gu, '')
    // 2. TODO el espacio en blanco colapsa a un espacio, saltos incluidos.
    //    `\s` abarca el U+00A0 que cheerio deja al decodificar `&nbsp;` y los
    //    separadores de linea y de parrafo de Unicode, que son el caso
    //    peligroso de verdad: `normalizeWhitespace` los convierte en `\n` y
    //    partirian la fila en dos.
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * Deja una celda apta para ir dentro de una rejilla GFM.
 *
 * La barra vertical se escapa a `\|`: es el UNICO caracter que puede romper la
 * rejilla, porque GFM la lee como separador de columna.
 *
 * El salto de linea se sustituye por ESPACIO y no por `<br>`. Dos motivos, y el
 * segundo es el decisivo: (1) `<br>` cuesta cuatro caracteres por salto en un
 * texto que se mide contra `MAX_EXTRACTED_DOCUMENT_CHARS`; (2) en la ruta del
 * correo este Markdown vuelve al arbol de cheerio, y el paso
 * `$('br').replaceWith('\n')` que corre justo despues convertiria ese `<br>` en
 * un salto de linea DENTRO de la tabla, que es exactamente lo que se evita.
 */
export const escapeTableCell = (value: string): string =>
  normalizeCellText(value).replace(/\|/g, '\\|');

/**
 * Nombra y desambigua la fila de encabezado.
 *
 * El caso real que lo motiva: una hoja con las columnas
 * `PRESIDENTE, PRESIDENTE, SECRETARIO, SECRETARIO`, donde la primera de cada
 * par es el nombre de la persona y la segunda su universidad. Aplanadas con un
 * separador, el modelo no puede saber cual es cual; con el sufijo ordinal,
 * `PRESIDENTE (1)` y `PRESIDENTE (2)` quedan referenciables.
 *
 * DOS PASADAS a proposito. Solo recibe sufijo el encabezado que aparece mas de
 * una vez: marcar una columna unica como `PRESIDENTE (1)` seria inventar un
 * nombre que la hoja NO tiene, y el destinatario de este texto es un modelo que
 * va a citar el encabezado literalmente. El sufijo DESAMBIGUA; cuando no hay
 * nada que desambiguar, sobra. Eso obliga a contar antes de renombrar.
 *
 * El hueco se nombra ANTES de contar, no despues: asi un encabezado literal
 * `COLUMNA_2` que colisione con el hueco de la columna 2 tambien se desambigua.
 *
 * La comparacion es exacta sobre el texto recortado, sin plegar mayusculas:
 * `Presidente` y `PRESIDENTE` son dos columnas distintas. Es lo predecible para
 * quien mira la hoja de calculo, que es quien tiene que entender la salida.
 *
 * @param rawHeaders Encabezados ya saneados, en su orden de columna.
 * @returns Un nombre por columna, siempre no vacio y siempre unico.
 */
export const buildHeaderNames = (
  rawHeaders: readonly string[],
): readonly string[] => {
  // El hueco toma el indice 1-based, que es el mismo numero de columna que el
  // operador ve en la cabecera de la hoja de calculo.
  const named = rawHeaders.map((header, index) =>
    header.length > 0 ? header : `${UNNAMED_COLUMN_PREFIX}${index + 1}`,
  );

  const totals = new Map<string, number>();

  for (const name of named) {
    totals.set(name, (totals.get(name) ?? 0) + 1);
  }

  const assigned = new Map<string, number>();

  return named.map((name) => {
    if ((totals.get(name) ?? 0) < 2) {
      return name;
    }

    const occurrence = (assigned.get(name) ?? 0) + 1;

    assigned.set(name, occurrence);

    return `${name} (${occurrence})`;
  });
};

/**
 * Serializa una fila YA SANEADA como `| a | b |`.
 *
 * La celda vacia se emite como `| |` y NO como `|  |`. No es cosmetica: la
 * pasada 5 de `normalizeWhitespace` colapsa `[ \t]+` a un espacio, de modo que
 * el doble espacio se perderia igual y el texto dejaria de ser identico a si
 * mismo despues de normalizar. Emitirlo ya colapsado hace la tabla IDEMPOTENTE
 * bajo esa funcion, que es la unica garantia de que sobrevive al pipeline.
 *
 * Tampoco hay relleno de alineacion por el mismo motivo, y las barras exterior
 * izquierda y derecha van pegadas al contenido para que la pasada 6
 * (`[ \t]*\n[ \t]*` -> `\n`) no tenga nada que recortar.
 */
export const buildMarkdownRow = (cells: readonly string[]): string =>
  `|${cells.map((cell) => (cell.length > 0 ? ` ${cell} ` : ' ')).join('|')}|`;

/** Ancho real de la matriz: el maximo de todas sus filas. */
export const matrixWidth = (rows: readonly (readonly string[])[]): number =>
  rows.reduce((max, row) => Math.max(max, row.length), 0);

/** Dos filas y dos columnas: el minimo para que una rejilla sea una tabla. */
export const hasMinimumTableShape = (
  rows: readonly (readonly string[])[],
): boolean =>
  rows.length >= MIN_DATA_TABLE_ROWS &&
  matrixWidth(rows) >= MIN_DATA_TABLE_COLUMNS;

/** Todas las filas declaran el MISMO numero de celdas. */
export const hasConsistentColumnCount = (
  rows: readonly (readonly string[])[],
): boolean => rows.every((row) => row.length === rows[0].length);

/** Ninguna celda contiene prosa en vez de un dato. */
export const hasShortCells = (rows: readonly (readonly string[])[]): boolean =>
  rows.every((row) => row.every((cell) => cell.length <= MAX_DATA_CELL_CHARS));

/**
 * Ajusta una fila al ancho de la rejilla.
 *
 * Rellenar con cadena vacia y recortar el exceso es lo que garantiza que TODAS
 * las lineas tengan el mismo numero de barras. Una fila mas corta desplazaria
 * los valores siguientes a la columna equivocada, que es exactamente el fallo
 * que este modulo existe para evitar.
 */
const normalizeRowWidth = (
  cells: readonly string[],
  width: number,
): readonly string[] =>
  Array.from({ length: width }, (_unused, index) => cells[index] ?? '');

/**
 * Matriz en CRUDO a tabla GFM. La primera fila es siempre el encabezado.
 *
 * El saneado y la desambiguacion ocurren aqui dentro, de modo que el llamante
 * nunca tiene que acordarse de aplicarlos; aplicarlos dos veces convertiria un
 * `\|` escapado en `\\|` y la barra volveria a leerse como separador.
 *
 * @param rows Filas sin sanear; la primera es la de encabezados.
 * @param maxChars Presupuesto opcional de caracteres. Cuando se alcanza se
 *                 INTERRUMPE la iteracion en una frontera de fila y se anade el
 *                 aviso de corte. Nunca se emite media fila: una rejilla GFM
 *                 con una linea coja deja de ser una tabla para cualquier
 *                 lector, que es justo lo que un `slice()` sobre el texto final
 *                 no puede evitar.
 * @returns La tabla, o cadena vacia si no habia encabezados.
 */
export const rowsToMarkdownTable = (
  rows: readonly (readonly string[])[],
  maxChars = Number.POSITIVE_INFINITY,
): string => {
  if (rows.length === 0) {
    return '';
  }

  const width = matrixWidth(rows);

  if (width === 0) {
    return '';
  }

  const headers = buildHeaderNames(
    normalizeRowWidth(rows[0], width).map(escapeTableCell),
  );

  const lines = [
    buildMarkdownRow(headers),
    buildMarkdownRow(headers.map(() => '---')),
  ];

  // Longitud acumulada contando los saltos que uniran las lineas.
  let length = lines.reduce((total, line) => total + line.length + 1, 0);

  for (let index = 1; index < rows.length; index += 1) {
    const line = buildMarkdownRow(
      normalizeRowWidth(rows[index], width).map(escapeTableCell),
    );

    if (length + line.length + 1 > maxChars) {
      lines.push('', buildTableTruncationNotice(index));

      return lines.join('\n');
    }

    lines.push(line);
    length += line.length + 1;
  }

  return lines.join('\n');
};

/**
 * Aplanado heredado: una fila por linea, celdas separadas por coma.
 *
 * Se CONSERVA como red. Una hoja de una sola columna o una rejilla
 * irreconocible no ganan nada envueltas en barras verticales, y perder el
 * comportamiento anterior en esos casos seria una regresion sin contrapartida.
 */
export const rowsToFlatText = (rows: readonly (readonly string[])[]): string =>
  rows
    .map((row) => row.filter((cell) => cell.length > 0).join(', '))
    .filter((line) => line.length > 0)
    .join('\n');
