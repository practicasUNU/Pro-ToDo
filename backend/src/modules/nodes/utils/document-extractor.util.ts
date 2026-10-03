import { Workbook } from 'exceljs';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';

import { parseDelimitedDocument } from '@modules/nodes/utils/delimited-text.util';
import { convertDocumentHtmlToMarkdown } from '@modules/nodes/utils/html-markdown.util';
import { normalizeWhitespace } from '@modules/nodes/utils/email-sanitizer.util';
import {
  MAX_TABLE_COLUMNS,
  hasMinimumTableShape,
  rowsToFlatText,
  rowsToMarkdownTable,
} from '@modules/nodes/utils/markdown-table.util';

import type { Cell, Worksheet } from 'exceljs';

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
export const PPTX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
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

/**
 * Presupuesto de caracteres de UNA hoja de calculo.
 *
 * Es independiente de `MAX_EXTRACTED_DOCUMENT_CHARS` y mas estricto a
 * proposito: aquel acota el documento entero, y sin este un solo libro se
 * comeria el presupuesto completo y dejaria sin sitio a los demas adjuntos del
 * mismo correo. Se aplica en frontera de FILA, nunca por `slice`, para que la
 * rejilla Markdown llegue siempre balanceada.
 */
export const MAX_XLSX_CHARS = 30_000;

/** Marca que se anade al texto cuando hubo que recortarlo. */
export const TRUNCATION_NOTICE = '\n\n[...texto recortado por longitud]';

/** Tope de tiempo del analisis de una presentacion. */
const PPTX_PARSE_TIMEOUT_MS = 30_000;

/**
 * Lo que este modulo sabe hacer con un adjunto.
 *
 * Es un tipo y no una cadena suelta porque el enrutamiento cruza DOS fuentes
 * —el tipo MIME y la extension del nombre— y necesita un vocabulario comun en
 * el que resolver el empate.
 */
type DocumentKind =
  | 'text'
  | 'csv'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'legacy-doc'
  | 'legacy-xls'
  | 'legacy-ppt'
  | 'image'
  | 'unknown';

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
  /**
   * Etiqueta del origen DENTRO del documento, p.ej. `Hoja: Datos Principales`.
   *
   * La compone el llamante dentro de su propia cabecera
   * `--- Documento: <fichero> (<etiqueta>) ---`. Se devuelve separada y no ya
   * encabezada porque el bloque solo se emite cuando hay texto: un extractor
   * que devolviera la cabecera pegada haria que una extraccion vacia dejase de
   * ser la cadena vacia, y con ella se romperian tanto esa guarda como el
   * recuento de candidatos a vision.
   */
  readonly label: string | null;
  /**
   * Avisos no bloqueantes; el llamante decide donde publicarlos.
   *
   * No se escriben con un `Logger` aqui dentro porque este modulo tiene que
   * seguir siendo PURO: es lo que permite consumirlo desde `WizardService` sin
   * cablear inyeccion de dependencias, igual que `buildParsedEmail`. El canal
   * ya existe y es `ParsedEmailHooks`.
   */
  readonly notices: readonly string[];
}

/** Extraccion sin texto ni avisos, que es el caso mayoritario del `default`. */
const EMPTY_EXTRACTION: DocumentExtraction = {
  text: '',
  failure: null,
  label: null,
  notices: [],
};

/**
 * Motivos de los formatos binarios heredados.
 *
 * Que sean `failure` y no silencio es deliberado: el adjunto EXISTE y trae
 * contenido que el pipeline no va a ver, y el operador necesita saberlo para
 * pedir el fichero en otro formato. Que no bloqueen es la otra mitad del
 * acuerdo: un `.doc` no lo arregla ningun modelo con vision, de modo que
 * tampoco levanta la bandera multimodal —su tipo no casa
 * `MULTIMODAL_CONTENT_TYPE_PATTERN`— y no retiene sus megabytes para una
 * llamada que no puede servir.
 *
 * No se soportan y no se van a soportar con una dependencia: `officeparser`
 * cubre OOXML y ODF pero NO el binario BIFF/CFB de Office 97-2003, y las
 * alternativas son un paquete sin mantenimiento por formato.
 */
const LEGACY_FAILURES: Readonly<Partial<Record<DocumentKind, string>>> = {
  'legacy-doc':
    'Formato binario heredado .doc (Word 97-2003) sin soporte de extraccion. Reenvielo como .docx o PDF.',
  'legacy-xls':
    'Formato binario heredado .xls (Excel 97-2003) sin soporte de extraccion. Reenvielo como .xlsx o CSV.',
  'legacy-ppt':
    'Formato binario heredado .ppt (PowerPoint 97-2003) sin soporte de extraccion. Reenvielo como .pptx o PDF.',
};

/**
 * Tipos que NO dicen nada del contenido y obligan a mirar la extension.
 *
 * `application/octet-stream` llega de clientes que no saben declarar el tipo y
 * es ademas `DEFAULT_ATTACHMENT_CONTENT_TYPE`: un inventario rehidratado desde
 * la columna jsonb al que le falte la clave aterriza aqui con ese valor. No es
 * un caso de laboratorio.
 *
 * `application/vnd.ms-excel` esta en esta lista y no en el mapa de tipos
 * porque Excel y Outlook lo ponen tanto a un `.xls` binario de verdad como al
 * `.csv` que la propia hoja de calculo acaba de exportar. Sin la extension no
 * hay forma de distinguirlos.
 */
const AMBIGUOUS_CONTENT_TYPES: ReadonlySet<string> = new Set([
  '',
  'application/octet-stream',
  'application/binary',
  'application/zip',
  'application/x-zip-compressed',
  'application/vnd.ms-excel',
  'application/force-download',
]);

const CONTENT_TYPE_KINDS: ReadonlyMap<string, DocumentKind> = new Map([
  ['text/plain', 'text'],
  ['text/markdown', 'text'],
  ['text/csv', 'csv'],
  ['text/tab-separated-values', 'csv'],
  [PDF_CONTENT_TYPE, 'pdf'],
  [DOCX_CONTENT_TYPE, 'docx'],
  [XLSX_CONTENT_TYPE, 'xlsx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  [PPTX_CONTENT_TYPE, 'pptx'],
  ['application/msword', 'legacy-doc'],
  ['application/vnd.ms-powerpoint', 'legacy-ppt'],
]);

const EXTENSION_KINDS: ReadonlyMap<string, DocumentKind> = new Map([
  ['txt', 'text'],
  ['md', 'text'],
  ['log', 'text'],
  ['csv', 'csv'],
  ['tsv', 'csv'],
  ['pdf', 'pdf'],
  ['docx', 'docx'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['pptx', 'pptx'],
  ['doc', 'legacy-doc'],
  ['xls', 'legacy-xls'],
  ['ppt', 'legacy-ppt'],
]);

/**
 * Extension en minusculas, o cadena vacia.
 *
 * El nombre lo controla QUIEN ENVIA el correo (ver la nota de
 * `RawEmailAttachment.filename`): aqui solo se compara el sufijo contra un mapa
 * cerrado. PROHIBIDO derivar de el una ruta de fichero.
 */
const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');

  return dot < 0
    ? ''
    : filename
        .slice(dot + 1)
        .toLowerCase()
        .trim();
};

/** Cruza el tipo MIME con la extension y decide que lector toca. */
const resolveDocumentKind = (
  contentType: string,
  filename: string,
): DocumentKind => {
  if (contentType.startsWith('image/')) {
    return 'image';
  }

  const byExtension = EXTENSION_KINDS.get(extensionOf(filename));
  const byContentType = CONTENT_TYPE_KINDS.get(contentType);

  if (AMBIGUOUS_CONTENT_TYPES.has(contentType)) {
    if (byExtension !== undefined) {
      return byExtension;
    }

    // Un `application/vnd.ms-excel` sin extension reconocible es, por
    // eliminacion, el binario heredado. Decirlo es mejor que callar.
    return contentType === 'application/vnd.ms-excel'
      ? 'legacy-xls'
      : 'unknown';
  }

  // El tipo MIME manda, con UNA excepcion: `text/plain` sobre un `.csv` es lo
  // que mandan los clientes que no conocen `text/csv`, y tratarlo como texto
  // plano desperdiciaria la unica estructura que el fichero tenia.
  if (byContentType === 'text' && byExtension === 'csv') {
    return 'csv';
  }

  return byContentType ?? byExtension ?? 'unknown';
};

/** Recorta al tope y deja constancia de que se recorto. */
const truncate = (text: string): string =>
  text.length <= MAX_EXTRACTED_DOCUMENT_CHARS
    ? text
    : `${text.slice(0, MAX_EXTRACTED_DOCUMENT_CHARS)}${TRUNCATION_NOTICE}`;

/** `true` para un objeto plano, que es lo unico que puede traer claves. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Fecha en ISO-8601, sin la hora cuando no la hay.
 *
 * Una fecha de hoja de calculo es casi siempre un dia suelto, y exceljs la
 * entrega como medianoche UTC. `2026-03-01` dice lo mismo que
 * `2026-03-01T00:00:00.000Z` con dieciocho caracteres menos y sin invitar al
 * modelo a razonar sobre un huso horario que el XLSX no declara.
 */
const formatCellDate = (value: Date): string => {
  const iso = value.toISOString();

  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
};

/** Concatena los tramos de un valor de texto rico. */
const readRichText = (value: Record<string, unknown>): string | null => {
  if (!Array.isArray(value.richText)) {
    return null;
  }

  const parts: readonly unknown[] = value.richText;

  return parts
    .map((part) =>
      isRecord(part) && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
};

/**
 * Resuelve un `CellValue` a texto. Recursiva por el `result` de las formulas.
 *
 * El ORDEN de las ramas es contrato: el error va primero porque
 * `{ error: '#DIV/0!' }` no tiene ninguna otra clave que lo identifique, y el
 * hipervinculo antes que la formula porque en el modelo de exceljs ninguno de
 * los dos excluye al otro.
 */
const resolveCellValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return formatCellDate(value);
  }

  if (!isRecord(value)) {
    return '';
  }

  // Se emite el literal que ve un humano en Excel. Devolver cadena vacia
  // escondería que la fuente esta rota y el operador no tendria como saberlo.
  if (typeof value.error === 'string') {
    return value.error;
  }

  const rich = readRichText(value);

  if (rich !== null) {
    return rich;
  }

  if (typeof value.hyperlink === 'string') {
    const label = resolveCellValue(value.text);

    // La URL se conserva: `cell.text` la TIRABA, y los adjuntos no pasan por
    // `collectUrls`, de modo que era la unica copia que habia de ese enlace.
    return label.length === 0 || label === value.hyperlink
      ? value.hyperlink
      : `${label} (${value.hyperlink})`;
  }

  // `CellFormulaValue` y `CellSharedFormulaValue`: interesa el resultado
  // cacheado, nunca la expresion. `=SUMA(A1:A9)` no es un dato.
  if ('result' in value) {
    return resolveCellValue(value.result);
  }

  return '';
};

/**
 * Texto de una celda, resolviendo formula, texto rico, fecha, enlace y error.
 *
 * Una celda COMBINADA solo guarda el valor en su esquina superior izquierda y
 * el resto del rango vale `null`. Se resuelve contra `master` —que devuelve la
 * propia celda cuando no hay combinacion, asi que no hace falta ramificar— para
 * que la rejilla no quede con huecos que descuadren las columnas.
 *
 * @param cell Celda de ExcelJS.
 * @returns El texto recortado, o cadena vacia si no habia valor.
 */
export const extractCellValue = (cell: Cell): string => {
  const source: Cell = cell.isMerged ? cell.master : cell;
  const resolved = resolveCellValue(source.value);

  // `cell.text` es la ULTIMA red: una formula sin resultado cacheado o un tipo
  // que exceljs no modele caen aqui en vez de desaparecer.
  return (resolved.length > 0 ? resolved : source.text).trim();
};

/**
 * Vuelca una hoja a matriz respetando el numero de columna de cada celda.
 *
 * Se usa `eachCell` SIN `includeEmpty`, apoyandose en el `colNumber` que la
 * propia libreria entrega. NO se usa `row.getCell(n)` ni
 * `eachCell({ includeEmpty: true })`: AMBOS pasan por `Row.getCell`, que es un
 * "get OR CREATE" (`lib/doc/row.js`), y MATERIALIZAN en memoria las celdas que
 * no existen —justo la hoja con mil columnas formateadas que se queria evitar—.
 * Colocar por indice da la misma alineacion sin ese coste.
 */
const readWorksheetMatrix = (worksheet: Worksheet): string[][] => {
  const matrix: string[][] = [];

  worksheet.eachRow((row) => {
    const cells: string[] = [];

    row.eachCell((cell, colNumber) => {
      if (colNumber > MAX_TABLE_COLUMNS) {
        return;
      }

      const value = extractCellValue(cell);

      if (value.length === 0) {
        return;
      }

      while (cells.length < colNumber - 1) {
        cells.push('');
      }

      cells[colNumber - 1] = value;
    });

    if (cells.length > 0) {
      matrix.push(cells);
    }
  });

  return matrix;
};

/**
 * Una hoja de calculo a tabla Markdown GFM.
 *
 * La fila 1 son los encabezados, que `rowsToMarkdownTable` desambigua: dos
 * columnas contiguas llamadas `PRESIDENTE` salen como `PRESIDENTE (1)` y
 * `PRESIDENTE (2)`, que es lo que permite al modelo atribuir cada valor a su
 * columna.
 *
 * Una rejilla que no tiene forma de tabla —una sola columna, una sola fila—
 * conserva el aplanado heredado separado por comas: envolverla en barras
 * verticales no anadiria informacion y si gastaria tokens.
 *
 * @param worksheet Hoja de ExcelJS.
 * @param maxChars Presupuesto de caracteres; el corte ocurre en frontera de
 *                 fila y deja constancia con su aviso.
 * @returns La tabla Markdown, el aplanado, o cadena vacia si la hoja no tenia
 *          ni un valor.
 */
export const convertWorksheetToMarkdownTable = (
  worksheet: Worksheet,
  maxChars: number = MAX_XLSX_CHARS,
): string => {
  const matrix = readWorksheetMatrix(worksheet);

  if (matrix.length === 0) {
    return '';
  }

  return hasMinimumTableShape(matrix)
    ? rowsToMarkdownTable(matrix, maxChars)
    : rowsToFlatText(matrix);
};

/** Texto y etiqueta de hoja de un libro de calculo. */
interface WorkbookExtraction {
  readonly text: string;
  readonly label: string | null;
  readonly notices: readonly string[];
}

/**
 * Lee la PRIMERA hoja del libro y descarta las demas.
 *
 * Es una restriccion deliberada y no una limitacion tecnica. Un libro de
 * trabajo real trae la hoja buena y detras un `Borrador`, un `Hoja2` vacia y
 * los datos auxiliares de un grafico; concatenarlas todas metia ese ruido en el
 * prompt del nodo de inferencia y, peor, repartia el presupuesto de caracteres
 * entre hojas que nadie iba a leer. El operador que necesite la segunda hoja
 * tiene el aviso para saber que existe.
 */
const extractFromWorkbook = async (
  buffer: Buffer,
): Promise<WorkbookExtraction> => {
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

  // Guarda de precondicion: un libro sin hojas no tiene nada que leer, y eso
  // no es una averia.
  if (workbook.worksheets.length === 0) {
    return { text: '', label: null, notices: [] };
  }

  const [targetSheet] = workbook.worksheets;
  const ignored = workbook.worksheets.length - 1;
  const notices =
    ignored > 0
      ? [
          `Se ignoraron ${ignored} hoja(s) secundaria(s) del libro; solo se extrajo "${targetSheet.name}".`,
        ]
      : [];

  return {
    text: convertWorksheetToMarkdownTable(targetSheet, MAX_XLSX_CHARS),
    label: `Hoja: ${targetSheet.name}`,
    notices,
  };
};

/** Un `.docx` a Markdown, pasando por el HTML que emite mammoth. */
const extractFromDocx = async (buffer: Buffer): Promise<string> => {
  const { value } = await mammoth.convertToHtml(
    { buffer },
    {
      // Sin esto mammoth incrusta CADA imagen como `data:` URI y el HTML
      // intermedio de un `.docx` con fotos pasa de kilobytes a megabytes antes
      // de que ninguna poda llegue a verlo. El nodo no hace OCR: una imagen no
      // aporta texto, asi que no hay nada que perder.
      convertImage: mammoth.images.imgElement(() =>
        Promise.resolve({ src: '' }),
      ),
      ignoreEmptyParagraphs: true,
    },
  );

  return convertDocumentHtmlToMarkdown(value);
};

/** Un fichero delimitado a tabla Markdown, o a su texto si no es tabular. */
const extractFromDelimited = (buffer: Buffer): string => {
  const raw = buffer.toString('utf-8');
  const matrix = parseDelimitedDocument(raw);

  if (!hasMinimumTableShape(matrix)) {
    // Una sola columna o una sola fila no ganan nada envueltas en barras: se
    // devuelve el fichero tal cual, que era el comportamiento anterior.
    return raw;
  }

  return rowsToMarkdownTable(matrix, MAX_XLSX_CHARS);
};

/** Una presentacion a Markdown, con la libreria cargada bajo demanda. */
const extractFromPresentation = async (buffer: Buffer): Promise<string> => {
  // Carga DIFERIDA y dentro de la rama, no arriba del archivo.
  // `officeparser` arrastra `pdfjs-dist` y `tesseract.js`: decenas de megabytes
  // que no tienen por que entrar en memoria por el mero hecho de arrancar la
  // aplicacion ni por procesar un correo con un PDF. Solo lo paga el correo que
  // de verdad trae un `.pptx`.
  //
  // Se usa `require` y NO `import()`, aunque este modulo sea async y el import
  // dinamico fuese lo natural. Con `module: nodenext` TypeScript PRESERVA el
  // `import()` en la salida CommonJS —ese es justamente su proposito, poder
  // cargar ESM desde CJS—, y la VM de Jest lo rechaza sin
  // `--experimental-vm-modules`: `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG`.
  // El resultado seria una rama que funciona en produccion y que ninguna prueba
  // puede recorrer, que es la peor combinacion posible. `require` es igual de
  // perezoso —solo se resuelve cuando se ejecuta esta linea— y recorre el mismo
  // camino en los dos sitios. El `typeof import(...)` es solo de tipos y se
  // borra al compilar, asi que no reintroduce la carga.
  //
  // La exencion va en forma de BLOQUE y no de `eslint-disable-next-line`:
  // prettier reparte la asignacion en dos lineas al formatear y el comentario
  // de una sola linea deja de apuntar a la que trae el `require`.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parseOffice } =
    require('officeparser') as typeof import('officeparser');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const ast = await parseOffice(buffer, {
    // Tipo EXPLICITO: ahorra la deteccion por firma, que es la rama que carga
    // `file-type` —paquete ESM puro— y la mas fragil bajo ts-jest.
    fileType: 'pptx',
    // CERO OCR, que es el contrato de este nodo, y ademas lo que evita que
    // `tesseract.js` levante un worker que Jest despues no sabe cerrar.
    ocr: false,
    extractAttachments: false,
    abortSignal: AbortSignal.timeout(PPTX_PARSE_TIMEOUT_MS),
  });

  // `md` y no `text`: una diapositiva de una nota de prensa trae tablas, y
  // perderlas aqui contradiria el objetivo de este modulo.
  const { value } = await ast.to('md');

  return value;
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
  kind: DocumentKind,
): Promise<WorkbookExtraction> => {
  switch (kind) {
    case 'text':
      return { text: buffer.toString('utf-8'), label: null, notices: [] };

    case 'csv':
      return { text: extractFromDelimited(buffer), label: null, notices: [] };

    case 'pdf':
      return { text: (await pdfParse(buffer)).text, label: null, notices: [] };

    case 'docx':
      return { text: await extractFromDocx(buffer), label: null, notices: [] };

    case 'xlsx':
      return extractFromWorkbook(buffer);

    case 'pptx':
      return {
        text: await extractFromPresentation(buffer),
        label: 'Presentación',
        notices: [],
      };

    default:
      return { text: '', label: null, notices: [] };
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
 * @param filename Nombre declarado por el remitente. Se usa SOLO para desempatar
 *                 por extension cuando el tipo MIME no distingue —un
 *                 `application/vnd.ms-excel` puede ser un `.xls` o un `.csv`—.
 *                 Es opcional para que las llamadas de dos argumentos sigan
 *                 siendo validas.
 */
export const extractTextFromBuffer = async (
  buffer: Buffer,
  contentType: string,
  filename = '',
): Promise<DocumentExtraction> => {
  const kind = resolveDocumentKind(contentType, filename);

  // Guarda de precondicion: las imagenes salen ANTES de tocar el buffer. No es
  // una optimizacion, es el contrato del nodo —aqui no se hace OCR— y ademas es
  // lo que convierte una imagen en candidata a respaldo multimodal. Un tipo sin
  // lector sale por el mismo sitio: no es un fallo, es un formato del que este
  // nodo no sabe sacar texto, y decirlo asi evita contabilizarlo como averia.
  if (kind === 'image' || kind === 'unknown') {
    return EMPTY_EXTRACTION;
  }

  const legacy = LEGACY_FAILURES[kind];

  if (legacy !== undefined) {
    return { text: '', failure: legacy, label: null, notices: [] };
  }

  try {
    const raw = await extractRawText(buffer, kind);

    // El ORDEN importa: primero normalizar y despues recortar. Al reves, parte
    // del presupuesto de caracteres se gastaria en rachas de saltos de linea y
    // de espacios que iban a colapsarse de todas formas, y el documento se
    // truncaria antes de lo necesario.
    const text = truncate(normalizeWhitespace(raw.text));

    return {
      text,
      failure: null,
      // Sin texto no hay bloque que encabezar, y una etiqueta suelta solo
      // confundiria a quien lea el checkpoint.
      label: text.length > 0 ? raw.label : null,
      notices: raw.notices,
    };
  } catch (error) {
    return {
      text: '',
      failure: error instanceof Error ? error.message : String(error),
      label: null,
      notices: [],
    };
  }
};
