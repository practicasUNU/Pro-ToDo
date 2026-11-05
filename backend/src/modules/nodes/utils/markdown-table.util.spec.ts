import {
  MAX_DATA_CELL_CHARS,
  buildHeaderNames,
  buildMarkdownRow,
  buildTableTruncationNotice,
  escapeTableCell,
  hasConsistentColumnCount,
  hasMinimumTableShape,
  hasShortCells,
  rowsToFlatText,
  rowsToMarkdownTable,
} from './markdown-table.util';
import { normalizeWhitespace } from './email-sanitizer.util';

/** Espacio duro que cheerio deja al decodificar `&nbsp;`. */
const NBSP = String.fromCharCode(0x00a0);
/** Separador de linea de Unicode: el caracter que de verdad parte una fila. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
/** Espacio de ancho cero. */
const ZERO_WIDTH = String.fromCharCode(0x200b);

describe('markdown-table.util', () => {
  describe('0. escapeTableCell', () => {
    it('0.1 deberia escapar la barra vertical que rompe la rejilla', () => {
      // 1. Arrange
      const value = 'Madrid | Barcelona';

      // 2. Act
      const result = escapeTableCell(value);

      // 3. Assert
      expect(result).toBe('Madrid \\| Barcelona');
    });

    it('0.2 deberia convertir los saltos de linea en espacio', () => {
      // 1. Arrange: con un `\n` dentro, la fila se partiria en dos lineas y la
      //    tabla dejaria de ser una tabla.
      const value = 'Primera\nSegunda\r\nTercera';

      // 2. Act
      const result = escapeTableCell(value);

      // 3. Assert
      expect(result).toBe('Primera Segunda Tercera');
    });

    it('0.3 deberia neutralizar el separador de linea de Unicode', () => {
      // 1. Arrange: `normalizeWhitespace` lo convierte en `\n` mas adelante,
      //    asi que dejarlo pasar romperia la tabla despues de construirla.
      const value = `Antes${LINE_SEPARATOR}Despues`;

      // 2. Act
      const result = escapeTableCell(value);

      // 3. Assert
      expect(result).toBe('Antes Despues');
    });

    it('0.4 deberia colapsar el espacio duro y borrar los invisibles', () => {
      // 1. Arrange
      const value = `Nueva${NBSP}${NBSP}sede${ZERO_WIDTH}`;

      // 2. Act
      const result = escapeTableCell(value);

      // 3. Assert
      expect(result).toBe('Nueva sede');
    });
  });

  describe('1. buildHeaderNames', () => {
    it('1.1 NO deberia sufijar un encabezado que aparece una sola vez', () => {
      // 1. Arrange: el sufijo DESAMBIGUA; sin nada que desambiguar inventaria
      //    un nombre de columna que la hoja no tiene.
      const headers = ['PRESIDENTE', 'SECRETARIO'];

      // 2. Act
      const result = buildHeaderNames(headers);

      // 3. Assert
      expect(result).toEqual(['PRESIDENTE', 'SECRETARIO']);
    });

    it('1.2 deberia sufijar ordinalmente los encabezados repetidos', () => {
      // 1. Arrange: el caso real de "Paneles de septiembre 2026-WEB.xlsx",
      //    donde la columna 6 es el nombre y la 7 la universidad.
      const headers = ['PRESIDENTE', 'PRESIDENTE', 'SECRETARIO', 'SECRETARIO'];

      // 2. Act
      const result = buildHeaderNames(headers);

      // 3. Assert
      expect(result).toEqual([
        'PRESIDENTE (1)',
        'PRESIDENTE (2)',
        'SECRETARIO (1)',
        'SECRETARIO (2)',
      ]);
    });

    it('1.3 deberia nombrar el hueco con su numero de columna 1-based', () => {
      // 1. Arrange
      const headers = ['TITULO', '', 'FECHA'];

      // 2. Act
      const result = buildHeaderNames(headers);

      // 3. Assert
      expect(result).toEqual(['TITULO', 'COLUMNA_2', 'FECHA']);
    });

    it('1.4 deberia desambiguar un literal que colisione con un hueco', () => {
      // 1. Arrange: el hueco se nombra ANTES de contar, asi que la colision
      //    entra en el recuento y las dos columnas quedan distinguibles.
      const headers = ['COLUMNA_2', ''];

      // 2. Act
      const result = buildHeaderNames(headers);

      // 3. Assert
      expect(result).toEqual(['COLUMNA_2 (1)', 'COLUMNA_2 (2)']);
    });
  });

  describe('2. rowsToMarkdownTable', () => {
    it('2.1 deberia emitir encabezado, divisoria y filas de datos', () => {
      // 1. Arrange
      const rows = [
        ['titulo', 'empleos'],
        ['Nueva sede', '200'],
      ];

      // 2. Act
      const result = rowsToMarkdownTable(rows);

      // 3. Assert
      expect(result).toBe(
        '| titulo | empleos |\n| --- | --- |\n| Nueva sede | 200 |',
      );
    });

    it('2.2 deberia emitir la celda vacia como "| |" y no como "|  |"', () => {
      // 1. Arrange: el doble espacio lo colapsaria `normalizeWhitespace`, y la
      //    tabla dejaria de ser identica a si misma tras normalizar.
      const rows = [
        ['a', 'b'],
        ['', 'dos'],
      ];

      // 2. Act
      const result = rowsToMarkdownTable(rows);

      // 3. Assert
      expect(result).toContain('| | dos |');
      expect(result).not.toContain('|  |');
    });

    it('2.3 deberia rellenar la fila corta hasta el ancho de la rejilla', () => {
      // 1. Arrange: sin relleno, los valores siguientes caerian en la columna
      //    equivocada, que es el fallo que este modulo existe para evitar.
      const rows = [['a', 'b', 'c'], ['uno']];

      // 2. Act
      const result = rowsToMarkdownTable(rows);

      // 3. Assert
      const dataRow = result.split('\n')[2];

      expect(dataRow).toBe('| uno | | |');
      expect(dataRow.split('|')).toHaveLength(5);
    });

    it('2.4 deberia aceptar una matriz vacia sin lanzar', () => {
      // 1. Arrange / 2. Act
      const result = rowsToMarkdownTable([]);

      // 3. Assert
      expect(result).toBe('');
    });
  });

  describe('3. Corte por presupuesto de caracteres', () => {
    it('3.1 deberia interrumpir en una frontera de fila, nunca a la mitad', () => {
      // 1. Arrange: veinte filas que no caben en el presupuesto.
      const rows = [
        ['columna_a', 'columna_b'],
        ...Array.from({ length: 20 }, (_unused, index) => [
          `valor-a-${index}`,
          `valor-b-${index}`,
        ]),
      ];

      // 2. Act
      const result = rowsToMarkdownTable(rows, 120);

      // 3. Assert: toda linea de rejilla esta cerrada por sus dos barras.
      const gridLines = result
        .split('\n')
        .filter((line) => line.startsWith('|'));

      for (const line of gridLines) {
        expect(line.endsWith('|')).toBe(true);
        expect(line.split('|')).toHaveLength(4);
      }
    });

    it('3.2 deberia anadir el aviso con la fila de datos en la que corto', () => {
      // 1. Arrange
      const rows = [
        ['a', 'b'],
        ['uno', 'dos'],
        ['tres', 'cuatro'],
        ['cinco', 'seis'],
      ];

      // 2. Act: presupuesto suficiente para el encabezado y una fila.
      const result = rowsToMarkdownTable(rows, 45);

      // 3. Assert
      expect(result).toContain('| uno | dos |');
      expect(result).not.toContain('| tres | cuatro |');
      expect(result).toContain(buildTableTruncationNotice(2));
    });

    it('3.3 NO deberia anadir aviso cuando la tabla cabe entera', () => {
      // 1. Arrange
      const rows = [
        ['a', 'b'],
        ['uno', 'dos'],
      ];

      // 2. Act
      const result = rowsToMarkdownTable(rows, 10_000);

      // 3. Assert
      expect(result).not.toContain('AVISO');
    });
  });

  describe('4. Invariante de normalizacion', () => {
    it('4.1 deberia ser idempotente bajo normalizeWhitespace', () => {
      // 1. Arrange: es LA garantia de que la tabla sobrevive al pipeline. Si
      //    alguien anade relleno de alineacion "para que se lea mejor", la
      //    pasada 5 de `normalizeWhitespace` lo colapsa y esta prueba lo
      //    detecta antes de que lo haga un correo en produccion.
      const rows = [
        ['titulo', '', 'empleos'],
        [`Nueva${NBSP}sede`, 'a | b', '200'],
        ['', 'Linea\ncortada', ''],
      ];

      // 2. Act
      const table = rowsToMarkdownTable(rows);

      // 3. Assert
      expect(normalizeWhitespace(table)).toBe(table);
    });

    it('4.2 deberia conservar una fila por linea tras normalizar', () => {
      // 1. Arrange
      const rows = [
        ['a', 'b'],
        ['uno', 'dos'],
        ['tres', 'cuatro'],
      ];

      // 2. Act
      const normalized = normalizeWhitespace(rowsToMarkdownTable(rows));

      // 3. Assert
      expect(normalized.split('\n')).toHaveLength(4);
    });
  });

  describe('5. Predicados de forma', () => {
    it('5.1 deberia exigir dos filas y dos columnas', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(
        hasMinimumTableShape([
          ['a', 'b'],
          ['uno', 'dos'],
        ]),
      ).toBe(true);
      expect(hasMinimumTableShape([['a', 'b']])).toBe(false);
      expect(hasMinimumTableShape([['a'], ['uno']])).toBe(false);
    });

    it('5.2 deberia detectar un recuento de columnas irregular', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(
        hasConsistentColumnCount([
          ['a', 'b'],
          ['uno', 'dos'],
        ]),
      ).toBe(true);
      expect(hasConsistentColumnCount([['a', 'b'], ['uno']])).toBe(false);
    });

    it('5.3 deberia rechazar la celda que contiene prosa', () => {
      // 1. Arrange
      const prose = 'x'.repeat(MAX_DATA_CELL_CHARS + 1);

      // 2. Act / 3. Assert
      expect(
        hasShortCells([
          ['a', 'b'],
          ['uno', 'dos'],
        ]),
      ).toBe(true);
      expect(
        hasShortCells([
          ['a', 'b'],
          [prose, 'dos'],
        ]),
      ).toBe(false);
    });
  });

  describe('6. rowsToFlatText', () => {
    it('6.1 deberia conservar el aplanado heredado separado por comas', () => {
      // 1. Arrange: la red para las rejillas que no merecen ser una tabla.
      const rows = [
        ['titulo', 'empleos'],
        ['Nueva sede', '200'],
      ];

      // 2. Act
      const result = rowsToFlatText(rows);

      // 3. Assert
      expect(result).toBe('titulo, empleos\nNueva sede, 200');
    });

    it('6.2 deberia descartar las filas sin ningun valor', () => {
      // 1. Arrange
      const rows = [['titulo'], ['', ''], ['Nueva sede']];

      // 2. Act
      const result = rowsToFlatText(rows);

      // 3. Assert
      expect(result).toBe('titulo\nNueva sede');
    });
  });
});

/** Fija el formato de una fila suelta, usado por el resto de los bloques. */
describe('buildMarkdownRow', () => {
  it('deberia pegar las barras al contenido', () => {
    // 1. Arrange / 2. Act / 3. Assert
    expect(buildMarkdownRow(['a', 'b'])).toBe('| a | b |');
  });
});
