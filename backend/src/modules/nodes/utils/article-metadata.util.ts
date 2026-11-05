// Helper puro: lee metadatos editoriales de un documento ya parseado.
//
// Se invoca ANTES de Readability, que reescribe el DOM al puntuarlo y se
// lleva por delante los <meta> y los <script type="application/ld+json">.

import { JSDOM } from 'jsdom';

import { normalizeWhitespace } from '@modules/nodes/utils/email-sanitizer.util';

/** Enlace citado dentro del cuerpo del articulo. */
export interface ArticleReference {
  readonly title: string;
  readonly url: string;
}

/** Metadatos de cabecera: autor y fecha de publicacion. */
export interface ArticleHeadMetadata {
  readonly author: string | null;
  readonly publishedAt: string | null;
}

/** Tope de referencias por articulo: un indice de enlaces no es bibliografia. */
export const MAX_ARTICLE_REFERENCES = 20;

/** Tope del texto de cada referencia, en caracteres. */
export const MAX_REFERENCE_TITLE_LENGTH = 200;

const AUTHOR_SELECTORS = [
  'meta[name="author"]',
  'meta[property="article:author"]',
  'meta[name="article:author"]',
  'meta[name="dc.creator"]',
];

/** Selectores DOM de autor, para blogs sin meta-etiquetas (F-Droid). */
const AUTHOR_DOM_SELECTORS = [
  'a[rel="author"]',
  '[itemprop="author"]',
  '.author',
  '.byline',
  '.post-meta',
  '.post-byline',
];

/** Contenedores de linea de firma: primero se busca "por/by" dentro. */
const BYLINE_CONTAINERS = new Set(['.byline', '.post-meta', '.post-byline']);

/** Cabeceras del articulo donde se busca la firma por regex. */
const HEADER_SELECTORS = [
  'article header',
  '.entry-header',
  '.entry-meta',
  '.post-header',
];

/** Tope del autor: un texto mas largo es una biografia, no un nombre. */
const MAX_AUTHOR_LENGTH = 80;

/** Tope del texto de cabecera examinado por regex. */
const MAX_HEADER_SCAN_LENGTH = 400;

/** "por X" / "by X". `\b` evita "nearby"; `\p{L}` admite tildes. */
const BYLINE_PATTERN = /\b(?:por|by)\s+([\p{L}0-9_.\- ]{2,60})/iu;

/** Conectores que cierran el nombre: "by Hans on 3 Oct" → "Hans". */
const AUTHOR_STOP_PATTERN = /\s+(?:on|at|in|el|en|a las|\||-|—)\s+.*$/iu;

const DATE_SELECTORS = [
  'meta[property="article:published_time"]',
  'meta[name="article:published_time"]',
  'meta[name="date"]',
  'meta[name="pubdate"]',
  'meta[name="DC.date.issued"]',
  'meta[itemprop="datePublished"]',
];

/** Primer `content` no vacio entre los selectores dados. */
const firstMetaContent = (
  document: Document,
  selectors: readonly string[],
): string | null => {
  for (const selector of selectors) {
    const value = normalizeWhitespace(
      document.querySelector(selector)?.getAttribute('content') ?? '',
    );

    if (value.length > 0) {
      return value;
    }
  }

  return null;
};

/**
 * Nodos JSON-LD del documento, aplanando arrays y `@graph`.
 * Un bloque malformado se ignora: un portal con un JSON roto no debe
 * tumbar la extraccion del articulo.
 */
const readJsonLdNodes = (document: Document): Record<string, unknown>[] => {
  const nodes: Record<string, unknown>[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      nodes.push(record);
      collect(record['@graph']);
    }
  };

  document
    .querySelectorAll('script[type="application/ld+json"]')
    .forEach((script) => {
      try {
        collect(JSON.parse(script.textContent ?? ''));
      } catch {
        // JSON-LD invalido: se sigue con los demas bloques.
      }
    });

  return nodes;
};

/** `name` de un objeto JSON-LD, solo si es texto. */
const jsonLdName = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/** Nombre(s) de un `author` JSON-LD: cadena, objeto con `name` o array. */
const jsonLdAuthorName = (value: unknown): string | null => {
  const names = (Array.isArray(value) ? value : [value])
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object'
          ? jsonLdName((entry as Record<string, unknown>).name)
          : '',
    )
    .map(normalizeWhitespace)
    .filter((name) => name.length > 0);

  return names.length > 0 ? names.join(', ') : null;
};

/**
 * Limpia un candidato a autor: quita el prefijo "Por"/"By", colapsa espacios
 * y descarta vacios o textos largos (cajas de biografia).
 */
const cleanAuthorText = (raw: string): string | null => {
  const collapsed = normalizeWhitespace(raw.replace(/\s+/g, ' '));

  if (collapsed.length > MAX_AUTHOR_LENGTH) {
    return null;
  }

  const text = collapsed
    .replace(/^(?:por|by)\s+/iu, '')
    .replace(AUTHOR_STOP_PATTERN, '')
    .replace(/[\s,.;:·|-]+$/u, '')
    .trim();

  return text.length > 0 && text.length <= MAX_AUTHOR_LENGTH ? text : null;
};

/** Nombre tras "por"/"by" en un texto, ya limpio. */
const matchByline = (text: string): string | null => {
  const firstLine = text.match(BYLINE_PATTERN)?.[1]?.split('\n')[0] ?? '';

  return cleanAuthorText(firstLine);
};

/**
 * Texto visible de un nodo. `textContent` ignora los `<img>` (avatares) y su
 * `alt`; `itemprop=author` puede ser `<meta content>` o llevar `[itemprop=name]`.
 */
const authorNodeText = (element: Element): string =>
  element.getAttribute('content') ??
  element.querySelector('[itemprop="name"]')?.textContent ??
  element.textContent ??
  '';

/** Autor por selectores DOM comunes, en orden de fiabilidad. */
const authorFromDom = (document: Document): string | null => {
  for (const selector of AUTHOR_DOM_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const text = authorNodeText(element);
      // En una linea de firma sin "por/by", un texto con cifras es la fecha.
      const author = BYLINE_CONTAINERS.has(selector)
        ? (matchByline(text) ??
          (/\d/.test(text) ? null : cleanAuthorText(text)))
        : cleanAuthorText(text);

      if (author !== null) {
        return author;
      }
    }
  }

  return null;
};

/** Texto con un espacio entre nodos: evita pegar "TitularPor Ana". */
const spacedText = (node: Node): string =>
  node.nodeType === node.TEXT_NODE
    ? (node.textContent ?? '')
    : Array.from(node.childNodes).map(spacedText).join(' ');

/** Ultimo recurso: "por X"/"by X" en la cabecera del articulo. */
const authorFromHeaderText = (document: Document): string | null => {
  const headers = [
    ...HEADER_SELECTORS.map((selector) => document.querySelector(selector)),
    document.querySelector('h1')?.parentElement ?? null,
  ];

  for (const header of headers) {
    const text = (header === null ? '' : spacedText(header)).slice(
      0,
      MAX_HEADER_SCAN_LENGTH,
    );
    const author = matchByline(text);

    if (author !== null) {
      return author;
    }
  }

  return null;
};

/** Fecha en ISO 8601, o `null` si no se puede interpretar. */
const toIsoDate = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }

  const timestamp = Date.parse(raw);

  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
};

/**
 * Fecha estructurada en la ruta de la URL: `/2026/02/24/` o `/2026-02-24/`.
 *
 * Exige separadores a ambos lados para no confundir un identificador numerico
 * (`/noticia/20260224123/`) con una fecha. El final de la ruta tambien cierra.
 */
export const URL_DATE_PATTERN = /\/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\/|$)/;

/** Ventana de anios plausibles para una fecha de publicacion leida de la URL. */
const MIN_URL_YEAR = 1990;
const MAX_URL_YEAR = 2100;

/**
 * Segundos niveles genericos bajo un dominio de pais (`.com.es`, `.co.uk`):
 * con ellos la etiqueta registrable es la tercera empezando por el final.
 */
const GENERIC_SECOND_LEVEL_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'gob',
  'gov',
  'net',
  'nom',
  'org',
]);

/** Hostname IPv4 literal: no tiene un nombre de organizacion que derivar. */
const IPV4_HOST_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/**
 * Ultimo recurso para la fecha de publicacion: la que el portal codifica en la
 * ruta, habitual en blogs y salas de prensa
 * (`https://f-droid.org/es/2026/02/24/open-letter-...`).
 *
 * Valida el dia REAL del calendario: `2026/02/31` no existe y devolverlo haria
 * citar en APA una fecha que el portal nunca publico. Devuelve `YYYY-MM-DD` y
 * no una marca ISO con hora, porque la URL no dice la hora y inventar la
 * medianoche UTC desplazaria el dia en husos negativos.
 *
 * @param url URL final del articulo.
 * @returns `YYYY-MM-DD`, o `null` si la ruta no trae una fecha valida.
 */
export const extractDateFromUrl = (url: string): string | null => {
  const pathname = parseUrl(url)?.pathname;
  const match = pathname === undefined ? null : URL_DATE_PATTERN.exec(pathname);

  if (match === null) {
    return null;
  }

  const [year, month, day] = match.slice(1, 4).map(Number);

  if (year < MIN_URL_YEAR || year > MAX_URL_YEAR) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  const isRealDay =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  return isRealDay ? date.toISOString().slice(0, 10) : null;
};

/** `f-droid` → `F-Droid`: cada tramo separado por guion, con mayuscula inicial. */
const capitalizeLabel = (label: string): string =>
  label
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('-');

/**
 * Nombre de la organizacion editora deducido del dominio, para cuando el
 * articulo no trae firma (`f-droid.org` → `F-Droid`).
 *
 * En APA 7 una pagina sin autor personal se cita por la organizacion que la
 * publica, de modo que este valor no es un relleno: es el autor correcto de la
 * referencia. Se descarta `www.` y se toma la etiqueta registrable, saltando
 * los segundos niveles genericos (`ejemplo.com.es` → `Ejemplo`).
 *
 * @param url URL final del articulo.
 * @returns El nombre, o `null` si la URL no tiene un dominio con nombre.
 */
export const deriveOrganizationFromHost = (url: string): string | null => {
  const hostname = parseUrl(url)
    ?.hostname.toLowerCase()
    .replace(/^www\./, '');

  if (
    hostname === undefined ||
    hostname === '' ||
    IPV4_HOST_PATTERN.test(hostname)
  ) {
    return null;
  }

  const labels = hostname.split('.').filter((label) => label.length > 0);

  if (labels.length < 2) {
    return null;
  }

  const secondLevel = labels[labels.length - 2];
  const registrable =
    labels.length >= 3 && GENERIC_SECOND_LEVEL_LABELS.has(secondLevel)
      ? labels[labels.length - 3]
      : secondLevel;
  const name = capitalizeLabel(registrable);

  return name.length > 0 ? name : null;
};

/**
 * Autor y fecha de publicacion, por orden de fiabilidad. Autor: `<meta>`,
 * JSON-LD, selectores DOM y regex "por/by" en la cabecera. Fecha: `<meta>`,
 * JSON-LD `datePublished` y el primer `<time datetime>`.
 */
export const extractHeadMetadata = (
  document: Document,
): ArticleHeadMetadata => {
  const jsonLd = readJsonLdNodes(document);
  const author =
    firstMetaContent(document, AUTHOR_SELECTORS) ??
    jsonLd.map((node) => jsonLdAuthorName(node.author)).find(Boolean) ??
    authorFromDom(document) ??
    authorFromHeaderText(document);
  const rawDate =
    firstMetaContent(document, DATE_SELECTORS) ??
    jsonLd
      .map((node) => node.datePublished)
      .find((value): value is string => typeof value === 'string') ??
    document.querySelector('time[datetime]')?.getAttribute('datetime') ??
    null;

  return { author, publishedAt: toIsoDate(rawDate) };
};

/**
 * Enlaces EXTERNOS citados en el cuerpo aislado por Readability.
 * Solo `http(s)` absolutos y de otro host (la navegacion interna del portal
 * no es una fuente), sin duplicados y acotados a `MAX_ARTICLE_REFERENCES`.
 */
export const extractReferences = (
  contentHtml: string,
  sourceUrl: string,
): ArticleReference[] => {
  const { document } = new JSDOM(`<body>${contentHtml}</body>`, {
    url: sourceUrl,
  }).window;
  const ownHost = new URL(sourceUrl).hostname.replace(/^www\./, '');
  const seen = new Set<string>();
  const references: ArticleReference[] = [];

  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    let url: URL;

    try {
      url = new URL(anchor.getAttribute('href') ?? '', sourceUrl);
    } catch {
      continue;
    }

    const host = url.hostname.replace(/^www\./, '');

    if (!/^https?:$/.test(url.protocol) || host === ownHost) {
      continue;
    }

    url.hash = '';
    const href = url.toString();

    if (seen.has(href)) {
      continue;
    }

    seen.add(href);
    const text = normalizeWhitespace(anchor.textContent ?? '');
    references.push({
      title: (text.length > 0 ? text : href).slice(
        0,
        MAX_REFERENCE_TITLE_LENGTH,
      ),
      url: href,
    });

    if (references.length >= MAX_ARTICLE_REFERENCES) {
      break;
    }
  }

  return references;
};

/** Referencias en texto legible para un prompt: "Titulo — URL" por linea. */
export const formatReferencesText = (
  references: readonly ArticleReference[],
): string => references.map(({ title, url }) => `${title} — ${url}`).join('\n');
