import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Workbook } from 'exceljs';

import {
  DOCX_CONTENT_TYPE,
  MAX_EXTRACTED_DOCUMENT_CHARS,
  PDF_CONTENT_TYPE,
  TRUNCATION_NOTICE,
  XLSX_CONTENT_TYPE,
  extractTextFromBuffer,
} from './document-extractor.util';

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

/** Construye un `.xlsx` real con `exceljs`, la misma libreria que lo leera. */
const buildXlsx = async (rows: string[][]): Promise<Buffer> => {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Datos');

  for (const row of rows) {
    sheet.addRow(row);
  }

  const written = await workbook.xlsx.writeBuffer();

  return Buffer.from(written);
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

    it('0.2 deberia devolver un CSV tal cual, sin pasarlo por un analizador', async () => {
      // 1. Arrange: un CSV ya es texto. Leerlo con un analizador de hojas de
      //    calculo para volver a serializarlo como CSV es un viaje de ida y
      //    vuelta que solo puede perder informacion.
      const csv = 'titulo,fecha\nNueva sede,2026-03-01';
      const buffer = Buffer.from(csv, 'utf-8');

      // 2. Act
      const result = await extractTextFromBuffer(buffer, 'text/csv');

      // 3. Assert
      expect(result.text).toBe(csv);
    });
  });

  describe('1. PDF con texto nativo', () => {
    it('1.1 deberia extraer el texto sin OCR', async () => {
      // 1. Arrange
      const buffer = readFileSync(NATIVE_PDF_PATH);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, PDF_CONTENT_TYPE);

      // 3. Assert
      expect(result.text).toContain('Nota de prensa institucional de UNUWARE');
      expect(result.failure).toBeNull();
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
    it('2.1 deberia aplanar un .xlsx a filas separadas por saltos de linea', async () => {
      // 1. Arrange
      const buffer = await buildXlsx([
        ['titulo', 'empleos'],
        ['Nueva sede', '200'],
      ]);

      // 2. Act
      const result = await extractTextFromBuffer(buffer, XLSX_CONTENT_TYPE);

      // 3. Assert: el destinatario es un modelo de lenguaje, no un analizador
      //    sintactico; no se reconstruyen comillas ni escapado de RFC 4180.
      expect(result.text).toBe('titulo, empleos\nNueva sede, 200');
      expect(result.failure).toBeNull();
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
});
