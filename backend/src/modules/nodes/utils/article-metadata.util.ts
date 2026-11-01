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

/** Fecha en ISO 8601, o `null` si no se puede interpretar. */
const toIsoDate = (raw: string | null): string | null => {
  if (raw === null) {
    return null;
  }

  const timestamp = Date.parse(raw);

  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
};

/**
 * Autor y fecha de publicacion, por orden de fiabilidad:
 * `<meta>` explicitos, luego JSON-LD (`author`, `datePublished`) y, para la
 * fecha, el primer `<time datetime>` del documento.
 */
export const extractHeadMetadata = (
  document: Document,
): ArticleHeadMetadata => {
  const jsonLd = readJsonLdNodes(document);
  const author =
    firstMetaContent(document, AUTHOR_SELECTORS) ??
    jsonLd.map((node) => jsonLdAuthorName(node.author)).find(Boolean) ??
    null;
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
