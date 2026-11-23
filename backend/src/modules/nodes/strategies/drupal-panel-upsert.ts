import * as cheerio from 'cheerio';

import { foldDiacritics } from '@modules/nodes/utils/diacritics.util';

import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * Identificadores e insercion ADITIVA de paneles de comite en el acordeon.
 *
 * Funciones puras sobre el DOM ya cargado, por el mismo motivo que
 * `drupal-universities.ts`: aqui se decide que se BORRA de una pagina ajena y
 * con que `id` entra lo nuevo, y un error en cualquiera de las dos cosas no
 * falla —el PATCH devuelve 200— sino que deja la pagina rota en silencio.
 *
 * DOS REGLAS QUE NO SE NEGOCIAN:
 *
 * 1. Dentro del sub-acordeon de destino (`#accordion<SIGLAS>`) NO SE TOCA NADA
 *    de lo que ya hay: ni se reemplaza ni se borra. Un panel existente puede
 *    ser una copia oculta del HTML base de Drupal o —caso real— un comite como
 *    UPM 5 que lleva DENTRO el sub-acordeon anidado de otra universidad (UAH).
 *    Sustituirlo se llevaria por delante una universidad entera.
 * 2. Fuera del destino solo se retira lo que publico Proto-Do PARA ESE MISMO
 *    COMITE (o un bloque suyo sin encabezado colgado de la raiz): los restos de
 *    la averia que inyectaba en `#accordion`. Nada mas.
 *
 * La colision de `id` que la regla 1 deja sin resolver se resuelve con un
 * SUFIJO (`collapseUAM9-2`) en el panel NUEVO, no tocando el viejo.
 */

/** `href`/`id` del colapsable y `data-parent` que se escriben en un panel. */
export interface PanelIdentifiers {
  /** Sin almohadilla: `collapseUAM9`. */
  readonly collapseId: string;

  /** Con almohadilla: `#accordionUAM`. `null` deja el atributo como venga. */
  readonly dataParent: string | null;
}

/** Panel que el despacho reconoce como unidad insertable. */
const PANEL_SELECTOR = '.panel.panel-default';

/**
 * Lo que publica Proto-Do, y por que no basta el marcador.
 *
 * `data-protodo-injected` NO SOBREVIVE AL VIAJE: Drupal lo filtra al guardar
 * el cuerpo (ver `cleanup-drupal-sandbox.ts`), asi que en la pagina real un
 * panel inyectado ayer ya no lo lleva. Las clases de la plantilla
 * —`panel-toggle-link`, `panel-comite-codigo`— si sobreviven, y los paneles
 * nativos del portal no las usan. Se aceptan las tres.
 */
const INJECTED_MARKER_SELECTOR = '[data-protodo-injected="true"]';
const INJECTED_CLASS_SELECTOR = 'a.panel-toggle-link, .panel-comite-codigo';

/** Utilidades de ocultacion de Bootstrap 5 (`d-none`) y 3 (`hidden`). */
const HIDDEN_UTILITY_CLASSES = 'd-none hidden';

/** Acordeon raiz de la pagina agregadora, sin almohadilla. */
const ROOT_ACCORDION_ID = 'accordion';

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/**
 * Codigo de comite sin espacios ni signos, en mayusculas: «UAM 9» -> «UAM9».
 *
 * Se pliegan los acentos y se descarta todo lo que no sea letra o digito
 * porque el resultado acaba dentro de un `id` HTML y de un selector de
 * atributo: sin esto, un «UPM-4» o un `&nbsp;` partirian ambos.
 */
export const compactCommitteeCode = (code: string): string =>
  foldDiacritics(code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * Enlace que despliega el colapsable del panel.
 *
 * `a.panel-toggle-link` es el de la plantilla; el respaldo cubre a un modelo
 * que la conserva pero pierde la clase del enlace.
 */
const findToggleLink = (panel: Cheerio<AnyNode>): Cheerio<AnyNode> => {
  const toggle = panel.find('a.panel-toggle-link').first();

  return toggle.length > 0 ? toggle : panel.find('.panel-heading a').first();
};

/**
 * Reescribe `href`, `id` y `data-parent` de un panel con los identificadores
 * dados, y le quita las utilidades de ocultacion.
 *
 * El texto visible (`.panel-comite-codigo`) NO se toca: es el dato de origen
 * del que se derivan los identificadores, y el sufijo de colision solo tiene
 * sentido tecnico.
 *
 * Si el marcado no trae ningun panel, se devuelve tal cual.
 */
export const applyPanelIdentifiers = (
  panelHtml: string,
  identifiers: PanelIdentifiers,
): string => {
  const $ = loadFragment(panelHtml);
  const panel = $(PANEL_SELECTOR).first();

  if (panel.length === 0) {
    return panelHtml;
  }

  const toggle = findToggleLink(panel);
  toggle.attr('href', `#${identifiers.collapseId}`);
  panel.find('.collapse').first().attr('id', identifiers.collapseId);

  if (identifiers.dataParent !== null) {
    toggle.attr('data-parent', identifiers.dataParent);

    // El panel tambien puede declararlo (precedencia de `planPanelDispatch`):
    // dos `data-parent` distintos en el mismo panel no pueden convivir.
    if (panel.attr('data-parent') !== undefined) {
      panel.attr('data-parent', identifiers.dataParent);
    }
  }

  // Un panel copiado de una muestra oculta entraria igual de oculto: el PATCH
  // daria 200 y el comite no se veria.
  panel.removeClass(HIDDEN_UTILITY_CLASSES);

  return $.html();
};

/**
 * Primer `id` libre en el documento a partir de `baseId`: el mismo, o
 * `<baseId>-2`, `<baseId>-3`...
 *
 * Se mira el documento ENTERO y no solo el sub-acordeon de destino: un `id`
 * repetido en cualquier sitio de la pagina basta para que Bootstrap despliegue
 * el primero —que suele ser una copia oculta— en vez del nuevo.
 *
 * `baseId` llega ya compactado (`compactCommitteeCode`), de modo que cabe en el
 * selector de atributo sin escapar nada.
 */
export const allocateCollapseId = ($: CheerioAPI, baseId: string): string => {
  const isTaken = (id: string): boolean => $(`[id="${id}"]`).length > 0;

  if (!isTaken(baseId)) {
    return baseId;
  }

  let suffix = 2;

  while (isTaken(`${baseId}-${suffix}`)) {
    suffix += 1;
  }

  return `${baseId}-${suffix}`;
};

/** Si `node` cuelga (a cualquier profundidad) de `ancestor`. */
const isDescendantOf = (node: Cheerio<AnyNode>, ancestor: AnyNode): boolean =>
  node
    .parents()
    .toArray()
    .some((parent) => parent === ancestor);

/**
 * Bloques que publico Proto-Do para un comite y que estan FUERA de su destino.
 *
 * Solo dos clases de bloque, y las dos tienen que ser obra de Proto-Do (ver
 * `INJECTED_MARKER_SELECTOR`):
 *
 * - Los del MISMO comite: contienen `#<collapseId>` o `#<collapseId>-N`, o su
 *   `.panel-comite-codigo` compactado es el `committeeId`. Son los restos de la
 *   averia que inyectaba en la raiz o en otra universidad.
 * - Los huerfanos sin `.panel-heading` que cuelgan directamente de la raiz
 *   `#accordion`: el bloque corrupto que dejaba la plantilla mal rellenada.
 *
 * Nunca se devuelve un bloque que contenga un `.panel-group` —un panel de
 * universidad, o un comite con un sub-acordeon anidado—, ni el propio
 * contenedor de destino o algo que lo contenga.
 */
export const findStaleInjectedPanels = (
  $: CheerioAPI,
  container: Cheerio<AnyNode>,
  committee: { readonly collapseId: string; readonly committeeId: string },
): Cheerio<AnyNode> => {
  const target = container.get(0);

  if (target === undefined) {
    return $([]);
  }

  return $(PANEL_SELECTOR).filter((_, element) => {
    const block = $(element);

    const injected =
      block.is(INJECTED_MARKER_SELECTOR) ||
      block.find(INJECTED_CLASS_SELECTOR).length > 0;

    if (!injected) return false;

    // Dentro del destino no se toca nada; y nada que envuelva al destino.
    if (element === target || isDescendantOf(block, target)) return false;
    if (isDescendantOf($(target), element)) return false;
    if (block.find('.panel-group').length > 0) return false;

    const sameCommittee =
      block.find(
        `[id="${committee.collapseId}"], [id^="${committee.collapseId}-"]`,
      ).length > 0 ||
      block
        .find('.panel-comite-codigo')
        .toArray()
        .some(
          (code) =>
            compactCommitteeCode($(code).text()) === committee.committeeId,
        );

    if (sameCommittee) return true;

    const orphan = block.find('.panel-heading').length === 0;

    return orphan && block.parent().attr('id') === ROOT_ACCORDION_ID;
  });
};
