import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Workbook } from 'exceljs';

import type { Worksheet } from 'exceljs';

import {
  DOCX_CONTENT_TYPE,
  MAX_EXTRACTED_DOCUMENT_CHARS,
  PDF_CONTENT_TYPE,
  TRUNCATION_NOTICE,
  PPTX_CONTENT_TYPE,
  XLSX_CONTENT_TYPE,
  convertWorksheetToMarkdownTable,
  extractTextFromBuffer,
} from './document-extractor.util';
import { buildTableTruncationNotice } from './markdown-table.util';

/**
 * PDF real de una pagina con texto nativo seleccionable.
 *
 * Es un fichero versionado y no un PDF construido dentro de la prueba:
 * `pdf-parse@1.1.1` empaqueta pdf.js v1.10, cuya recuperacion de una tabla
 * `xref` imperfecta es heuristica, y un PDF hecho a mano acababa devolviendo
 * texto vacio segun cual fuera la cadena del fixture. Un fichero producido por
 * una herramienta real no deja esa puerta abierta.
 *
 * Su fuente PostScript se versiona al lado (`nota-nativa.ps`, cuatro lineas
 * legibles) precisamente para que el binario no sea opaco en una revision. Se
 * regenera con:
 *
 * ```
 * gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 \
 *    -dEmbedAllFonts=false -dSubsetFonts=false -dPDFSETTINGS=/prepress \
 *    -sOutputFile=nota-nativa.pdf nota-nativa.ps
 * ```
 *
 * PROHIBIDO anadir `-dOmitID` o `-dOmitXMP` al regenerarlo: pdf.js v1.10 deja
 * de extraer texto de este documento sin el `/ID` del trailer, y sin el bloque
 * XMP falla solo bajo Jest. Se comprobo variante a variante.
 *
 * La ruta se arma con `__dirname` y no con `process.cwd()` para que no dependa
 * del directorio desde el que se lance la suite. No es una importacion de
 * modulo, asi que no le aplica el alias `@test/*`.
 */
const NATIVE_PDF_PATH = join(
  __dirname,
  '../../../../test/fixtures/nota-nativa.pdf',
);

/** Aviso que se emite si el fixture llega convertido a CRLF. */
const CRLF_FIXTURE_WARNING =
  '[document-extractor.spec] nota-nativa.pdf llega con CRLF (checkout anterior a ' +
  '.gitattributes): se restaura a LF para la prueba. Renormaliza el checkout con ' +
  '`git rm --cached -r . && git reset --hard` (descarta cambios locales).';

/**
 * Deshace la conversion LF -> CRLF que `core.autocrlf=true` aplica en Windows.
 *
 * POR QUE. `nota-nativa.pdf` no contiene ningun byte NUL, asi que Git lo trata
 * como texto si `.gitattributes` no lo declara `binary` (un clon anterior a
 * esa regla). Sus 84 saltos de linea pasan a CRLF, los offsets de la tabla
 * `xref` / `startxref` quedan desplazados y pdf.js lo rechaza
 * (`bad XRef entry`): la prueba fallaba por el checkout, no por el extractor.
 *
 * Es EXACTO solo porque el fixture original no contiene ningun `\r`: cambiar
 * `\r\n` por `\n` devuelve el fichero byte a byte. Si se regenera con un
 * `\r` legitimo, este helper deja de ser valido. `latin1` conserva cada byte en
 * el viaje Buffer -> string -> Buffer.
 */
const restoreLfLineEndings = (buffer: Buffer): Buffer =>
  Buffer.from(buffer.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');

/** Convierte LF a CRLF: reproduce el fixture tal como llega a un checkout de Windows. */
const toCrlfLineEndings = (buffer: Buffer): Buffer =>
  Buffer.from(buffer.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');

/**
 * Lee el PDF nativo restaurandolo a LF si hace falta. No oculta la corrupcion:
 * avisa por consola para que el checkout se renormalice.
 */
const readNativePdfFixture = (): Buffer => {
  const buffer = readFileSync(NATIVE_PDF_PATH);

  if (!buffer.includes('\r\n')) {
    return buffer;
  }

  console.warn(CRLF_FIXTURE_WARNING);
  return restoreLfLineEndings(buffer);
};

/** Word minimo con encabezado, parrafo y una tabla de 3x2. */
const DOCX_PATH = join(
  __dirname,
  '../../../../test/fixtures/tabla-simple.docx',
);

/** Presentacion de una diapositiva con dos formas de texto. */
const PPTX_PATH = join(
  __dirname,
  '../../../../test/fixtures/presentacion-minima.pptx',
);

/** Una hoja de un libro de prueba. */
interface SheetFixture {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

/** Construye un `.xlsx` real con `exceljs`, la misma libreria que lo leera. */
const buildWorkbook = async (
  sheets: readonly SheetFixture[],
): Promise<Buffer> => {
  const workbook = new Workbook();

  for (const { name, rows } of sheets) {
    const sheet = workbook.addWorksheet(name);

    for (const row of rows) {
      sheet.addRow([...row]);
    }
  }

  const written = await workbook.xlsx.writeBuffer();

  return Buffer.from(written);
};

/** Atajo de una sola hoja, que es el caso de la mayoria de las pruebas. */
const buildXlsx = async (
  rows: readonly (readonly string[])[],
): Promise<Buffer> => buildWorkbook([{ name: 'Datos', rows }]);

/** Carga la primera hoja de un buffer para ejercitar el serializador solo. */
const loadFirstWorksheet = async (buffer: Buffer): Promise<Worksheet> => {
  const workbook = new Workbook();

  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );

  return workbook.worksheets[0];
};

describe('document-extractor.util', () => {
  describe('0. Texto plano y CSV', () => {
    it('0.1 deberia decodificar text/plain como UTF-8', async () => {
      // 1. Arrange
      const buffer = Buffer.from(
        'Nota de prensa con acentuacion: informacion.',
        'utf-8',
      );

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert
      expect(result.text).toBe('Nota de prensa con acentuacion: informacion.');
      expect(result.failure).toBeNull();
    });

    it('0.2 deberia convertir un CSV tabular en una tabla Markdown', async () => {
      // 1. Arrange: aplanado a texto, una celda con coma interna rompia el
      //    delimitador y el modelo perdia la columna.
      const csv = 'titulo,fecha\n"Nueva sede, Madrid",2026-03-01';
      const buffer = Buffer.from(csv, 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/csv');

      // 3. Assert
      expect(result.text).toBe(
        '| titulo | fecha |\n| --- | --- |\n| Nueva sede, Madrid | 2026-03-01 |',
      );
      expect(result.failure).toBeNull();
    });

    it('0.3 deberia devolver tal cual un CSV de una sola columna', async () => {
      // 1. Arrange: envolver una columna en barras verticales no anade
      //    informacion y si gasta tokens. Conserva el espiritu del 0.2 previo.
      const csv = 'titulo\nNueva sede';
      const buffer = Buffer.from(csv, 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/csv');

      // 3. Assert
      expect(result.text).toBe(csv);
    });

    it('0.4 deberia entender el punto y coma de un CSV de Excel espanol', async () => {
      // 1. Arrange
      const buffer = Buffer.from('titulo;ciudad\nNueva sede;Madrid', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/csv');

      // 3. Assert
      expect(result.text).toContain('| titulo | ciudad |');
      expect(result.text).toContain('| Nueva sede | Madrid |');
    });

    it('0.5 NO deberia perder los ceros a la izquierda de un codigo', async () => {
      // 1. Arrange: `exceljs.csv.read` devolveria 123 y el codigo postal se
      //    perderia. Es la prueba que justifica el analizador propio.
      const buffer = Buffer.from('cp,ciudad\n00123,Madrid', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/csv');

      // 3. Assert
      expect(result.text).toContain('| 00123 | Madrid |');
    });
  });

  describe('1. PDF con texto nativo', () => {
    it('1.1 deberia extraer el texto sin OCR', async () => {
      // 1. Arrange
      const buffer = readNativePdfFixture();

      // 2. Act
      const result = await extractTextFromBuffer(buffer, PDF_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('Nota de prensa institucional de UNUWARE');
      expect(result.failure).toBeNull();
    });

    it('1.1.1 deberia extraer el texto aunque el fixture llegue con CRLF', async () => {
      // 1. Arrange: el PDF tal como lo deja un checkout de Windows anterior a
      //    `.gitattributes` (sin restaurar, pdf.js responde `bad XRef entry`).
      const original = readNativePdfFixture();
      const restored = restoreLfLineEndings(toCrlfLineEndings(original));

      // 2. Act
      const result = await extractTextFromBuffer(restored, PDF_CONTENT_TYPE);

      // 3. Assert: la restauracion es exacta y el extractor lee el documento.
      expect(restored.equals(original)).toBe(true);
      expect(result.failure).toBeNull();
      expect(result.text).toContain('Nota de prensa institucional de UNUWARE');
    });

    it('1.1.2 no deberia alterar un buffer que ya esta en LF', () => {
      // 1. Arrange
      const original = readFileSync(NATIVE_PDF_PATH);

      // 2. Act
      const restored = restoreLfLineEndings(original);

      // 3. Assert: sin `\r\n` no hay nada que cambiar.
      expect(original.includes('\r\n')).toBe(false);
      expect(restored.equals(original)).toBe(true);
    });

    it('1.2 deberia devolver el motivo, y no lanzar, ante un PDF corrupto', async () => {
      // 1. Arrange: el motor normaliza toda excepcion a URGENTE, que `canRetry`
      //    nunca reintenta. Un adjunto ilegible no puede tumbar la ejecucion.
      const buffer = Buffer.from('%PDF-1.4 esto no es un PDF', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, PDF_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).not.toBeNull();
    });
  });

  describe('2. Hojas de calculo', () => {
    it('2.1 deberia convertir un .xlsx en una tabla Markdown', async () => {
      // 1. Arrange
      const buffer = await buildXlsx([
        ['titulo', 'empleos'],
        ['Nueva sede', '200'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe(
        '| titulo | empleos |\n| --- | --- |\n| Nueva sede | 200 |',
      );
      expect(result.failure).toBeNull();
      expect(result.label).toBe('Hoja: Datos');
    });

    it('2.2 deberia devolver el motivo ante un .xlsx ilegible', async () => {
      // 1. Arrange
      const buffer = Buffer.from('PK esto no es un zip valido', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).not.toBeNull();
    });
  });

  describe('3. Documentos de Word', () => {
    it('3.1 deberia devolver el motivo ante un .docx ilegible', async () => {
      // 1. Arrange: un `.docx` es un zip, y este no lo es.
      const buffer = Buffer.from('no soy un docx', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, DOCX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).not.toBeNull();
    });
  });

  describe('4. Imagenes: CERO OCR', () => {
    it.each(['image/png', 'image/jpeg', 'image/webp'])(
      '4.1 deberia devolver cadena vacia para %s sin tocar el buffer',
      async (contentType) => {
        // 1. Arrange: este nodo no hace OCR por contrato. Que una imagen salga
        //    sin texto es justo lo que la convierte en candidata a vision.
        const buffer = Buffer.from('\x89PNG\r\n\x1a\n', 'latin1');

        // 2. Act
        const result = await extractTextFromBuffer(buffer, contentType);

        // 3. Assert: NO es un fallo, es el contrato.
        expect(result.text).toBe('');
        expect(result.failure).toBeNull();
      },
    );
  });

  describe('5. Tipos sin lector', () => {
    it('5.1 NO deberia contabilizar como fallo un tipo que no se sabe leer', async () => {
      // 1. Arrange: decirlo asi evita que un formato sin soporte se registre
      //    como averia del adjunto.
      const buffer = Buffer.from('contenido', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/octet-stream',
      );

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).toBeNull();
    });
  });

  describe('5bis. Normalizacion del texto (RNF-01)', () => {
    it('5bis.1 deberia colapsar las rachas de saltos de linea y recortar los bordes', async () => {
      // 1. Arrange: los extractores de PDF y de Word devuelven rachas de saltos
      //    por cada salto de pagina o de seccion. Cada uno de esos caracteres lo
      //    paga el `PROCESADOR_IA` en tokens.
      const buffer = Buffer.from(
        '\n\n  Primer parrafo.\n\n\n\n\nSegundo parrafo.\n\n\n  ',
        'utf-8',
      );

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert: como maximo un parrafo en blanco, y sin bordes sobrantes.
      expect(result.text).toBe('Primer parrafo.\n\nSegundo parrafo.');
      expect(result.text).not.toMatch(/\n{3,}/);
    });

    it('5bis.2 deberia colapsar las rachas de espacio horizontal', async () => {
      // 1. Arrange: un PDF maquetado en columnas llega con decenas de espacios
      //    seguidos que no significan nada para un modelo de lenguaje.
      const buffer = Buffer.from('Titulo        Fecha', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert
      expect(result.text).toBe('Titulo Fecha');
    });

    it('5bis.3 deberia normalizar ANTES de recortar', async () => {
      // 1. Arrange: el orden importa. Si se recortase primero, parte del
      //    presupuesto de caracteres se gastaria en saltos que iban a
      //    colapsarse igualmente y el documento se truncaria antes de tiempo.
      const padding = '\n'.repeat(1_000);
      const body = 'a'.repeat(MAX_EXTRACTED_DOCUMENT_CHARS - 10);
      const buffer = Buffer.from(`${padding}${body}`, 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert: los 1000 saltos se colapsan y luego se recortan por delante,
      //    asi que el texto cabe entero y NO se trunca.
      expect(result.text).toBe(body);
      expect(result.text).not.toContain(TRUNCATION_NOTICE);
    });
  });

  describe('6. Tope de longitud', () => {
    it('6.1 deberia recortar y dejar constancia al superar el tope', async () => {
      // 1. Arrange: una hoja de 10 MB se expande a megabytes de texto que
      //    acabarian integros en `contexto_acumulado`, reserializados en cada
      //    checkpoint posterior del flujo.
      const buffer = Buffer.from(
        'a'.repeat(MAX_EXTRACTED_DOCUMENT_CHARS + 500),
        'utf-8',
      );

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert
      expect(result.text).toHaveLength(
        MAX_EXTRACTED_DOCUMENT_CHARS + TRUNCATION_NOTICE.length,
      );
      expect(result.text.endsWith(TRUNCATION_NOTICE)).toBe(true);
    });

    it('6.2 NO deberia tocar un texto que cabe justo en el tope', async () => {
      // 1. Arrange: fija el limite exacto contra un error de desplazamiento.
      const buffer = Buffer.from(
        'a'.repeat(MAX_EXTRACTED_DOCUMENT_CHARS),
        'utf-8',
      );

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/plain');

      // 3. Assert
      expect(result.text).toHaveLength(MAX_EXTRACTED_DOCUMENT_CHARS);
      expect(result.text).not.toContain(TRUNCATION_NOTICE);
    });
  });

  describe('7. Desambiguacion y alineacion de columnas', () => {
    it('7.1 deberia sufijar los encabezados contiguos repetidos', async () => {
      // 1. Arrange: el caso real de "Paneles de septiembre 2026-WEB.xlsx",
      //    donde cada cargo ocupa dos columnas (nombre y universidad) y el
      //    aplanado con coma las dejaba indistinguibles.
      const buffer = await buildXlsx([
        ['PRESIDENTE', 'PRESIDENTE', 'SECRETARIO', 'SECRETARIO'],
        ['Ana Ruiz', 'Universidad A', 'Luis Paz', 'Universidad B'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('| PRESIDENTE (1) | PRESIDENTE (2) |');
      expect(result.text).toContain('| SECRETARIO (1) | SECRETARIO (2) |');
    });

    it('7.2 NO deberia partir una columna por una coma interna', async () => {
      // 1. Arrange: con el separador `, ` esta celda valia por dos columnas.
      const buffer = await buildXlsx([
        ['titulo', 'sede'],
        ['Apertura', 'Madrid, Espana'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      const dataRow = result.text.split('\n')[2];

      expect(dataRow).toBe('| Apertura | Madrid, Espana |');
      expect(dataRow.split('|')).toHaveLength(4);
    });

    it('7.3 deberia mantener la alineacion con un hueco en medio', async () => {
      // 1. Arrange: `eachCell` se salta las celdas vacias, asi que colocar por
      //    orden de llegada desplazaba a la izquierda todo lo que venia detras.
      const buffer = await buildXlsx([
        ['a', 'b', 'c'],
        ['uno', '', 'tres'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('| uno | | tres |');
    });

    it('7.4 deberia nombrar la columna sin encabezado por su posicion', async () => {
      // 1. Arrange
      const buffer = await buildXlsx([
        ['titulo', '', 'fecha'],
        ['Apertura', 'suelto', '2026-03-01'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('| titulo | COLUMNA_2 | fecha |');
    });

    it('7.5 deberia escapar una barra vertical que venga en una celda', async () => {
      // 1. Arrange
      const buffer = await buildXlsx([
        ['titulo', 'nota'],
        ['Apertura', 'uno | dos'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('| Apertura | uno \\| dos |');
    });

    it('7.6 deberia conservar el aplanado en una hoja de una sola columna', async () => {
      // 1. Arrange: envolver una columna en barras no anade informacion.
      const buffer = await buildXlsx([['titulo'], ['Nueva sede']]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('titulo\nNueva sede');
    });
  });

  describe('8. Una sola hoja por libro', () => {
    it('8.1 deberia extraer solo la primera hoja e ignorar las demas', async () => {
      // 1. Arrange: un libro real trae la hoja buena y detras un borrador y
      //    los datos auxiliares de un grafico.
      const buffer = await buildWorkbook([
        {
          name: 'Datos Principales',
          rows: [
            ['titulo', 'empleos'],
            ['Nueva sede', '200'],
          ],
        },
        {
          name: 'Borrador',
          rows: [
            ['pendiente', 'revisar'],
            ['texto borrador', 'no publicar'],
          ],
        },
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('| Nueva sede | 200 |');
      expect(result.text).not.toContain('borrador');
      expect(result.text).not.toContain('no publicar');
      expect(result.label).toBe('Hoja: Datos Principales');
    });

    it('8.2 deberia avisar de cuantas hojas secundarias se ignoraron', async () => {
      // 1. Arrange
      const buffer = await buildWorkbook([
        {
          name: 'Datos',
          rows: [
            ['a', 'b'],
            ['uno', 'dos'],
          ],
        },
        {
          name: 'Borrador',
          rows: [
            ['x', 'y'],
            ['1', '2'],
          ],
        },
        {
          name: 'Auxiliar',
          rows: [
            ['p', 'q'],
            ['3', '4'],
          ],
        },
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.notices).toHaveLength(1);
      expect(result.notices[0]).toContain('2 hoja(s) secundaria(s)');
      expect(result.notices[0]).toContain('Datos');
    });

    it('8.3 NO deberia avisar cuando el libro trae una sola hoja', async () => {
      // 1. Arrange
      const buffer = await buildXlsx([
        ['a', 'b'],
        ['uno', 'dos'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.notices).toEqual([]);
    });

    it('8.4 deberia devolver vacio y sin fallo ante un libro sin hojas', async () => {
      // 1. Arrange: un libro sin hojas no tiene nada que leer, y eso no es una
      //    averia.
      const buffer = await buildWorkbook([]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).toBeNull();
      expect(result.label).toBeNull();
    });
  });

  describe('9. Corte seguro por presupuesto de caracteres', () => {
    it('9.1 deberia cortar en una frontera de fila, nunca a la mitad', async () => {
      // 1. Arrange: quinientas filas y un presupuesto que no las admite.
      const rows: string[][] = [['columna_a', 'columna_b']];

      for (let index = 0; index < 500; index += 1) {
        rows.push([`valor-a-${index}`, `valor-b-${index}`]);
      }

      const worksheet = await loadFirstWorksheet(await buildXlsx(rows));

      // 2. Act
      const result = convertWorksheetToMarkdownTable(worksheet, 1_500);

      // 3. Assert: toda linea de rejilla esta cerrada y tiene el mismo ancho.
      const gridLines = result
        .split('\n')
        .filter((line) => line.startsWith('|'));

      expect(gridLines.length).toBeGreaterThan(2);

      for (const line of gridLines) {
        expect(line.endsWith('|')).toBe(true);
        expect(line.split('|')).toHaveLength(4);
      }
    });

    it('9.2 deberia cerrar con el aviso de truncado y respetar el tope', async () => {
      // 1. Arrange
      const rows: string[][] = [['columna_a', 'columna_b']];

      for (let index = 0; index < 500; index += 1) {
        rows.push([`valor-a-${index}`, `valor-b-${index}`]);
      }

      const worksheet = await loadFirstWorksheet(await buildXlsx(rows));

      // 2. Act
      const result = convertWorksheetToMarkdownTable(worksheet, 1_500);

      // 3. Assert
      expect(result).toContain('[AVISO: Contenido truncado');
      expect(result).not.toContain('valor-a-499');
      expect(result.length).toBeLessThan(1_500 + 120);
    });

    it('9.3 deberia nombrar la fila de datos en la que corto', async () => {
      // 1. Arrange
      const worksheet = await loadFirstWorksheet(
        await buildXlsx([
          ['a', 'b'],
          ['uno', 'dos'],
          ['tres', 'cuatro'],
          ['cinco', 'seis'],
        ]),
      );

      // 2. Act: presupuesto para el encabezado y una sola fila de datos.
      const result = convertWorksheetToMarkdownTable(worksheet, 45);

      // 3. Assert
      expect(result).toContain('| uno | dos |');
      expect(result).not.toContain('| tres | cuatro |');
      expect(result).toContain(buildTableTruncationNotice(2));
    });

    it('9.4 NO deberia avisar cuando la hoja cabe entera', async () => {
      // 1. Arrange
      const worksheet = await loadFirstWorksheet(
        await buildXlsx([
          ['a', 'b'],
          ['uno', 'dos'],
        ]),
      );

      // 2. Act
      const result = convertWorksheetToMarkdownTable(worksheet);

      // 3. Assert
      expect(result).not.toContain('AVISO');
    });
  });

  describe('10. Formatos binarios heredados', () => {
    it.each([
      ['application/msword', 'informe.doc', '.doc'],
      ['application/vnd.ms-excel', 'datos.xls', '.xls'],
      ['application/vnd.ms-powerpoint', 'charla.ppt', '.ppt'],
    ])(
      '10.1 deberia declarar sin soporte %s',
      async (contentType, filename, marker) => {
        // 1. Arrange: `officeparser` cubre OOXML y ODF pero NO el binario
        //    BIFF/CFB de Office 97-2003.
        const buffer = Buffer.from('contenido binario heredado', 'utf-8');

        // 2. Act
        const result = await extractTextFromBuffer(
          buffer,
          contentType,
          filename,
        );

        // 3. Assert
        expect(result.text).toBe('');
        expect(result.failure).toContain(marker);
        expect(result.failure).toContain('heredado');
      },
    );

    it('10.2 deberia reconocer el legado tras un octet-stream', async () => {
      // 1. Arrange: el tipo no dice nada y solo la extension delata el formato.
      const buffer = Buffer.from('contenido', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/octet-stream',
        'informe.doc',
      );

      // 3. Assert
      expect(result.failure).toContain('.doc');
    });

    it('10.3 deberia tratar vnd.ms-excel sin extension como .xls', async () => {
      // 1. Arrange: por eliminacion es el binario heredado, y decirlo es mejor
      //    que callar.
      const buffer = Buffer.from('contenido', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/vnd.ms-excel',
      );

      // 3. Assert
      expect(result.failure).toContain('.xls');
    });
  });

  describe('11. Enrutamiento por extension', () => {
    it('11.1 deberia leer como CSV un vnd.ms-excel con nombre .csv', async () => {
      // 1. Arrange: Excel pone ese tipo al CSV que el mismo exporta.
      const buffer = Buffer.from('titulo,ciudad\nApertura,Madrid', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/vnd.ms-excel',
        'datos.csv',
      );

      // 3. Assert
      expect(result.text).toContain('| titulo | ciudad |');
    });

    it('11.2 deberia leer como CSV un text/plain con nombre .csv', async () => {
      // 1. Arrange: lo mandan los clientes que no conocen `text/csv`.
      const buffer = Buffer.from('titulo,ciudad\nApertura,Madrid', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'text/plain',
        'datos.csv',
      );

      // 3. Assert
      expect(result.text).toContain('| --- | --- |');
    });

    it('11.3 deberia leer como texto un octet-stream con nombre .txt', async () => {
      // 1. Arrange
      const buffer = Buffer.from('Nota suelta', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/octet-stream',
        'notas.txt',
      );

      // 3. Assert
      expect(result.text).toBe('Nota suelta');
    });

    it('11.4 deberia seguir sin leer un octet-stream sin extension conocida', async () => {
      // 1. Arrange: refuerza el 5.1; sin lector no es una averia.
      const buffer = Buffer.from('binario', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        'application/octet-stream',
        'fichero.bin',
      );

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).toBeNull();
    });
  });

  describe('12. Word con tabla incrustada', () => {
    it('12.1 deberia emitir la tabla del .docx como rejilla Markdown', async () => {
      // 1. Arrange: `extractRawText` concatenaba las celdas sin delimitador y
      //    el cuadro de datos llegaba al modelo como una ristra de valores.
      const buffer = readFileSync(DOCX_PATH);

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        DOCX_CONTENT_TYPE,
        'tabla-simple.docx',
      );

      // 3. Assert
      expect(result.text).toContain('| Ciudad | Empleos |');
      expect(result.text).toContain('| --- | --- |');
      expect(result.text).toContain('| Madrid | 200 |');
      expect(result.failure).toBeNull();
    });

    it('12.2 deberia conservar los encabezados y los parrafos', async () => {
      // 1. Arrange
      const buffer = readFileSync(DOCX_PATH);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, DOCX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('# Nueva sede corporativa');
      expect(result.text).toContain('La compania inaugura su nueva sede.');
    });
  });

  describe('13. Presentaciones', () => {
    it('13.1 deberia extraer el texto de las diapositivas de un .pptx', async () => {
      // 1. Arrange
      const buffer = readFileSync(PPTX_PATH);

      // 2. Act
      const result = await extractTextFromBuffer(
        buffer,
        PPTX_CONTENT_TYPE,
        'presentacion-minima.pptx',
      );

      // 3. Assert
      expect(result.text).toContain('Nueva sede corporativa en Madrid');
      expect(result.text).toContain('Doscientos empleos directos');
      expect(result.failure).toBeNull();
      expect(result.label).toBe('Presentación');
    });

    it('13.2 deberia devolver el motivo ante un .pptx ilegible', async () => {
      // 1. Arrange
      const buffer = Buffer.from('PK esto no es una presentacion', 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, PPTX_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toBe('');
      expect(result.failure).not.toBeNull();
    });
  });
});
