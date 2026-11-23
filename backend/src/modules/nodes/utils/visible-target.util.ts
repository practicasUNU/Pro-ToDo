// Helper puro: sin estado ni E/S.
//
// Vive aqui y no dentro de `DrupalHttpStrategy` por el mismo motivo que
// `drupal-universities.ts`: es donde se decide EN QUE contenedor acaba el
// contenido, que es justo donde vive el riesgo de este nodo. Un destino mal
// elegido no falla —el PATCH devuelve 200 y la ejecucion se marca EXITOSA—,
// simplemente deja el panel donde nadie lo ve. Como funcion pura entra en una
// prueba unitaria; dentro del metodo que hace el GET y el PATCH, no.

import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * Clases con las que el portal oculta un subarbol ENTERO.
 *
 * Son las mismas dos de `HIDDEN_UTILITY_CLASSES` en `drupal-http.strategy.ts`, y
 * por el mismo motivo: la pagina presenta `.panel` y `.panel-heading`, que es
 * Bootstrap 3 —donde la utilidad se llama `hidden`—, mientras que la plantilla
 * sembrada emite `data-bs-toggle`, que es Bootstrap 5 —donde se llama `d-none`—.
 * Contemplar solo una de las dos tiene el peor coste posible: el panel se
 * publica, el nodo devuelve EXITOSO y nadie lo ve en la pagina.
 *
 * La diferencia con aquella constante es el ALCANCE, y es la razon de que esta
 * exista: alla se mira si el contenedor elegido trae la clase encima, aqui si
 * CUELGA de un ancestro que la trae. Una plantilla de muestra escondida en un
 * `<div class="d-none">` deja un duplicado exacto de cada contenedor del portal,
 * y es ese duplicado el que `$(selector).first()` encuentra primero.
 */
const HIDDEN_ANCESTOR_SELECTOR = '.d-none, .hidden';

/**
 * El primer elemento VISIBLE que casa con el selector.
 *
 * "Visible" aqui significa exactamente una cosa: que ni el elemento ni ninguno
 * de sus ancestros lleve una de las utilidades de ocultacion. No se evalua
 * `style`, ni `hidden`, ni nada que exija un motor de CSS; no hay ninguno en
 * juego y fingir que si lo hay seria peor que no comprobarlo.
 *
 * SI NO HAY NINGUNO VISIBLE, DEVUELVE EL PRIMERO IGUAL. Es deliberado, y no es
 * lo mismo que rendirse: un contenedor unico que viene oculto —el sub-acordeon
 * de una universidad a la que todavia no se le ha inyectado ningun comite— es
 * perfectamente publicable, y quien llama lo destapa acto seguido con
 * `removeClass`. Devolver vacio aqui convertiria ese caso corriente en un
 * ERR_DRUPAL_DOM_TARGET y dejaria la tanda entera sin publicar.
 */
export const selectVisibleTarget = (
  $: CheerioAPI,
  selector: string,
): Cheerio<AnyNode> => {
  const candidates = $(selector);

  const visible = candidates.filter(
    (_, element) => $(element).closest(HIDDEN_ANCESTOR_SELECTOR).length === 0,
  );

  return visible.length > 0 ? visible.first() : candidates.first();
};

/**
 * Si el elemento, o alguno de sus ancestros, lleva una utilidad de ocultacion.
 *
 * Es la misma definicion de "visible" que usa `selectVisibleTarget`, expuesta
 * para quien necesita distinguir "el primero visible" de "el primero aunque
 * este oculto" —el despacho de ESIC, que antes de aceptar un `#accordionESIC`
 * oculto prueba su respaldo visible—.
 */
export const hasHiddenAncestor = (element: Cheerio<AnyNode>): boolean =>
  element.closest(HIDDEN_ANCESTOR_SELECTOR).length > 0;
