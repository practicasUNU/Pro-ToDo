import * as cheerio from 'cheerio';

import type { CheerioAPI } from 'cheerio';

/** Resultado de una unica pasada de saneado sobre un cuerpo HTML. */
export interface SanitizedEmailBody {
  readonly text: string;
  readonly urls: readonly string[];
}

/**
 * Tope duro de enlaces publicados en `parsed_email.extracted_urls`.
 *
 * Un boletin puede traer trescientos enlaces, y ese arreglo se reserializa
 * ENTERO en `ejecuciones_flujo.contexto_acumulado` en cada checkpoint posterior.
 * Es el mismo argumento de peso que motivo la politica de purga de binarios, a
 * otra escala. Va como constante y no como opcion del DTO porque es un limite de
 * integridad, no una preferencia de flujo.
 */
export const MAX_EXTRACTED_URLS = 50;

/**
 * Un parrafo mas largo que esto es prosa, no un pie de correo.
 *
 * Es la red de seguridad de `stripTrailingBoilerplate`: si el aviso legal viene
 * pegado al cuerpo sin linea en blanco de por medio, el parrafo resultante
 * supera el tope y NO se retira. Se prefiere conservar ruido a perder contenido.
 */
const BOILERPLATE_MAX_PARAGRAPH_CHARS = 800;

/**
 * Ruido estructural: se borra el nodo y todo su contenido.
 *
 * `script` y `style` son los criticos —su texto interior acabaria en
 * `clean_body` como si fuera prosa—, pero `head`, `meta`, `link` y `title`
 * tambien entran porque un correo reenviado a veces arrastra el documento
 * completo.
 */
const NOISE_SELECTORS =
  'script, style, noscript, iframe, object, embed, svg, head, meta, link, title, ' +
  '[aria-hidden="true"], [hidden]';

/**
 * Contenedores de firma y de cita que los clientes de correo emiten de forma
 * estable. Se borra el nodo entero: envuelven lo que sobra.
 */
const QUOTE_AND_SIGNATURE_SELECTORS = [
  // Gmail
  '.gmail_signature',
  '.gmail_quote',
  '.gmail_quote_container',
  '.gmail_attr',
  // Thunderbird / SeaMonkey
  '.moz-signature',
  '.moz-cite-prefix',
  'blockquote[type="cite"]',
  // Yahoo / Apple Mail
  '.yahoo_quoted',
  '.ydp-signature',
  '.AppleMailSignature',
].join(', ');

/**
 * Marcadores de corte de Outlook.
 *
 * A diferencia de los anteriores, estos NO envuelven la cita: la PRECEDEN.
 * Borrar solo el marcador dejaria el hilo citado entero dentro de `clean_body`,
 * que es justo lo que se quiere evitar. Por eso tienen su propio tratamiento en
 * `dropFromHereOnwards`.
 */
const CUT_MARKER_SELECTORS = '#appendonsend, [id^="divRplyFwdMsg"], #Signature';

/**
 * Elementos que separan parrafos. Reciben un salto de linea antes y despues.
 *
 * `td` y `th` NO estan aqui a proposito: van en `CELL_SELECTORS` con separador
 * de espacio.
 */
const BLOCK_SELECTORS =
  'p, div, section, article, header, footer, main, aside, nav, ' +
  'h1, h2, h3, h4, h5, h6, hgroup, li, tr, table, ul, ol, dl, dt, dd, ' +
  'blockquote, pre, address, figure, figcaption, form, fieldset, hr';

/**
 * Celdas de tabla: separador de ESPACIO, no de salto.
 *
 * Con `\n` una fila horizontal se convertiria en una columna y una tabla de
 * datos perderia la unica estructura que tenia. Importa: un correo de Outlook
 * es, estructuralmente, tablas anidadas.
 */
const CELL_SELECTORS = 'td, th';

/**
 * Divisores de cadena de respuesta y reenvio, en PROSA.
 *
 * La division del trabajo es deliberada: el DOM resuelve la ESTRUCTURA y el
 * regex resuelve la PROSA. `-----Mensaje original-----` y `El ... escribio:` son
 * texto, no marcado, y ningun `blockquote` los envuelve de forma fiable.
 */
const REPLY_DIVIDER_PATTERNS: readonly RegExp[] = [
  // Outlook / Gmail, ES + EN + FR. Dos o mas guiones a cada lado.
  /^[ \t]*-{2,}[ \t]*(?:Original Message|Mensaje original|Mensaje reenviado|Forwarded message|Message transf[ée]r[ée]|Message d'origine)[ \t]*-{2,}[ \t]*$/im,
  // Regla horizontal de guiones bajos que Outlook inserta antes del hilo.
  /^[ \t]*_{10,}[ \t]*$/m,
  // Linea de atribucion. Exige una @ dentro: sin ella, cualquier parrafo que
  // contuviera "escribio" doscientos caracteres despues de un inicio de linea
  // decapitaria la noticia.
  /^[ \t]*El\b[\s\S]{0,200}?@[\s\S]{0,80}?\bescribi[oó][ \t]*:/im,
  /^[ \t]*On\b[\s\S]{0,200}?@[\s\S]{0,80}?\bwrote[ \t]*:/im,
  /^[ \t]*Le\b[\s\S]{0,200}?@[\s\S]{0,80}?\ba[ \t]+[ée]crit[ \t]*:/im,
  // Cabeceras del reenvio pegadas: "De: ...\nEnviado el: ..."
  /^[ \t]*(?:De|From)[ \t]*:[^\n]{0,200}\n[ \t]*(?:Enviado(?: el)?|Sent|Fecha|Date)[ \t]*:/im,
];

/** Delimitador de firma de la RFC 3676 section 4.3: exactamente dos guiones solos. */
const SIGNATURE_DELIMITER_PATTERN = /^[ \t]*--[ \t]*$/m;

/**
 * Pies legales y textos de cortesia, ES + EN.
 *
 * Solo se aplican a la RACHA FINAL de parrafos (ver `stripTrailingBoilerplate`),
 * nunca a todo el cuerpo.
 */
const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /aviso\s+(?:legal|de\s+confidencialidad)/i,
  /informaci[oó]n\s+confidencial/i,
  /este\s+(?:mensaje|correo|e-?mail)\s+(?:y\s+(?:sus|los)\s+)?(?:archivos\s+|ficheros\s+)?(?:adjuntos?\s+)?(?:es|son|va|puede|pueden)\b/i,
  /protecci[oó]n\s+de\s+datos|\bRGPD\b|\bGDPR\b|\bLOPD(?:GDD)?\b|Reglamento\s*\(UE\)\s*2016\/679/i,
  /derechos?\s+de\s+acceso,?\s*rectificaci[oó]n/i,
  /confidential(?:ity)?\s+(?:notice|information)/i,
  /this\s+(?:e-?mail|message)\s+(?:and\s+any\s+attachments?\s+)?(?:is|are|may\s+be)\s+(?:confidential|privileged)/i,
  /if\s+you\s+are\s+not\s+the\s+intended\s+recipient/i,
  /(?:no\s+)?imprima\s+este\s+(?:mensaje|correo)|think\s+before\s+you\s+print/i,
  /darse\s+de\s+baja|cancelar\s+(?:la\s+)?suscripci[oó]n|\bunsubscribe\b/i,
];

/**
 * Remitentes masivos y redirectores de clic: la URL no apunta al contenido sino
 * a un contador que rebota. `EXTRACTOR_WEB` no sacaria nada de ellas.
 */
const TRACKING_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)list-manage\.com$/i,
  /(^|\.)mailchi\.mp$/i,
  /(^|\.)sendgrid\.net$/i,
  /(^|\.)mandrillapp\.com$/i,
  /(^|\.)sparkpostmail\.com$/i,
  /(^|\.)mailgun\.org$/i,
  /(^|\.)awstrack\.me$/i,
  /(^|\.)hubspotlinks\.com$/i,
  /(^|\.)brevo\.com$/i,
  /(^|\.)sendinblue\.com$/i,
  /(^|\.)acumbamail\.com$/i,
  /(^|\.)doppler\.io$/i,
  /(^|\.)mailtrack\.io$/i,
  /(^|\.)bit\.ly$/i,
];

/**
 * Las cuatro familias de redes sociales pedidas, con sus acortadores propios.
 *
 * FUERA a proposito: YouTube, TikTok, Threads, WhatsApp y Telegram. Una nota de
 * prensa que enlaza un video institucional esta enlazando CONTENIDO, y este
 * pipeline es de recorte de prensa. Que nadie los anada "por simetria".
 */
const SOCIAL_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)twitter\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)t\.co$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)fb\.com$/i,
  /(^|\.)fb\.me$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)lnkd\.in$/i,
  /(^|\.)instagram\.com$/i,
  /(^|\.)instagr\.am$/i,
];

/** Marcas de desuscripcion y de "version web" en la ruta o el query. */
const UNSUBSCRIBE_URL_PATTERN =
  /(?:unsubscribe|desuscri|darse[-_]?de[-_]?baja|baja[-_]?bolet|opt[-_]?out|manage[-_ ]?preferences|email[-_]?preferences|webversion|view[-_]?in[-_]?browser|ver[-_]?en[-_]?navegador|forward[-_]?to[-_]?friend|politica[-_]?de[-_]?privacidad|aviso[-_]?legal)/i;

/**
 * Las mismas marcas, pero en el TEXTO del ancla.
 *
 * Hace falta ademas del patron de URL porque muchos boletines esconden el
 * enlace tras un redirector opaco de `list-manage.com`, donde la ruta es un
 * identificador ilegible y solo el texto ("Darse de baja") delata la funcion.
 */
const UNSUBSCRIBE_TEXT_PATTERN =
  /\b(?:darse\s+de\s+baja|cancelar\s+(?:la\s+)?suscripci[oó]n|baja\s+del?\s+bolet[ií]n|unsubscribe|opt\s*out|ver\s+(?:esta\s+)?versi[oó]n\s+(?:web|en\s+el\s+navegador)|view\s+(?:this\s+)?(?:email\s+)?in\s+(?:your\s+)?browser|pol[ií]tica\s+de\s+privacidad|aviso\s+legal)\b/i;

/**
 * Parametros de campana que se retiran de la URL.
 *
 * El motivo es operativo y no estetico: dos enlaces al MISMO articulo que solo
 * difieren en `utm_content` sobreviven a la deduplicacion por `Set`, y
 * `EXTRACTOR_WEB` acaba pagando dos navegaciones de Playwright por la misma
 * pagina.
 *
 * `ref` y `spm` quedan FUERA: hay sitios que los usan funcionalmente para
 * enrutar, y quitarlos cambiaria la pagina que se descarga.
 */
const TRACKING_QUERY_KEYS = new Set([
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'igshid',
  'vero_id',
  'xtor',
  'at_medium',
  'at_campaign',
  'ck_subscriber_id',
  'oly_enc_id',
]);

/** Prefijo de la familia `utm_*`, que se retira entera sin enumerarla. */
const TRACKING_QUERY_PREFIX = 'utm_';

/**
 * Prefijos encadenados de respuesta y reenvio de un asunto.
 *
 * El `+` exterior cubre las cadenas (`Fwd: Re: RV: ENC: Noticia`); el grupo
 * numerico cubre `Re[2]:`, `RE(2):` y `RE2:` de los clientes que cuentan saltos.
 *
 * FUERA de la lista a proposito: `ref` (un `Ref: 2026/45` es una referencia de
 * expediente, no un reenvio) y `r` / `tr` sueltos, demasiado cortos para no
 * colisionar con prosa. El criterio es falso negativo antes que falso positivo:
 * dejar un `TR:` es ruido, comerse media palabra del titular es perdida de
 * informacion.
 */
const SUBJECT_PREFIX_PATTERN =
  /^(?:\s*(?:re|rep|r[eé]p|fwd?|rv|reenv|enc|aw|wg|antw)\s*(?:\[\s*\d{1,3}\s*\]|\(\s*\d{1,3}\s*\)|\d{1,3})?\s*:)+\s*/i;

/** Separador de parrafo tras `normalizeWhitespace`: una linea en blanco. */
const PARAGRAPH_SEPARATOR = '\n\n';

/**
 * Elimina el elemento y todo lo que viene DESPUES de el en el documento.
 *
 * Los marcadores de Outlook (`#appendonsend`, `#divRplyFwdMsg`) no envuelven la
 * cita: la preceden como hermanos. Se sube por los ancestros barriendo los
 * hermanos posteriores en cada nivel, que es la unica forma de alcanzar el hilo
 * entero cuando el marcador esta anidado en un `<div>` intermedio.
 */
const dropFromHereOnwards = ($: CheerioAPI, selector: string): void => {
  $(selector).each((_index, element) => {
    let current = $(element);

    // El barrido va ANTES de subir, no en la condicion del bucle: en modo
    // fragmento `parent()` de un elemento de primer nivel devuelve vacio, asi
    // que comprobarlo en el `while` dejaria sin barrer justo el ultimo nivel
    // —el de los hermanos que cuelgan de la raiz— y el hilo citado sobreviviria.
    while (current.length > 0) {
      current.nextAll().remove();
      current = current.parent();
    }

    $(element).remove();
  });
};

/**
 * Corta el texto en la primera aparicion de cualquiera de los patrones.
 *
 * Ninguno de los patrones lleva el flag `g`, asi que `exec` no arrastra
 * `lastIndex` entre llamadas y la funcion es reentrante.
 */
const cutAtEarliestMarker = (
  text: string,
  patterns: readonly RegExp[],
): string => {
  let cutIndex = -1;

  for (const pattern of patterns) {
    const match = pattern.exec(text);

    if (match === null) {
      continue;
    }

    if (cutIndex === -1 || match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  if (cutIndex < 0) {
    return text;
  }

  const head = text.slice(0, cutIndex);

  // Un reenvio puro —cuerpo vacio y toda la sustancia dentro de la cita— se
  // quedaria sin nada. Si cortar deja la cabeza vacia NO se corta: es preferible
  // entregar la cita que entregar la nada.
  if (head.trim().length === 0) {
    return text;
  }

  return head;
};

/** Promueve una URL protocol-relative y rechaza todo lo que no sea http(s). */
const parseAbsoluteUrl = (href: string): URL | null => {
  const raw = href.trim();

  if (raw.length === 0) {
    return null;
  }

  // `//host/ruta` lleva el host explicito: promoverla a https no inventa nada.
  // Una ruta relativa, en cambio, se descarta mas abajo al lanzar `new URL`: un
  // correo no tiene documento base, y derivarla del dominio del remitente
  // fabricaria una direccion que puede no existir.
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw;

  try {
    const url = new URL(candidate);

    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
};

/** El host pertenece a un redirector de campana o a una red social. */
const isDiscardableHost = (hostname: string): boolean =>
  TRACKING_HOST_PATTERNS.some((pattern) => pattern.test(hostname)) ||
  SOCIAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));

/** La ruta o el query delatan una baja de suscripcion o una version web. */
const isUnsubscribeUrl = (url: URL): boolean =>
  UNSUBSCRIBE_URL_PATTERN.test(`${url.pathname}${url.search}`);

/** Devuelve una copia de la URL sin sus parametros de campana. */
const withoutTrackingParams = (url: URL): URL => {
  const clean = new URL(url.toString());

  // La instantanea con spread es obligatoria: borrar mientras se itera el
  // iterador vivo de `searchParams` se salta claves.
  for (const key of [...clean.searchParams.keys()]) {
    const normalized = key.toLowerCase();

    if (
      TRACKING_QUERY_KEYS.has(normalized) ||
      normalized.startsWith(TRACKING_QUERY_PREFIX)
    ) {
      clean.searchParams.delete(key);
    }
  }

  return clean;
};

/**
 * Recoge los enlaces de contenido del DOM YA PODADO.
 *
 * Se invoca despues de retirar ruido, firmas y citas y antes de aplanar a texto.
 * Ese orden no es casual: un enlace de desuscripcion que vivia dentro de una
 * firma ya eliminada no debe reaparecer aqui, y asi `clean_body` y
 * `extracted_urls` describen exactamente el mismo documento.
 *
 * El `Set` preserva el orden de insercion, de modo que la lista resultante sigue
 * el orden de aparicion en el correo.
 */
const collectUrls = ($: CheerioAPI): string[] => {
  const collected = new Set<string>();

  $('a[href]').each((_index, element) => {
    if (collected.size >= MAX_EXTRACTED_URLS) {
      return;
    }

    const href = $(element).attr('href');

    if (href === undefined) {
      return;
    }

    const url = parseAbsoluteUrl(href);

    if (url === null || isDiscardableHost(url.hostname)) {
      return;
    }

    if (
      isUnsubscribeUrl(url) ||
      UNSUBSCRIBE_TEXT_PATTERN.test($(element).text())
    ) {
      return;
    }

    collected.add(withoutTrackingParams(url).toString());
  });

  return [...collected].slice(0, MAX_EXTRACTED_URLS);
};

/**
 * Normaliza saltos, espacios y caracteres invisibles. NO elimina contenido.
 *
 * EL ORDEN IMPORTA. El paso 2 va antes que el 5 porque cheerio decodifica
 * `&nbsp;` a U+00A0, que NO es un espacio ASCII: sin convertirlo primero,
 * `/[ \t]+/` no lo colapsa y el `character_count` acaba inflado con espacios
 * duros invisibles. Es el fallo silencioso clasico de esta transformacion.
 */
export const normalizeWhitespace = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n') // 1. CRLF y CR sueltos
    .replace(/[\u00A0\u2007\u202F]/g, ' ') // 2. &nbsp; y sus primos
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '') // 3. espaciadores invisibles
    .replace(/[\u2028\u2029]/g, '\n') // 4. separadores Unicode
    .replace(/[ \t]+/g, ' ') // 5. colapsa horizontal
    .replace(/[ \t]*\n[ \t]*/g, '\n') // 6. recorta cada linea
    .replace(/\n{3,}/g, '\n\n') // 7. maximo un parrafo en blanco
    .trim();

/** Corta la cadena de respuesta o reenvio en el primer divisor reconocido. */
export const stripReplyChain = (text: string): string =>
  cutAtEarliestMarker(text, REPLY_DIVIDER_PATTERNS);

/** Corta en el delimitador de firma de la RFC 3676 (dos guiones solos). */
export const stripSignatureBlock = (text: string): string =>
  cutAtEarliestMarker(text, [SIGNATURE_DELIMITER_PATTERN]);

/**
 * Retira la RACHA FINAL de parrafos que son firma o aviso legal.
 *
 * Se recorre DESDE EL FINAL hacia atras y se para en el primer parrafo que no
 * cumpla las dos condiciones. No se barre todo el cuerpo, y esto es una decision
 * de producto, no una optimizacion: el corpus de este pipeline son notas de
 * prensa institucionales, donde un comunicado sobre una nueva sede puede
 * mencionar el RGPD o la proteccion de datos en su tercer parrafo con toda
 * normalidad. Barrer por todo el texto destruiria justo el contenido que el nodo
 * existe para conservar. Limitarse a la racha final lo garantiza por
 * construccion.
 *
 * El tope de longitud es la segunda red: un aviso legal pegado al cuerpo sin
 * linea en blanco de por medio produce un parrafo largo que NO se retira.
 */
export const stripTrailingBoilerplate = (text: string): string => {
  const paragraphs = text.split(PARAGRAPH_SEPARATOR);
  let end = paragraphs.length;

  while (end > 0) {
    const paragraph = paragraphs[end - 1].trim();

    if (paragraph.length === 0) {
      end -= 1;
      continue;
    }

    if (paragraph.length > BOILERPLATE_MAX_PARAGRAPH_CHARS) {
      break;
    }

    if (!BOILERPLATE_PATTERNS.some((pattern) => pattern.test(paragraph))) {
      break;
    }

    end -= 1;
  }

  if (end === paragraphs.length) {
    return text;
  }

  const kept = paragraphs.slice(0, end).join(PARAGRAPH_SEPARATOR).trim();

  // Misma guarda que en el corte de citas: un correo cuyo cuerpo entero encaja
  // con el patron legal se devuelve intacto antes que vaciarlo.
  return kept.length > 0 ? kept : text;
};

/** Aplica las tres pasadas de prosa en su orden y recorta los extremos. */
const finalizeText = (raw: string): string =>
  stripTrailingBoilerplate(
    stripSignatureBlock(stripReplyChain(normalizeWhitespace(raw))),
  ).trim();

/**
 * Texto plano de correo a texto plano saneado.
 *
 * NO es un `trim()`. Un `text/plain` con cuarenta lineas de cita y un aviso de
 * confidencialidad entraria entero al prompt del nodo de inferencia, que es
 * exactamente el gasto que este nodo existe para evitar.
 */
export const sanitizeEmailText = (text: string): string => finalizeText(text);

/**
 * HTML de correo a texto plano y enlaces de contenido, en UNA pasada de DOM.
 *
 * Devuelve ambas salidas juntas a proposito: salen del mismo arbol ya podado.
 * Parsear dos veces duplicaria la operacion mas cara del nodo y —peor— dejaria
 * que las dos salidas discrepasen sobre que se elimino.
 *
 * Se descarto `@mozilla/readability` para esta tarea: exige un `Document` real
 * de jsdom, penaliza las tablas (y un correo de Outlook es, estructuralmente,
 * tablas anidadas), necesita una URL base que un correo no tiene, y su sistema
 * de puntuacion no es estable entre versiones menores, mientras que este payload
 * es contrato y tiene que ser reproducible.
 */
/**
 * Enlaces del marcado, SIN aplanarlo a texto.
 *
 * Existe para la ruta de TEXTO PLANO de `extractEmailBody`: ese cuerpo no tiene
 * enlaces rescatables —el texto plano de un correo parte las URLs a 78 columnas
 * (RFC 5322) y extraerlas produce direcciones truncadas—, pero la parte HTML del
 * MISMO correo si los declara bien marcados en `<a href>`. Sin esta funcion, un
 * correo de Gmail (que siempre trae las dos partes) devolvia `extracted_urls`
 * vacio por el mero hecho de que el cuerpo salia del texto.
 *
 * Se salta la fase cara de `sanitizeEmailHtml` —poda del DOM, `br`, espaciado de
 * bloques y las tres podas de prosa de `finalizeText`— porque aqui no se quiere
 * el texto, solo los enlaces. Aun asi NO es gratis: paga el parseo del marcado
 * que la rama de texto plano se ahorraba.
 *
 * Aplica exactamente los mismos filtros que `sanitizeEmailHtml`, porque invoca
 * el mismo `collectUrls`.
 */
export const extractEmailUrls = (html: string): readonly string[] =>
  html.trim().length === 0
    ? []
    : collectUrls(cheerio.load(html, { xml: { xmlMode: false } }, false));

export const sanitizeEmailHtml = (html: string): SanitizedEmailBody => {
  if (html.trim().length === 0) {
    return { text: '', urls: [] };
  }

  // Misma invocacion que `ImapTriggerStrategy` y `TemplateRendererService`:
  // `xml` como OBJETO (no `xml: true`) elige htmlparser2 sin activar el modo XML
  // sensible a mayusculas, y el tercer parametro `false` es el modo FRAGMENTO
  // —un correo llega como fragmento y parse5 le sintetizaria <html><head><body>.
  const $ = cheerio.load(html, { xml: { xmlMode: false } }, false);

  // Los enlaces se recogen ANTES de podar, y esto invierte la decision original.
  //
  // El motivo es el pipeline Notiweb: un correo REENVIADO lleva su contenido
  // —y con el sus referencias bibliograficas— dentro del `<blockquote>` que
  // `QUOTE_AND_SIGNATURE_SELECTORS` retira, de modo que recogerlos despues los
  // perdia enteros y `EXTRACTOR_WEB` se quedaba sin nada que escrapear.
  //
  // El precio, asumido: un enlace que viva en una firma tambien entra, aunque su
  // texto no aparezca en `clean_body`. `extracted_urls` deja por tanto de
  // describir el MISMO documento que el cuerpo. Lo que acota el ruido es el
  // filtrado por host y por patron de `collectUrls`, que no cambia: redes
  // sociales, redirectores de campana, desuscripciones y avisos legales siguen
  // fuera.
  const urls = collectUrls($);

  $(NOISE_SELECTORS).remove();
  dropFromHereOnwards($, CUT_MARKER_SELECTORS);
  $(QUOTE_AND_SIGNATURE_SELECTORS).remove();

  // Se MUTA el arbol insertando separadores y luego se lee `.text()`, en vez de
  // recorrerlo recursivamente. Un walk obligaria a tipar los nodos con `Element`
  // de `domhandler`, que es una dependencia transitiva y no declarada (ver la
  // nota de `TemplateRendererService.auditPublishableMarkup`). Mutar y leer solo
  // necesita selectores, y con `noImplicitAny` esa es la diferencia entre codigo
  // limpio y un `as` por nodo.
  $('br').replaceWith('\n');
  $(CELL_SELECTORS).each((_index, element) => {
    $(element).after(' ');
  });
  $(BLOCK_SELECTORS).each((_index, element) => {
    $(element).before('\n');
    $(element).after('\n');
  });

  // htmlparser2 ya decodifico las entidades durante el parseo.
  return { text: finalizeText($.root().text()), urls };
};

/**
 * Quita los prefijos encadenados de respuesta y reenvio de un asunto.
 *
 * @param subject Asunto crudo, tal cual lo entrego el nodo de ingesta.
 * @returns El titulo sin prefijos; el asunto plegado si solo habia prefijos.
 */
export const cleanSubject = (subject: string): string => {
  // El plegado MIME parte los asuntos largos con CRLF mas tabulador.
  const folded = subject.replace(/\s+/g, ' ').trim();
  const stripped = folded.replace(SUBJECT_PREFIX_PATTERN, '').trim();

  // Un asunto que SOLO eran prefijos (`Re:`) se devuelve intacto: un titulo
  // vacio es peor que un titulo con ruido, y rompe cualquier plantilla que lo
  // interpole.
  return stripped.length > 0 ? stripped : folded;
};

/**
 * Porcentaje de reduccion de caracteres, de 0 a 100 con dos decimales.
 *
 * @param original Longitud de la fuente que el nodo consumio.
 * @param final Longitud del texto saneado.
 * @returns El porcentaje acotado a [0, 100]. Nunca `NaN`.
 */
export const reductionPercentage = (
  original: number,
  final: number,
): number => {
  // Guarda de division por cero. Se devuelve 0 y no `null` ni `NaN`: `NaN` se
  // serializa a `null` al escribir el jsonb, lo que romperia en silencio la
  // regla de que toda clave esta siempre presente CON SU TIPO. Ademas, "no habia
  // nada que reducir" y "no se redujo nada" son aqui lo mismo.
  if (original <= 0) {
    return 0;
  }

  const ratio = (original - final) / original;

  // Acotado: hoy el saneado solo puede quitar caracteres, pero un futuro
  // separador que anadiera texto dejaria un porcentaje NEGATIVO en el
  // checkpoint, y nadie sabria leerlo seis meses despues.
  const bounded = Math.min(Math.max(ratio, 0), 1);

  return Math.round(bounded * 10_000) / 100;
};
