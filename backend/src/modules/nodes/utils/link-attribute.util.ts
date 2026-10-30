// Helper puro: sin estado ni E/S.
//
// Reescritura QUIRURGICA de un atributo `href`/`src` dentro del HTML de una
// pagina de Drupal (modo UPDATE_LINK_SOURCE, pagina de Innodays).
//
// No se serializa el DOM de vuelta con `$.html()`: cheerio reescribe al
// serializar las comillas, las entidades y los atributos vacios de TODA la
// pagina, y el PATCH acabaria tocando marcado, estilos y scripts que nadie
// pidio cambiar. Aqui cheerio solo LOCALIZA el elemento —parse5 informa de la
// posicion exacta de cada atributo en el texto original— y lo unico que se
// sustituye es ese tramo de la cadena. El resto de la pagina sale byte a byte.

import * as cheerio from 'cheerio';

import type { DrupalLinkAttribute } from '../dto/drupal-http-config.dto';

/** Resultado de intentar reescribir el atributo. */
export type LinkAttributeUpdate =
  | {
      readonly html: string;
      /** Valor que tenia el atributo, o `null` si no lo tenia. */
      readonly previousValue: string | null;
    }
  | {
      /** Elementos que casaron con el selector: 0 o mas de 1. */
      readonly matches: number;
    }
  | {
      /** El selector no es CSS valido para cheerio. */
      readonly invalidSelector: string;
    };

/** Tramo de texto con sus posiciones en la cadena original. */
interface SourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

/** Forma minima de la ubicacion que parse5 adjunta a cada elemento. */
interface ElementLocation {
  readonly startTag?: SourceSpan;
  readonly attrs?: Readonly<Record<string, SourceSpan>>;
}

/**
 * Esquemas admitidos en el nuevo valor.
 *
 * Lista CERRADA: el valor sale de una plantilla que interpola contexto —a veces
 * texto de un modelo de lenguaje—, y un `javascript:` o un `data:` escritos en
 * el `href` de una pagina publica serian un XSS persistente en el portal.
 * `mailto:` solo tiene sentido en un enlace, no en una imagen.
 */
const ALLOWED_SCHEMES: Readonly<
  Record<DrupalLinkAttribute, readonly string[]>
> = {
  href: ['http:', 'https:', 'mailto:'],
  src: ['http:', 'https:'],
};

/** Prefijo de esquema (`algo:`) al principio del valor. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*:)/i;

/**
 * El valor es un destino publicable para ese atributo.
 *
 * Las rutas relativas (`/sites/default/files/x.pdf`, `#anchor`, `fichero.pdf`)
 * no llevan esquema y se aceptan. Los caracteres de control y los espacios se
 * quitan antes de mirar el esquema porque los navegadores los ignoran:
 * `java\tscript:` se ejecuta igual que `javascript:`.
 */
export const isSafeLinkValue = (
  value: string,
  attribute: DrupalLinkAttribute,
): boolean => {
  const compact = [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);

      return code > 0x20 && code !== 0x7f;
    })
    .join('');

  if (compact.length === 0) return false;

  const scheme = SCHEME_PATTERN.exec(compact)?.[1]?.toLowerCase();

  return scheme === undefined || ALLOWED_SCHEMES[attribute].includes(scheme);
};

/** Escapa un valor para ir entre comillas dobles dentro de un atributo. */
const escapeAttributeValue = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Sustituye (o anade) un atributo en el UNICO elemento que casa con el selector.
 *
 * Exige exactamente un elemento. Con cero no hay nada que actualizar, y con
 * varios cualquier eleccion seria una adivinanza: actualizar el primero de una
 * tabla con varias filas parecidas cambiaria el enlace equivocado y el nodo
 * devolveria exito.
 *
 * @param html Fragmento HTML tal como lo devuelve Drupal en `body.value`.
 * @param selector Selector CSS de cheerio (admite `:contains()`).
 * @param attribute `href` o `src`.
 * @param value Nuevo valor, SIN escapar: se escapa aqui.
 */
export const replaceLinkAttribute = (
  html: string,
  selector: string,
  attribute: DrupalLinkAttribute,
  value: string,
): LinkAttributeUpdate => {
  const $ = cheerio.load(html, { sourceCodeLocationInfo: true }, false);

  let matched: ReturnType<typeof $>;

  try {
    matched = $(selector);
  } catch {
    return { invalidSelector: selector };
  }

  if (matched.length !== 1) {
    return { matches: matched.length };
  }

  const element = matched.get(0) as
    { sourceCodeLocation?: ElementLocation | null } | undefined;
  const location = element?.sourceCodeLocation ?? null;
  const startTag = location?.startTag;

  // Sin ubicacion no se puede hacer la cirugia: solo pasaria con un elemento
  // que no existe en el texto original, y eso equivale a no haberlo encontrado.
  if (startTag === undefined) {
    return { matches: 0 };
  }

  const replacement = `${attribute}="${escapeAttributeValue(value)}"`;
  const attributeSpan = location?.attrs?.[attribute];

  if (attributeSpan !== undefined) {
    return {
      html:
        html.slice(0, attributeSpan.startOffset) +
        replacement +
        html.slice(attributeSpan.endOffset),
      previousValue: matched.attr(attribute) ?? null,
    };
  }

  // El elemento no tenia el atributo: se anade al final de la etiqueta de
  // apertura, antes del `>` o del `/>` de cierre.
  const closing = html.slice(0, startTag.endOffset).endsWith('/>') ? 2 : 1;
  const insertAt = startTag.endOffset - closing;

  return {
    html: `${html.slice(0, insertAt)} ${replacement}${html.slice(insertAt)}`,
    previousValue: null,
  };
};
