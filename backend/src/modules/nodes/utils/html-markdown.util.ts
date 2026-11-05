import * as cheerio from 'cheerio';

import {
  MAX_TABLE_COLUMNS,
  MIN_DATA_TABLE_ROWS,
  hasConsistentColumnCount,
  hasMinimumTableShape,
  hasShortCells,
  normalizeCellText,
  rowsToMarkdownTable,
} from '@modules/nodes/utils/markdown-table.util';

import type { CheerioAPI } from 'cheerio';

/**
 * Una seleccion de elementos de cheerio, DERIVADA de la API en vez de
 * importada.
 *
 * `cheerio` no reexporta `Element` ni `AnyNode`: viven en `domhandler`, una
 * dependencia TRANSITIVA y no declarada en el `package.json` de este proyecto.
 * Es la misma razon por la que `sanitizeEmailHtml` muta el arbol y lee
 * `.text()` en vez de recorrerlo, y por la que
 * `TemplateRendererService.auditPublishableMarkup` deja su nota.
 *
 * Declarar un `Cheerio<TNode>` generico propio tampoco sirve: `find` se declara
 * `find<T extends AnyNode>(this: Cheerio<T>, ...)` y no acepta un parametro sin
 * esa restriccion. Encadenar dos `ReturnType` sobre la propia API da
 * exactamente el tipo que hace falta sin nombrar nada de `domhandler`.
 */
export type HtmlElements = ReturnType<ReturnType<CheerioAPI['root']>['find']>;

/** Niveles de encabezado que se traducen a almohadillas de Markdown. */
const HEADING_LEVELS: readonly number[] = [1, 2, 3, 4, 5, 6];

/**
 * Texto de una celda, con los `<br>` convertidos en espacio.
 *
 * Se trabaja sobre un CLON y no sobre el arbol vivo, y es obligatorio: parte de
 * la heuristica se decide DESPUES de leer las celdas, de modo que una tabla
 * rechazada tiene que llegar intacta al aplanado de siempre. Mutar aqui
 * convertiria en espacios los `<br>` de una tabla de maquetacion de Outlook
 * —donde hoy son saltos de linea—, que es una regresion silenciosa en el caso
 * mas comun del corpus.
 */
const readCellText = (cell: HtmlElements): string => {
  const clone = cell.clone();

  clone.find('br').replaceWith(' ');

  return clone.text();
};

/** Valor de `colspan` / `rowspan`, con 1 como suelo ante cualquier basura. */
const spanOf = (cell: HtmlElements, attribute: string): number => {
  const declared = Number.parseInt(cell.attr(attribute) ?? '1', 10);

  return Number.isFinite(declared) && declared > 0 ? declared : 1;
};

/** Aplanado de una tabla rechazada: una fila por linea, celdas con espacio. */
const flattenTable = ($: CheerioAPI, table: HtmlElements): string => {
  const lines: string[] = [];

  table.find('tr').each((_rowIndex, rowElement) => {
    const cells: string[] = [];

    // Celda a celda y unidas con ESPACIO, nunca `$(tr).text()`: ese concatena
    // los textos sin separador y pegaria `Madrid` con `2026`. Es el mismo
    // criterio que `CELL_SELECTORS` aplica en `sanitizeEmailHtml`.
    $(rowElement)
      .children('td, th')
      .each((_cellIndex, cellElement) => {
        const value = normalizeCellText(readCellText($(cellElement)));

        if (value.length > 0) {
          cells.push(value);
        }
      });

    if (cells.length > 0) {
      lines.push(cells.join(' '));
    }
  });

  return lines.join('\n');
};

/**
 * Una `<table>` del marcado a Markdown GFM, SI transporta datos.
 *
 * Devuelve `null` cuando no los transporta, y ese `null` es la mitad
 * importante de la funcion: un correo de Outlook es, estructuralmente, tablas
 * anidadas de maquetacion, y convertirlas todas llenaria `clean_body` de
 * rejillas de un logotipo y un espaciador. El criterio es el mismo de
 * `SUBJECT_PREFIX_PATTERN`: falso negativo antes que falso positivo. Dejar una
 * tabla de datos aplanada es ruido; convertir una de maquetacion destruye la
 * legibilidad del cuerpo entero.
 *
 * Criterio de rechazo, en orden:
 *
 * 1. `role="presentation"`. El autor del correo ya declaro que es maquetacion.
 * 2. Contiene otra `<table>`. Una tabla que envuelve a otra es un contenedor.
 *    Esta comprobacion acota ademas el coste: solo se analizan las tablas HOJA,
 *    que son subarboles disjuntos.
 * 3. `rowspan` mayor que uno. No tiene traduccion a GFM —la celda DESAPARECE de
 *    los `<tr>` siguientes— y la rejilla se descuadraria sin arreglo posible.
 * 4. Menos de dos filas o de dos columnas.
 * 5. Alguna celda con prosa en vez de un dato.
 * 6. Recuento de columnas irregular SIN ningun `<th>`. Declarar `<th>` es una
 *    afirmacion de intencion tabular y vale por si sola; sin ella, la rejilla
 *    rectangular es la unica prueba circunstancial que queda.
 *
 * @param $ Documento cargado, el mismo del que sale `table`.
 * @param table La tabla a evaluar.
 * @returns La tabla en GFM, o `null` si no supera el criterio.
 */
export const convertHtmlTableToMarkdown = (
  $: CheerioAPI,
  table: HtmlElements,
): string | null => {
  if (table.attr('role') === 'presentation') {
    return null;
  }

  if (table.find('table').length > 0) {
    return null;
  }

  const spanned = table
    .find('[rowspan]')
    .filter((_index, element) => spanOf($(element), 'rowspan') > 1);

  if (spanned.length > 0) {
    return null;
  }

  const rows = table.find('tr');

  if (rows.length < MIN_DATA_TABLE_ROWS) {
    return null;
  }

  const matrix: string[][] = [];

  rows.each((_rowIndex, rowElement) => {
    const cells: string[] = [];

    $(rowElement)
      .children('td, th')
      .each((_cellIndex, cellElement) => {
        const cell = $(cellElement);
        const span = Math.min(spanOf(cell, 'colspan'), MAX_TABLE_COLUMNS);

        // Sin escapar: `rowsToMarkdownTable` lo hace una sola vez. Escapar
        // aqui tambien convertiria un `\|` en `\\|`.
        cells.push(normalizeCellText(readCellText(cell)));

        // Una celda combinada en horizontal ocupa varias columnas: se rellenan
        // para que las filas siguientes no se desplacen.
        for (let extra = 1; extra < span; extra += 1) {
          cells.push('');
        }
      });

    matrix.push(cells);
  });

  if (!hasMinimumTableShape(matrix) || !hasShortCells(matrix)) {
    return null;
  }

  if (table.find('th').length === 0 && !hasConsistentColumnCount(matrix)) {
    return null;
  }

  return rowsToMarkdownTable(matrix);
};

/** Texto de un bloque, colapsado a una sola linea. */
const readBlockText = (block: HtmlElements): string => {
  const clone = block.clone();

  clone.find('br').replaceWith(' ');

  return clone.text().replace(/\s+/gu, ' ').trim();
};

/**
 * El HTML que produce mammoth, a Markdown.
 *
 * Existe porque `mammoth.extractRawText` concatena las celdas de una `<table>`
 * sin ningun delimitador: un cuadro de datos dentro de un `.docx` llegaba al
 * modelo como una ristra de valores sin columna. Pasando por `convertToHtml` el
 * marcado SI declara la estructura, y de ahi se reconstruye.
 *
 * Se recorre con `.is(selector)` y nunca con `element.tagName`: `is` solo
 * necesita el envoltorio de cheerio y evita tipar el nodo.
 *
 * @param html Marcado tal y como lo entrega `mammoth.convertToHtml`.
 * @returns Bloques Markdown separados por una linea en blanco.
 */
export const convertDocumentHtmlToMarkdown = (html: string): string => {
  if (html.trim().length === 0) {
    return '';
  }

  // Misma invocacion que el resto del proyecto: `xml` como OBJETO elige
  // htmlparser2 sin activar el modo XML sensible a mayusculas, y el tercer
  // parametro `false` es el modo FRAGMENTO.
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);
  const blocks: string[] = [];

  $.root()
    .children()
    .each((_index, element) => {
      const block = $(element);

      if (block.is('table')) {
        blocks.push(
          convertHtmlTableToMarkdown($, block) ?? flattenTable($, block),
        );

        return;
      }

      const level = HEADING_LEVELS.find((candidate) =>
        block.is(`h${candidate}`),
      );

      if (level !== undefined) {
        blocks.push(`${'#'.repeat(level)} ${readBlockText(block)}`);

        return;
      }

      if (block.is('ul, ol')) {
        const ordered = block.is('ol');

        block.children('li').each((itemIndex, itemElement) => {
          const marker = ordered ? `${itemIndex + 1}.` : '-';

          blocks.push(`${marker} ${readBlockText($(itemElement))}`);
        });

        return;
      }

      blocks.push(readBlockText(block));
    });

  return blocks.filter((block) => block.length > 0).join('\n\n');
};
