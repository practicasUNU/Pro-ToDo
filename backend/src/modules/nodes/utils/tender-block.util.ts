// Helper puro: sin estado ni E/S.
//
// Envoltorio ESTANDAR de una licitacion insertada por APPEND_HTML_BLOCK:
// `<div class="pd-licitacion-block" data-expediente="...">`. Es lo que permite
// que TRANSFER_HTML_BLOCK la localice despues por `.pd-licitacion-block` y su
// expediente, sin depender del marcado del acordeon Bootstrap de Drupal.

import * as cheerio from 'cheerio';

/** Clase del envoltorio estandar de una licitacion. */
export const TENDER_BLOCK_CLASS = 'pd-licitacion-block';

/**
 * Escapa un valor para un atributo HTML entre comillas dobles.
 *
 * Un codigo de expediente con comillas cerraria el atributo antes de tiempo y
 * dejaria el resto como marcado: se escapan las cinco entidades basicas.
 */
export const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Marca o envuelve el marcado de una licitacion nueva.
 *
 * - Si el fragmento es UN solo elemento raiz que ya trae `data-expediente` no
 *   vacio (la plantilla de apertura emite `div.licitacion-entry`), se le anade
 *   la clase estandar y nada mas: un segundo `div` alrededor solo anadiria
 *   anidamiento.
 * - Si no, y hay expediente, se envuelve en el `div` estandar.
 * - Sin expediente se devuelve intacto: un `data-expediente=""` no identifica
 *   nada y daria a Cerrar licitacion un blanco ambiguo.
 */
export const wrapTenderBlock = (
  markup: string,
  expediente: string | null,
): string => {
  const $ = cheerio.load(markup, { xml: { xmlMode: false } }, false);
  // `children()` ya devuelve solo elementos: el texto suelto no cuenta.
  const roots = $.root().children();
  const onlyRoot = roots.length === 1 ? roots.first() : null;
  const ownCode = onlyRoot?.attr('data-expediente')?.trim() ?? '';

  if (onlyRoot !== null && ownCode !== '') {
    if (onlyRoot.hasClass(TENDER_BLOCK_CLASS)) return markup;

    onlyRoot.addClass(TENDER_BLOCK_CLASS);
    return $.html();
  }

  const code = expediente?.trim() ?? '';

  if (code === '') return markup;

  return `<div class="${TENDER_BLOCK_CLASS}" data-expediente="${escapeHtmlAttribute(code)}">${markup}</div>`;
};
