import { DEFAULT_ATTACHMENT_CONTENT_TYPE } from '@modules/nodes/interfaces/raw-email-attachment.interface';
import { extractTextFromBuffer } from '@modules/nodes/utils/document-extractor.util';
import {
  cleanSubject,
  extractEmailUrls,
  reductionPercentage,
  sanitizeEmailHtml,
  sanitizeEmailText,
} from '@modules/nodes/utils/email-sanitizer.util';

import type { ResolvedParserEmailConfig } from '@modules/nodes/dto/parser-email-config.dto';
import type { RawEmailAttachmentMetadata } from '@modules/nodes/interfaces/raw-email-attachment.interface';

/**
 * Tipos que un modelo con vision puede leer y un extractor de texto no.
 *
 * Las hojas de calculo y los CSV quedan FUERA a proposito: son texto que otro
 * nodo puede decodificar sin gastar un modelo multimodal, que es con diferencia
 * la llamada mas cara del pipeline.
 *
 * Se EXPORTA porque hay dos lados de la misma decision y tienen que usar el
 * mismo criterio: aqui se cuenta que adjuntos justifican levantar la bandera
 * `requires_multimodal_fallback`, y en `LlmExtractorStrategy` se elige cuales se
 * envian de verdad al modelo. Con dos expresiones separadas, el dia que alguien
 * anadiera `image/heic` a una de ellas el parser pediria vision para un fichero
 * que el nodo de IA despues descartaria, y el flujo se quedaria sin entrada.
 */
export const MULTIMODAL_CONTENT_TYPE_PATTERN = /^(?:image\/|application\/pdf$)/;

/**
 * Marcador que deja en el texto plano una imagen insertada en el cuerpo.
 *
 * Gmail escribe `[image: captura.png]`, Outlook `[cid:image001.png@...]` y los
 * clientes en espanol `[imagen: ...]`. Es la senal de que el remitente PUSO
 * contenido en una imagen dentro del propio mensaje, no en un adjunto aparte.
 */
export const INLINE_IMAGE_PLACEHOLDER_PATTERN =
  /\[(?:image|imagen|cid):[^\]]*\]/i;

/**
 * Tamano minimo, en bytes, de una imagen citada para considerarla una captura.
 *
 * Por debajo estan los logotipos e iconos de firma, que tambien dejan su
 * marcador en el texto plano y no llevan datos. Una captura de una tabla pesa
 * decenas de kilobytes (la que motivo la regla, 52 KB).
 */
export const MIN_INLINE_CAPTURE_BYTES = 20_000;

/**
 * Origen del cuerpo textual que el parser saneo.
 *
 * NOTA DE COMPATIBILIDAD: hasta el saneador existio un cuarto valor,
 * `'html_pending_sanitize'`, que declaraba marcado sin procesar. Ya no se emite,
 * pero las filas antiguas de `ejecuciones_flujo.contexto_acumulado` pueden
 * contenerlo. Cualquier lector que ramifique sobre esta clave debe tolerar
 * valores fuera de la union.
 */
export type BodySource = 'text' | 'html' | 'none';

/**
 * Payload determinista que el nodo `PARSER_PRE_IA` expone en `parsed_email`.
 *
 * Todas las claves estan siempre presentes y con su tipo. `clean_body` es
 * SIEMPRE una cadena: la cadena vacia, junto a `body_source: 'none'`, es la
 * forma honesta de decir "este correo no traia texto". Que no sea `null` no es
 * cosmetico —interpolar `{{parsed_email.clean_body}}` sobre un `null` lanzaba
 * igual que sobre una variable ausente, mientras que una cadena vacia no lanza—,
 * de modo que las plantillas montadas sobre este nodo son seguras por
 * construccion. Aun asi, quien quiera ramificar deberia apoyarse en
 * `body_source`, que es la clave que explica POR QUE el cuerpo esta como esta.
 *
 * El ORDEN de las claves es parte del contrato, y desde que esta interfaz se
 * exporta lo es de forma PUBLICA: la replica el frontend en
 * `frontend/src/types/parser-email.ts` y la documenta `ParsedEmailPreviewDto`.
 * La prueba 1.1 de `parser-email.strategy.spec.ts` lo compara posicionalmente y
 * es lo unico que impide que un reordenado pase inadvertido.
 */
export interface ParsedEmailPayload {
  readonly subject: string;
  readonly clean_title: string;
  readonly clean_body: string;
  readonly body_source: BodySource;
  readonly character_count: number;
  readonly original_character_count: number;
  readonly reduction_percentage: number;
  /**
   * Enlaces de contenido que `EXTRACTOR_WEB` escrapeara.
   *
   * Salen SIEMPRE del marcado, con independencia de que el cuerpo lo aporte el
   * texto plano: son dos representaciones del mismo correo, y solo el marcado
   * declara los enlaces sin partirlos a 78 columnas (RFC 5322). Por eso NO
   * describen necesariamente el mismo documento que `clean_body`.
   */
  readonly extracted_urls: readonly string[];
  readonly attachment_count: number;
  readonly attachments: readonly RawEmailAttachmentMetadata[];
  readonly extracted_documents_text: string;
  readonly requires_multimodal_fallback: boolean;
  readonly multimodal_reason: string;
}

/** Cuerpo ya saneado junto a todo lo que se deriva de la fuente elegida. */
export interface ExtractedBody {
  readonly source: BodySource;
  readonly clean: string;
  readonly urls: readonly string[];
  /** Longitud de la fuente CONSUMIDA, no del correo entero. Ver `buildParsedEmail`. */
  readonly originalLength: number;
}

/**
 * Avisos que la composicion emite y que el LLAMANTE decide donde publicar.
 *
 * Existen porque estas funciones tienen que ser PURAS para poder consumirse
 * desde `WizardService` sin cablear inyeccion de dependencias: no pueden tener
 * un `Logger` dentro. `ParserEmailStrategy` los enchufa a su propio logger; el
 * asistente los devuelve al navegador, que es justamente lo que hace util al
 * banco de pruebas —hoy el aviso "no se pudo sanear el marcado" solo existe en
 * el `.log` del servidor y nadie que rellene un formulario lo ve.
 *
 * Es el mismo patron que `createImapClient(config, password, onError)`, que ya
 * se consume desde el asistente por esta misma razon.
 */
export interface ParsedEmailHooks {
  readonly onSanitizeFailure?: (reason: string) => void;
  readonly onMultimodalFallback?: (reason: string) => void;
  /**
   * Un adjunto del que no se pudo sacar texto por estar ilegible.
   *
   * Ni bloquea ni levanta la bandera multimodal: un `.docx` corrupto no lo
   * arregla un modelo con vision, de modo que conservar sus megabytes para
   * mandarselos seria pagar la llamada mas cara del pipeline por un fichero
   * roto. Es el mismo trato no bloqueante que `ImapTriggerStrategy` da a un
   * adjunto descartado por tipo MIME.
   */
  readonly onDocumentFailure?: (filename: string, reason: string) => void;
  /**
   * Aviso no bloqueante sobre un adjunto que SI se pudo leer.
   *
   * Hoy lo dispara el libro de calculo con varias hojas, del que solo se
   * extrae la primera. No es un fallo —hay texto, y es el bueno—, pero el
   * operador tiene que poder enterarse de que el fichero traia mas.
   *
   * Existe por la misma razon que los demas: `extractTextFromBuffer` tiene que
   * seguir siendo pura para poder consumirse desde `WizardService` sin cablear
   * inyeccion de dependencias, asi que no puede tener un `Logger` dentro.
   */
  readonly onDocumentNotice?: (filename: string, notice: string) => void;
  /**
   * Habia marcado que mirar y aun asi no salio ni un enlace aprovechable.
   *
   * Se dispara SOLO cuando existia HTML: un correo `text/plain` puro no tiene
   * ningun `<a>` que recoger, y avisar ahi convertiria el aviso en ruido
   * constante en vez de en una senal. Ni bloquea ni cambia el payload —
   * `extracted_urls` sigue siendo `[]`, nunca `null`—: existe para que el
   * operador sepa POR QUE `EXTRACTOR_WEB` no va a recibir nada.
   */
  readonly onNoUrlsFound?: () => void;
}

/** Normaliza a cadena un valor de namespace de tipo desconocido. */
const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Proyecta un elemento del inventario de adjuntos a sus metadatos.
 *
 * Trabaja sobre `unknown` porque lo que llega del contexto es
 * `Record<string, unknown>`: el namespace se rehidrata desde una columna jsonb y
 * nada garantiza su forma mas alla de lo que escribio el nodo anterior.
 */
const toAttachmentMetadata = (value: unknown): RawEmailAttachmentMetadata => {
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const size = record.size;

  return {
    filename: asString(record.filename),
    contentType:
      asString(record.contentType) || DEFAULT_ATTACHMENT_CONTENT_TYPE,
    size: typeof size === 'number' ? size : 0,
  };
};

/**
 * Enlaces del marcado, degradando a `[]` si cheerio no puede con el.
 *
 * Mismo criterio que la rama HTML de `extractEmailBody`: el motor normaliza toda
 * excepcion a URGENTE, que `canRetry` nunca reintenta, y un correo con marcado
 * patologico no puede llevarse por delante la ejecucion entera. Aqui la
 * degradacion es ademas menos grave, porque el CUERPO ya esta resuelto desde el
 * texto plano: lo unico que se pierde son los enlaces.
 */
const safeExtractUrls = (
  html: string,
  hooks: ParsedEmailHooks,
): readonly string[] => {
  try {
    return extractEmailUrls(html);
  } catch (error) {
    hooks.onSanitizeFailure?.(
      error instanceof Error ? error.message : String(error),
    );

    return [];
  }
};

/**
 * Resuelve la cascada texto -> marcado -> nada y devuelve todo lo derivado.
 *
 * El texto plano manda cuando existe: ya es texto, y saltarse el DOM ahorra la
 * operacion mas cara del nodo. El marcado es el plan B del
 * `multipart/alternative` sin parte `text/plain`, que es justamente el caso
 * habitual de un boletin institucional.
 *
 * Los ENLACES, en cambio, salen siempre del marcado, gane quien gane el cuerpo.
 * Rescatarlos del texto plano con un `https?://\S+` es posible pero inutil: ese
 * texto parte las URLs a 78 columnas (RFC 5322) y produciria direcciones
 * truncadas que `EXTRACTOR_WEB` intentaria descargar y fallaria. El marcado del
 * MISMO correo las declara enteras en `<a href>`, asi que se leen de ahi. Antes
 * quedaban vacias en esta rama, y como un correo de Gmail siempre trae las dos
 * partes, eso dejaba a `EXTRACTOR_WEB` sin nada que escrapear.
 */
export const extractEmailBody = (
  text: string,
  html: string,
  hooks: ParsedEmailHooks = {},
): ExtractedBody => {
  if (text.trim().length > 0) {
    return {
      source: 'text',
      clean: sanitizeEmailText(text),
      urls: safeExtractUrls(html, hooks),
      originalLength: text.length,
    };
  }

  if (html.trim().length > 0) {
    try {
      const sanitized = sanitizeEmailHtml(html);

      return {
        source: 'html',
        clean: sanitized.text,
        urls: sanitized.urls,
        originalLength: html.length,
      };
    } catch (error) {
      // Degradacion, no fallo. El motor normaliza toda excepcion a URGENTE,
      // que `canRetry` nunca reintenta y que deja el flujo FALLIDO: un correo
      // con marcado patologico no puede llevarse por delante la ejecucion
      // entera. El inventario de adjuntos y la decision multimodal siguen
      // siendo utiles sin cuerpo.
      hooks.onSanitizeFailure?.(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return { source: 'none', clean: '', urls: [], originalLength: 0 };
};

/** Texto de los adjuntos legibles mas el recuento de candidatos a vision. */
interface DocumentsExtraction {
  readonly text: string;
  readonly visualCandidateCount: number;
  /** Candidatos a vision con tamano de captura (`MIN_INLINE_CAPTURE_BYTES`). */
  readonly captureCandidateCount: number;
}

/**
 * Decodifica el binario de un adjunto, o `null` si no hay nada que decodificar.
 *
 * `contentBase64` es `string | null` por contrato, y el `null` NO es un caso
 * raro: el motor lo pone ahi en cuanto algun nodo anterior emitio texto util. Un
 * adjunto ya liberado no se puede evaluar, y tratarlo como "sin texto" lo
 * convertiria en candidato a vision cuando lo unico que pasa es que su binario
 * ya no esta.
 */
/** Aviso emitido por cada adjunto omitido por la lista de exclusiones. */
export const EXCLUDED_BY_CONFIG_NOTICE =
  'Excluido por configuracion del nodo; el fichero sigue disponible en el namespace de origen.';

/**
 * Devuelve la extension del nombre de fichero en forma canonica, o `''`.
 *
 * Se decide por el NOMBRE y no por el `contentType` porque es el nombre lo que
 * el operador teclea en el formulario. El tipo MIME que ponen los clientes de
 * correo no es fiable para esto: `application/octet-stream` es el valor por
 * defecto de un inventario rehidratado desde jsonb y no distingue un `.pptx` de
 * un `.zip`.
 */
const extensionOf = (filename: string): string => {
  const dotIndex = filename.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return '';
  }

  return filename.slice(dotIndex).toLowerCase();
};

const decodeAttachment = (value: unknown): Buffer | null => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const buffer = Buffer.from(value, 'base64');

  return buffer.length > 0 ? buffer : null;
};

/**
 * Extrae el texto nativo de cada adjunto legible. CERO OCR.
 *
 * Devuelve ademas cuantos adjuntos quedaron SIN texto siendo de un tipo que solo
 * un modelo con vision puede interpretar. Esa cuenta es la segunda mitad del AND
 * de `requires_multimodal_fallback`, y se calcula aqui porque depende del
 * resultado de la extraccion: un PDF con texto nativo deja de ser candidato en
 * cuanto se le saca el contenido, que es justo el ahorro que persigue este nodo.
 *
 * El separador nombra el fichero a proposito: el destinatario del texto es un
 * modelo de lenguaje, y sin la marca no podria atribuir una cifra al documento
 * del que salio cuando el correo trae tres adjuntos distintos.
 */
const extractAttachmentDocuments = async (
  rawAttachments: readonly unknown[],
  config: ResolvedParserEmailConfig,
  hooks: ParsedEmailHooks,
): Promise<DocumentsExtraction> => {
  // Atajo total: ni se decodifica. Con `skipDocumentExtraction` encendido, el
  // unico trabajo que queda es no hacerlo, y pasar por el bucle solo serviria
  // para volcar a memoria los megabytes en base64 que luego se descartan.
  if (config.skipDocumentExtraction) {
    return { text: '', visualCandidateCount: 0, captureCandidateCount: 0 };
  }

  const excluded = new Set(config.excludedExtensions);
  const chunks: string[] = [];
  let visualCandidateCount = 0;
  let captureCandidateCount = 0;

  for (const raw of rawAttachments) {
    const record =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    const filename = asString(record.filename);
    const contentType =
      asString(record.contentType) || DEFAULT_ATTACHMENT_CONTENT_TYPE;
    // La exclusion se resuelve ANTES de decodificar: un `.pptx` corporativo de
    // varios megabytes no tiene por que pasar por `Buffer.from(..., 'base64')`
    // para acabar descartado.
    //
    // Y no incrementa `visualCandidateCount`. Excluir es una decision explicita
    // del operador, no una incapacidad del extractor: contarlo aqui encenderia
    // `requires_multimodal_fallback` y, con `failOnUnextractableMedia`, dejaria
    // el flujo PAUSADO por el fichero que se pidio ignorar.
    if (excluded.has(extensionOf(filename))) {
      hooks.onDocumentNotice?.(filename, EXCLUDED_BY_CONFIG_NOTICE);
      continue;
    }

    const buffer = decodeAttachment(record.contentBase64);

    if (buffer === null) {
      continue;
    }

    // El nombre viaja al extractor para desempatar por extension: el tipo
    // `application/vnd.ms-excel` lo ponen los clientes tanto a un `.xls`
    // binario como al `.csv` que Excel acaba de exportar, y
    // `application/octet-stream` —que es ademas el valor por defecto de un
    // inventario rehidratado desde jsonb— no dice nada en absoluto.
    const extraction = await extractTextFromBuffer(
      buffer,
      contentType,
      filename,
    );

    if (extraction.failure !== null) {
      hooks.onDocumentFailure?.(filename, extraction.failure);
    }

    for (const notice of extraction.notices) {
      hooks.onDocumentNotice?.(filename, notice);
    }

    const text = extraction.text.trim();

    if (text.length > 0) {
      // La etiqueta nombra el origen DENTRO del fichero (`Hoja: Datos`,
      // `Presentación`). La cabecera se compone aqui y no en el extractor
      // porque este bloque solo se emite cuando hay texto: si el extractor
      // devolviera el texto ya encabezado, una extraccion vacia dejaria de ser
      // la cadena vacia y se romperian tanto esta guarda como el recuento de
      // candidatos a vision de mas abajo.
      const header =
        extraction.label === null
          ? `--- Documento: ${filename} ---`
          : `--- Documento: ${filename} (${extraction.label}) ---`;

      chunks.push(`${header}\n\n${text}`);
      continue;
    }

    // Sin texto. Solo cuenta como candidato a vision si el TIPO lo justifica:
    // una imagen o un PDF escaneado los lee un modelo multimodal, pero un
    // `.docx` corrupto o un `.xlsx` ilegible no los arregla nadie, y contarlos
    // aqui retendria sus megabytes para una llamada que no puede servir.
    if (MULTIMODAL_CONTENT_TYPE_PATTERN.test(contentType)) {
      visualCandidateCount += 1;

      // Bytes REALES decodificados: el `size` del inventario lo declara el
      // remitente y un jsonb rehidratado puede no traerlo.
      if (buffer.length >= MIN_INLINE_CAPTURE_BYTES) {
        captureCandidateCount += 1;
      }
    }
  }

  return {
    text: chunks.join('\n\n'),
    visualCandidateCount,
    captureCandidateCount,
  };
};

/**
 * Proyecta un correo crudo al payload determinista de `parsed_email`.
 *
 * Es la UNICA implementacion de esta composicion. La consumen
 * `ParserEmailStrategy` —en la ejecucion real del flujo— y `WizardService` —en
 * el banco de pruebas del asistente—, y esa unicidad es la razon de ser del
 * archivo: si el asistente reimplementase la cascada, el AND multimodal o las
 * metricas, divergirian en la primera correccion y el sintoma seria el peor
 * posible, un banco de pruebas que anuncia una reduccion que la ejecucion real
 * no produce.
 *
 * Pura y sin estado: no toca el contexto, no registra nada y no lanza salvo que
 * lo haga el saneador, que ya se captura dentro de `extractEmailBody`.
 *
 * @param source Namespace del correo crudo, tal y como lo deja `TRIGGER_IMAP`.
 * @param config Configuracion del nodo con los valores por defecto aplicados.
 * @param hooks Canales de aviso; ver `ParsedEmailHooks`.
 */
export const buildParsedEmail = async (
  source: Record<string, unknown>,
  config: ResolvedParserEmailConfig,
  hooks: ParsedEmailHooks = {},
): Promise<ParsedEmailPayload> => {
  const rawAttachments = Array.isArray(source.attachments)
    ? (source.attachments as readonly unknown[])
    : [];
  const attachments = rawAttachments.map(toAttachmentMetadata);

  const subject = asString(source.subject);
  const html = asString(source.html);
  const body = extractEmailBody(asString(source.text), html, hooks);

  // El aviso se condiciona a que HUBIERA marcado: sin el no hay ningun `<a>` que
  // recoger, y disparar aqui en cada correo de texto plano convertiria la senal
  // en ruido. Con marcado y cero enlaces si hay algo que contar, porque es justo
  // el caso en que `EXTRACTOR_WEB` se va a quedar sin trabajo.
  if (html.trim().length > 0 && body.urls.length === 0) {
    hooks.onNoUrlsFound?.();
  }

  const documents = await extractAttachmentDocuments(
    rawAttachments,
    config,
    hooks,
  );
  const bodyLength = body.clean.length;

  // El texto UTIL suma cuerpo y documentos. Es el cambio que hace barato el
  // caso mas comun del corpus —la nota de prensa que viaja entera en un PDF
  // adjunto con un "Ver adjunto." por cuerpo—: antes se iba a un modelo con
  // vision, y ahora basta con el texto nativo que el propio PDF ya traia.
  const usefulLength = bodyLength + documents.text.length;

  // La bandera exige AMBAS condiciones. El AND es deliberado: un boletin con
  // el logo en PNG y cinco mil caracteres de texto no necesita vision, y
  // gastarla ahi seria la llamada mas cara del pipeline sin motivo. El caso
  // que si la merece es el contrario: un correo cuyo unico contenido real es
  // un PDF escaneado o una captura, de los que no se saco ni un caracter.
  const lacksUsefulText =
    documents.visualCandidateCount > 0 && usefulLength < config.minBodyLength;

  // SEGUNDA via, independiente del listado: el cuerpo CITA una imagen en linea
  // y hay una captura sin texto. Es el correo de presentacion —"os adjuntamos
  // la captura del panel"— con la tabla dentro de una imagen: sus cuatrocientos
  // caracteres superaban el umbral, el modelo no veia la tabla y respondia que
  // no habia datos. El tamano minimo deja fuera los logotipos de firma, que
  // tambien dejan su marcador en el texto plano.
  const citesInlineCapture =
    documents.captureCandidateCount > 0 &&
    INLINE_IMAGE_PLACEHOLDER_PATTERN.test(body.clean);

  const requiresMultimodal = lacksUsefulText || citesInlineCapture;

  // Cadena vacia y nunca `null` cuando la bandera es `false`: un booleano
  // suelto en el checkpoint no explica nada seis horas despues.
  const multimodalReason = lacksUsefulText
    ? `Texto util de ${usefulLength} caracteres (cuerpo ${bodyLength} + documentos ${documents.text.length}, umbral ${config.minBodyLength}) con ${documents.visualCandidateCount} adjunto(s) de tipo imagen o PDF sin texto extraible.`
    : citesInlineCapture
      ? `El cuerpo cita una imagen en linea y hay ${documents.captureCandidateCount} captura(s) sin texto extraible (al menos ${MIN_INLINE_CAPTURE_BYTES} bytes): sus datos solo se leen con vision.`
      : '';

  if (requiresMultimodal) {
    hooks.onMultimodalFallback?.(multimodalReason);
  }

  return {
    subject,
    // El asunto crudo se conserva ADEMAS del limpio: la traza forense necesita
    // poder reconstruir que llego, y una plantilla que quiera el literal lo
    // tiene. Son dos datos distintos, no uno normalizado.
    clean_title: cleanSubject(subject),
    clean_body: body.clean,
    body_source: body.source,
    character_count: bodyLength,
    // La longitud de la FUENTE CONSUMIDA, no la del correo entero. La pareja
    // (original, final) tiene que ser la entrada y la salida de la MISMA
    // transformacion: medir siempre contra `html` daria una division por cero
    // en un correo text/plain puro, y medir siempre contra `text` daria 0% en
    // la ruta HTML, que es justo donde la reduccion es del 80-95% y donde
    // RNF-01 tiene algo que medir.
    original_character_count: body.originalLength,
    reduction_percentage: reductionPercentage(body.originalLength, bodyLength),
    extracted_urls: body.urls,
    attachment_count: attachments.length,
    // Inventario SIN el base64: repetir los bytes en un segundo namespace
    // duplicaria los mismos megabytes dentro de la misma fila
    // `contexto_acumulado`, y ademas los reintroduciria despues de que el
    // motor los hubiese liberado de `raw_email`.
    attachments,
    // Texto NATIVO de los adjuntos, sin OCR. Va detras del inventario porque de
    // el se deriva, y delante de la bandera porque es lo que la decide.
    extracted_documents_text: documents.text,
    requires_multimodal_fallback: requiresMultimodal,
    multimodal_reason: multimodalReason,
  };
};
