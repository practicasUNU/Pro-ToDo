import * as cheerio from 'cheerio';

import {
  convertDocumentHtmlToMarkdown,
  convertHtmlTableToMarkdown,
} from './html-markdown.util';
import { MAX_DATA_CELL_CHARS } from './markdown-table.util';

import type { CheerioAPI } from 'cheerio';

/** Carga un fragmento igual que lo hace `sanitizeEmailHtml`. */
const load = (html: string): CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** Atajo: convierte la primera `<table>` del fragmento. */
const convertFirstTable = (html: string): string | null => {
  const $ = load(html);

  return convertHtmlTableToMarkdown($, $('table').first());
};

/** Tabla de datos canonica: dos filas, dos columnas, rejilla regular. */
const DATA_TABLE =
  '<table>' +
  '<tr><th>Ciudad</th><th>Empleos</th></tr>' +
  '<tr><td>Madrid</td><td>200</td></tr>' +
  '</table>';

describe('html-markdown.util', () => {
  describe('0. convertHtmlTableToMarkdown: aceptacion', () => {
    it('0.1 deberia convertir una tabla con <th> a GFM', () => {
      // 1. Arrange / 2. Act
      const result = convertFirstTable(DATA_TABLE);

      // 3. Assert
      expect(result).toBe(
        '| Ciudad | Empleos |\n| --- | --- |\n| Madrid | 200 |',
      );
    });

    it('0.2 deberia aceptar una rejilla regular sin <th>', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><td>Ciudad</td><td>Empleos</td></tr>' +
        '<tr><td>Madrid</td><td>200</td></tr>' +
        '</table>';

      // 2. Act
      const result = convertFirstTable(html);

      // 3. Assert
      expect(result).toContain('| Ciudad | Empleos |');
      expect(result).toContain('| Madrid | 200 |');
    });

    it('0.3 deberia rellenar las columnas que ocupa un colspan', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><th>A</th><th>B</th><th>C</th></tr>' +
        '<tr><td colspan="2">Fusionada</td><td>Suelta</td></tr>' +
        '</table>';

      // 2. Act
      const result = convertFirstTable(html);

      // 3. Assert
      expect(result).toContain('| Fusionada | | Suelta |');
    });

    it('0.4 deberia convertir un <br> de celda en espacio sin partir la fila', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><th>Ciudad</th><th>Nota</th></tr>' +
        '<tr><td>Madrid</td><td>Primera<br>Segunda</td></tr>' +
        '</table>';

      // 2. Act
      const result = convertFirstTable(html);

      // 3. Assert
      expect(result).toContain('| Primera Segunda |');
      expect(result?.split('\n')).toHaveLength(3);
    });

    it('0.5 deberia escapar una barra vertical que venga en una celda', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><th>A</th><th>B</th></tr>' +
        '<tr><td>uno | dos</td><td>tres</td></tr>' +
        '</table>';

      // 2. Act
      const result = convertFirstTable(html);

      // 3. Assert
      expect(result).toContain('| uno \\| dos | tres |');
    });
  });

  describe('1. convertHtmlTableToMarkdown: rechazo', () => {
    it('1.1 deberia rechazar una tabla marcada como presentacion', () => {
      // 1. Arrange: el autor del correo ya declaro que es maquetacion.
      const html = DATA_TABLE.replace('<table>', '<table role="presentation">');

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.2 deberia rechazar una tabla que contiene otra tabla', () => {
      // 1. Arrange: el andamiaje tipico de un correo de Outlook.
      const html = `<table><tr><td>${DATA_TABLE}</td></tr></table>`;

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.3 deberia rechazar una tabla de una sola fila', () => {
      // 1. Arrange: es una linea de texto con celdas, no una tabla.
      const html = '<table><tr><td>Madrid</td><td>2026</td></tr></table>';

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.4 deberia rechazar una tabla de una sola columna', () => {
      // 1. Arrange: la maquetacion vertical de Outlook.
      const html =
        '<table><tr><td>Titular</td></tr><tr><td>Cuerpo</td></tr></table>';

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.5 deberia rechazar un rowspan, que GFM no sabe representar', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><th>A</th><th>B</th></tr>' +
        '<tr><td rowspan="2">Fusionada</td><td>uno</td></tr>' +
        '<tr><td>dos</td></tr>' +
        '</table>';

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.6 deberia rechazar una rejilla irregular sin <th>', () => {
      // 1. Arrange
      const html =
        '<table>' +
        '<tr><td>a</td><td>b</td></tr>' +
        '<tr><td>solo una</td></tr>' +
        '<tr><td>x</td><td>y</td></tr>' +
        '</table>';

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.7 deberia rechazar una tabla cuyas celdas contienen prosa', () => {
      // 1. Arrange: una "tabla" de parrafos es maquetacion.
      const prose = 'palabra '.repeat(MAX_DATA_CELL_CHARS);
      const html =
        '<table>' +
        '<tr><th>A</th><th>B</th></tr>' +
        `<tr><td>${prose}</td><td>corto</td></tr>` +
        '</table>';

      // 2. Act / 3. Assert
      expect(convertFirstTable(html)).toBeNull();
    });

    it('1.8 NO deberia mutar el arbol cuando rechaza la tabla', () => {
      // 1. Arrange: la heuristica se decide DESPUES de leer las celdas. Si la
      //    lectura mutase el arbol vivo, los `<br>` de una tabla de
      //    maquetacion rechazada ya no serian elementos y `sanitizeEmailHtml`
      //    dejaria de convertirlos en saltos de linea.
      const $ = load(
        '<table><tr><td>Uno<br>Dos</td></tr><tr><td>Tres</td></tr></table>',
      );

      // 2. Act
      const result = convertHtmlTableToMarkdown($, $('table').first());

      // 3. Assert
      expect(result).toBeNull();
      expect($('br')).toHaveLength(1);
    });
  });

  describe('2. convertDocumentHtmlToMarkdown', () => {
    it('2.1 deberia traducir los encabezados a almohadillas', () => {
      // 1. Arrange
      const html = '<h1>Titular</h1><h3>Subtitulo</h3>';

      // 2. Act
      const result = convertDocumentHtmlToMarkdown(html);

      // 3. Assert
      expect(result).toBe('# Titular\n\n### Subtitulo');
    });

    it('2.2 deberia separar los parrafos con una linea en blanco', () => {
      // 1. Arrange
      const html = '<p>Uno</p><p>Dos</p>';

      // 2. Act
      const result = convertDocumentHtmlToMarkdown(html);

      // 3. Assert
      expect(result).toBe('Uno\n\nDos');
    });

    it('2.3 deberia traducir listas ordenadas y sin ordenar', () => {
      // 1. Arrange
      const html = '<ul><li>Uno</li><li>Dos</li></ul><ol><li>Primero</li></ol>';

      // 2. Act
      const result = convertDocumentHtmlToMarkdown(html);

      // 3. Assert
      expect(result).toContain('- Uno');
      expect(result).toContain('- Dos');
      expect(result).toContain('1. Primero');
    });

    it('2.4 deberia emitir una tabla de datos como rejilla GFM', () => {
      // 1. Arrange: es el motivo de pasar por `convertToHtml` en vez de por
      //    `extractRawText`, que concatenaba las celdas sin delimitador.
      const html = `<p>Antes</p>${DATA_TABLE}`;

      // 2. Act
      const result = convertDocumentHtmlToMarkdown(html);

      // 3. Assert
      expect(result).toContain('| Ciudad | Empleos |');
      expect(result).toContain('| --- | --- |');
    });

    it('2.5 deberia aplanar la tabla que no supera la heuristica', () => {
      // 1. Arrange
      const html = '<table><tr><td>Madrid</td><td>2026</td></tr></table>';

      // 2. Act
      const result = convertDocumentHtmlToMarkdown(html);

      // 3. Assert
      expect(result).toBe('Madrid 2026');
    });

    it('2.6 deberia devolver cadena vacia ante un marcado vacio', () => {
      // 1. Arrange / 2. Act / 3. Assert
      expect(convertDocumentHtmlToMarkdown('   ')).toBe('');
    });
  });
});
