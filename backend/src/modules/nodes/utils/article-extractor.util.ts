import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import sanitizeHtml from 'sanitize-html';

import { normalizeWhitespace } from '@modules/nodes/utils/email-sanitizer.util';

/** Articulo aislado de una pagina y aplanado a texto plano. */
export interface ExtractedArticle {
  readonly title: string;
  readonly byline: string | null;
  readonly content: string;
}

/** Avisos no bloqueantes de la extraccion. */
export interface ArticleExtractionHooks {
  readonly onReadabilityFailure?: (reason: string) => void;
  readonly onContentTooShort?: (length: number) => void;
}

/**
 * Etiquetas que sobreviven al saneado.
 *
 * NO son las etiquetas de la salida —la salida no tiene ninguna—, sino las que
 * hacen falta para SABER DONDE VAN LOS SALTOS antes de aplanar. Todo lo demas
 * (`script`, `style`, `iframe`, `object`, y cualquier atributo, incluidos los
 * manejadores `on*`) se retira aqui, que es donde debe retirarse: sobre el HTML
 * hostil que acaba de servir un portal ajeno.
 */
const STRUCTURAL_TAGS = [
  'p',
  'br',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'aside',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'tbody',
  'thead',
  'tr',
  'td',
  'th',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'span',
  'strong',
  'em',
  'b',
  'i',
  'a',
];

/**
 * Elementos que separan parrafos: reciben un salto de linea antes y despues.
 *
 * `td` y `th` quedan FUERA a proposito, igual que en `email-sanitizer.util`: con
 * `\n` una fila horizontal se convertiria en una columna y una tabla de datos
 * perderia la unica estructura que tenia.
 */
const BLOCK_SELECTORS =
  'p, div, section, article, header, footer, main, aside, ' +
  'h1, h2, h3, h4, h5, h6, li, tr, blockquote, pre, figure, figcaption, dt, dd';

/** Celdas de tabla: separador de ESPACIO, para no romper la fila en columnas. */
const CELL_SELECTORS = 'td, th';

/**
 * Longitud minima, en caracteres, para dar por bueno un articulo.
 *
 * Readability devuelve un objeto tambien cuando solo ha encontrado un aviso de
 * cookies o un pie de pagina. Ese texto no es un articulo y, sin este listado,
 * viajaria al `PROCESADOR_IA` como si lo fuera: el modelo redactaria una noticia
 * a partir de "Utilizamos cookies propias y de terceros".
 */
export const MIN_ARTICLE_LENGTH = 200;

/**
 * Aplana marcado a texto plano PRESERVANDO los saltos de parrafo.
 *
 * Dos detalles que no son evidentes y que dictan el orden de los pasos:
 *
 * 1. Ni `Readability.textContent` ni `sanitizeHtml(html, { allowedTags: [] })`
 *    insertan separador alguno al retirar las etiquetas. Un articulo de tres
 *    parrafos sale de ambos como "TituloParrafo unoParrafo dos", pegado, y asi
 *    llegaria al prompt del modelo. Por eso los saltos se inyectan como NODOS DE
 *    TEXTO en el DOM antes de aplanar.
 *
 * 2. El aplanado final es `textContent` y NO una segunda pasada de
 *    `sanitize-html`. Con `allowedTags: []` la libreria retira el marcado pero
 *    RE-ESCAPA el texto resultante: un "AT&T" sale como "AT&amp;T" y un
 *    "3 < 5" como "3 &lt; 5". Serian entidades HTML viajando dentro de un campo
 *    que el contrato promete como texto plano, y acabarian literalmente en el
 *    articulo publicado. `textContent` devuelve el texto ya decodificado.
 *
 * El saneado, por tanto, va PRIMERO y con lista blanca estructural: es la
 * barrera de seguridad sobre el HTML ajeno, no el mecanismo de aplanado.
 */
const flattenToPlainText = (markup: string): string => {
  const safeMarkup = sanitizeHtml(markup, {
    allowedTags: STRUCTURAL_TAGS,
    allowedAttributes: {},
  });

  const { document } = new JSDOM(`<body>${safeMarkup}</body>`).window;

  // Los `<br>` son saltos explicitos del autor: se conservan como tales.
  for (const lineBreak of Array.from(document.querySelectorAll('br'))) {
    lineBreak.replaceWith(document.createTextNode('\n'));
  }

  for (const cell of Array.from(document.querySelectorAll(CELL_SELECTORS))) {
    cell.after(document.createTextNode(' '));
  }

  // Se usan nodos de texto y no concatenacion de cadenas para que los bloques
  // anidados no dupliquen el separador de sus hijos.
  for (const block of Array.from(document.querySelectorAll(BLOCK_SELECTORS))) {
    block.prepend(document.createTextNode('\n'));
    block.append(document.createTextNode('\n'));
  }

  // Se reutiliza el normalizador del saneador de correo: colapsa espacios,
  // convierte los `&nbsp;` (U+00A0) y limita a un unico parrafo en blanco. Su
  // TSDoc documenta por que el orden de sus pasos importa. Dos normalizadores
  // distintos sobre el mismo pipeline acaban discrepando y nadie sabe cual miro.
  return normalizeWhitespace(document.body.textContent ?? '');
};

/**
 * Aisla el articulo de una pagina web y lo devuelve como texto plano.
 *
 * Funcion PURA: no hace red ni toca disco, asi que se prueba con marcado fijo
 * sin levantar Chromium. Es la misma separacion que aplican `ParserEmailStrategy`
 * y sus utilidades —la estrategia es el contrato del nodo, la transformacion vive
 * aparte— y por la misma razon de peso: el banco de pruebas del asistente podra
 * invocar esta funcion directamente, de modo que lo que el operador ve al probar
 * sea exactamente lo que producira el nodo.
 *
 * Aqui SI se usa `@mozilla/readability`, a diferencia de `sanitizeEmailHtml`, que
 * lo descarto por razones que no aplican a este nodo: una pagina web si tiene URL
 * base, no es una tabla anidada de Outlook, y su estructura (`<article>`,
 * `<main>`, densidad de enlaces) es justo lo que el algoritmo puntua bien.
 *
 * @param html Documento completo tal y como lo sirvio el portal.
 * @param sourceUrl URL final, que Readability necesita para resolver enlaces
 *                  relativos y aplicar sus heuristicas de dominio.
 * @returns El articulo, o `null` si no hay contenido aprovechable.
 */
export const extractArticle = (
  html: string,
  sourceUrl: string,
  hooks: ArticleExtractionHooks = {},
): ExtractedArticle | null => {
  if (html.trim().length === 0) {
    hooks.onReadabilityFailure?.('El portal devolvio un documento vacio.');

    return null;
  }

  const dom = new JSDOM(html, { url: sourceUrl });
  const article = new Readability(dom.window.document).parse();

  if (article === null || article.content === null) {
    hooks.onReadabilityFailure?.(
      'Readability no identifico ningun bloque de contenido principal.',
    );

    return null;
  }

  const content = flattenToPlainText(article.content ?? '');

  if (content.length < MIN_ARTICLE_LENGTH) {
    hooks.onContentTooShort?.(content.length);

    return null;
  }

  // `byline` conserva el `null`: una cadena vacia diria "el autor es la cadena
  // vacia", y el contrato de salida distingue "sin firma" de "firmado por nadie".
  const byline = normalizeWhitespace(article.byline ?? '');

  return {
    title: normalizeWhitespace(article.title ?? ''),
    byline: byline.length > 0 ? byline : null,
    content,
  };
};
