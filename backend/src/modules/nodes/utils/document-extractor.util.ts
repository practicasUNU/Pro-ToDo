import { Workbook } from 'exceljs';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

import { normalizeWhitespace } from '@modules/nodes/utils/email-sanitizer.util';

/**
 * Tipos MIME de documento de los que se sabe sacar texto SIN OCR.
 *
 * La lista es deliberadamente mas corta que la lista blanca de adjuntos de
 * `ImapTriggerStrategy`: alli se decide QUE se acepta guardar, y aqui QUE se
 * sabe leer. Una imagen entra en aquella y no en esta, y esa diferencia es justo
 * la que alimenta la bandera de respaldo multimodal.
 */
export const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_CONTENT_TYPE = 'application/pdf';

/**
 * Tope de caracteres que un solo documento puede aportar.
 *
 * El limite de adjuntos son 10 MB (`MAX_TOTAL_ATTACHMENT_BYTES`), y una hoja de
 * calculo de ese tamano se expande a MEGABYTES de texto que acabarian integros
 * dentro de la columna `jsonb contexto_acumulado`, reserializados en cada
 * checkpoint posterior del flujo. Es el mismo argumento de peso que motivo
 * `MAX_HTML_LENGTH` y `MAX_EXTRACTED_URLS`.
 *
 * Va como constante y no como opcion del DTO porque es un limite de integridad
 * del almacenamiento, no una preferencia de flujo.
 */
export const MAX_EXTRACTED_DOCUMENT_CHARS = 100_000;

/** Marca que se anade al texto cuando hubo que recortarlo. */
export const TRUNCATION_NOTICE = '\n\n[...texto recortado por longitud]';

/** Separador de celdas dentro de una misma fila de hoja de calculo. */
const CELL_SEPARATOR = ', ';

/**
 * Resultado de intentar leer un documento.
 *
 * Se devuelve un objeto y no una cadena suelta porque el MOTIVO del fracaso es
 * un dato que el llamante necesita: distinguir "este PDF no traia texto" de
 * "este PDF estaba corrupto" es exactamente lo que separa un candidato a
 * respaldo multimodal de un adjunto roto que no arregla ningun modelo.
 */
export interface DocumentExtraction {
  /** Texto obtenido; cadena vacia cuando no se pudo o el tipo no se lee. */
  readonly text: string;
  /** Motivo del fallo, o `null` si no lo hubo. */
  readonly failure: string | null;
}

/** Recorta al tope y deja constancia de que se recorto. */
const truncate = (text: string): string =>
  text.length <= MAX_EXTRACTED_DOCUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)}${TRUNCATION_NOTICE}`;

/**
 * Aplana un libro de calculo a texto, una fila por linea.
 *
 * No se reconstruye un CSV con comillas ni escapado: el destinatario de esto es
 * un modelo de lenguaje, no un analizador sintactico. Reproducir las reglas de
 * RFC 4180 solo anadiria caracteres que gastan tokens sin aportar significado.
 */
const extractFromWorkbook = async (buffer: Buffer): Promise<string> => {
  const workbook = new Workbook();

  // `exceljs` declara `interface Buffer extends ArrayBuffer` en su propio
  // `index.d.ts`, que se FUSIONA con el `Buffer` global de Node y deja los dos
  // tipos mutuamente inasignables. En ejecucion `load` acepta un Buffer de Node
  // sin mas: el `as` documenta un desajuste de tipos AJENO, no un atajo nuestro,
  // y se apoya en `Parameters<>` para no escribir `any` ni fijar un nombre que
  // la libreria pueda cambiar.
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );

  const sheets: string[] = [];

  for (const worksheet of workbook.worksheets) {
    const rows: string[] = [];

    worksheet.eachRow((row) => {
      const cells: string[] = [];

      // `eachCell` con `includeEmpty` en falso: una hoja con formato aplicado a
      // mil columnas vacias produciria mil separadores por fila y ni un dato.
      row.eachCell((cell) => {
        const value = cell.text.trim();

        if (value.length > 0) {
          cells.push(value);
        }
      });

      if (cells.length > 0) {
        rows.push(cells.join(CELL_SEPARATOR));
      }
    });

    if (rows.length > 0) {
      sheets.push(rows.join('\n'));
    }
  }

  return sheets.join('\n\n');
};

/**
 * Despacha al lector que corresponda y devuelve el texto CRUDO.
 *
 * Separada de `extractTextFromBuffer` para que la normalizacion y el recorte
 * ocurran en UN solo sitio y no repetidos en cada rama: asi no puede aparecer un
 * lector nuevo que se olvide de aplicarlos.
 */
const extractRawText = async (
  buffer: Buffer,
  contentType: string,
): Promise<string> => {
  switch (contentType) {
    case 'text/plain':
    case 'text/csv':
      // Un CSV ya es texto. Pasarlo por un analizador de hojas de calculo para
      // volver a serializarlo como CSV seria un viaje de ida y vuelta que solo
      // puede perder informacion.
      return buffer.toString('utf-8');

    case PDF_CONTENT_TYPE:
      return (await pdfParse(buffer)).text;

    case DOCX_CONTENT_TYPE:
      return (await mammoth.extractRawText({ buffer })).value;

    case XLSX_CONTENT_TYPE:
      return extractFromWorkbook(buffer);

    default:
      // Tipo sin lector. No es un fallo: es un formato del que este nodo no
      // sabe sacar texto, y decirlo asi evita que se contabilice como averia.
      return '';
  }
};

/**
 * Extrae el texto nativo de un documento adjunto. CERO OCR.
 *
 * Pura y sin estado: no toca el contexto, no registra nada y NO LANZA. Un
 * documento corrupto devuelve texto vacio con su motivo, porque un adjunto
 * ilegible no puede llevarse por delante la ejecucion entera de un flujo —el
 * motor normaliza toda excepcion a URGENTE, que `canRetry` nunca reintenta.
 *
 * Que no lance es tambien lo que permite consumirla desde `WizardService` sin
 * cablear inyeccion de dependencias, igual que `buildParsedEmail`.
 *
 * @param buffer Contenido ya decodificado del adjunto.
 * @param contentType Tipo MIME normalizado (minusculas, sin parametros), tal y
 *                    como lo deja `ImapTriggerStrategy`. Se llama `contentType`
 *                    y no `mimeType` porque ese es el nombre de la clave en
 *                    `RawEmailAttachment`, y renombrarlo al cruzar la frontera
 *                    obliga a traducir mentalmente en cada punto de uso.
 */
export const extractTextFromBuffer = async (
  buffer: Buffer,
  contentType: string,
): Promise<DocumentExtraction> => {
  // Guarda de precondicion: las imagenes salen ANTES de tocar el buffer. No es
  // una optimizacion, es el contrato del nodo —aqui no se hace OCR— y ademas es
  // lo que convierte una imagen en candidata a respaldo multimodal.
  if (contentType.startsWith('image/')) {
    return { text: '', failure: null };
  }

  try {
    const raw = await extractRawText(buffer, contentType);

    // El ORDEN importa: primero normalizar y despues recortar. Al reves, parte
    // del presupuesto de caracteres se gastaria en rachas de saltos de linea y
    // de espacios que iban a colapsarse de todas formas, y el documento se
    // truncaria antes de lo necesario.
    return { text: truncate(normalizeWhitespace(raw)), failure: null };
  } catch (error) {
    return {
      text: '',
      failure: error instanceof Error ? error.message : String(error),
    };
  }
};
