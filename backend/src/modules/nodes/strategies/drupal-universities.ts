import * as cheerio from 'cheerio';

import { foldDiacritics } from '@modules/nodes/utils/diacritics.util';
import { selectVisibleTarget } from '@modules/nodes/utils/visible-target.util';

import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * Catalogo de las universidades del acordeon de Madrid+D y despacho de paneles.
 *
 * Vive aqui y no dentro de `DrupalHttpStrategy` por el mismo motivo que
 * `provider-fallback.ts`: es una TABLA mas unas funciones puras, sin estado ni
 * E/S, y como funciones puras entran en una prueba unitaria; dentro del metodo
 * que hace el GET y el PATCH, no. Y es justo donde vive el riesgo: un destino
 * mal resuelto no falla, publica el comite de una universidad dentro de otra.
 *
 * LA PAGINA AGREGADORA ES UN ACORDEON DE DOS NIVELES. El primero son catorce
 * paneles de universidad, hijos directos del acordeon raiz; dentro de cada uno
 * hay un sub-acordeon `#accordion<SIGLAS>` que es donde cuelgan los comites.
 * Antes de esto, la estrategia metia el fragmento entero en UN contenedor, de
 * modo que todos los comites de una tanda acababan en el mismo sitio
 * —tipicamente la raiz— fuera de la universidad que les corresponde.
 */

/** Una universidad del acordeon, con sus dos contenedores y sus alias. */
export interface UniversityMapping {
  readonly name: string;

  /** Panel de primer nivel que la envuelve. Hoy no se usa para insertar. */
  readonly collapseId: string;

  /** Sub-acordeon donde cuelgan sus comites. Es el destino real. */
  readonly accordionId: string;

  /**
   * Como la nombra el material de entrada.
   *
   * Se escriben en minuscula y SIN acentos porque la comparacion pliega los dos
   * lados: ver `resolveUniversityAccordion`.
   */
  readonly aliases: readonly string[];
}

/**
 * Las catorce universidades del portal, en el orden en que la pagina las lista.
 *
 * El orden importa poco para la resolucion —los alias se comparan por palabra
 * completa, de modo que no hay solapes— pero mantenerlo igual que el portal
 * hace que una discrepancia se vea leyendo las dos listas en paralelo.
 */
export const DRUPAL_UNIVERSITIES_CATALOG: readonly UniversityMapping[] = [
  {
    name: 'Universidad San Pablo CEU',
    collapseId: '#collapseCEU',
    accordionId: '#accordionCEU',
    aliases: ['ceu', 'san pablo'],
  },
  {
    name: 'Universidad Alfonso X',
    collapseId: '#collapseUAX',
    accordionId: '#accordionUAX',
    aliases: ['uax', 'alfonso x'],
  },
  {
    name: 'Universidad Complutense de Madrid',
    collapseId: '#collapseUCM',
    accordionId: '#accordionUCM',
    aliases: ['ucm', 'complutense'],
  },
  {
    name: 'Universidad a Distancia de Madrid',
    collapseId: '#collapseUDIMA',
    accordionId: '#accordionUDIMA',
    aliases: ['udima'],
  },
  {
    name: 'Universidad Internacional Villanueva',
    collapseId: '#collapseUIV',
    accordionId: '#accordionUIV',
    aliases: ['villanueva', 'uiv'],
  },
  {
    name: 'Universidad Europea de Madrid',
    collapseId: '#collapseUEM',
    accordionId: '#accordionUEM',
    aliases: ['uem', 'europea'],
  },
  {
    name: 'Universidad Nebrija',
    collapseId: '#collapseUNNE',
    accordionId: '#accordionUNNE',
    aliases: ['nebrija', 'unne'],
  },
  {
    name: 'Universidad Politécnica de Madrid',
    collapseId: '#collapseUPM',
    accordionId: '#accordionUPM',
    aliases: ['upm', 'politecnica'],
  },
  {
    name: 'Universidad de Alcalá de Henares',
    collapseId: '#collapseUAH',
    accordionId: '#accordionUAH',
    aliases: ['uah', 'alcala'],
  },
  {
    name: 'Universidad Autónoma de Madrid',
    collapseId: '#collapseUAM',
    accordionId: '#accordionUAM',
    aliases: ['uam', 'autonoma'],
  },
  {
    name: 'Universidad Carlos III de Madrid',
    collapseId: '#collapseUC3M',
    accordionId: '#accordionUC3M',
    aliases: ['uc3m', 'carlos iii'],
  },
  {
    name: 'Universidad Camilo José Cela',
    collapseId: '#collapseUCJC',
    accordionId: '#accordionUCJC',
    aliases: ['ucjc', 'camilo jose cela'],
  },
  {
    name: 'Universidad Rey Juan Carlos',
    collapseId: '#collapseURJC',
    accordionId: '#accordionURJC',
    aliases: ['urjc', 'rey juan carlos'],
  },
  {
    name: 'ESIC Universidad',
    // NO REUTILIZAR `#accordionUFV`. Hubo una correccion que apunto ESIC ahi,
    // sobre la premisa de que el agregador no tenia ninguna Universidad
    // Francisco de Vitoria y que `accordionUFV` era un identificador heredado
    // del propio panel de ESIC. La premisa era falsa: UFV existe en la pagina
    // —oculta con `d-none`, con su propio comite UFV D1— y es una universidad
    // DISTINTA. El resultado de aquel cambio fue que los comites de ESIC se
    // publicaron dentro del acordeon de Francisco de Vitoria.
    collapseId: '#collapseESIC',
    accordionId: '#accordionESIC',
    aliases: ['esic'],
  },
] as const;

/** Caracteres que no forman palabra, para anclar la busqueda de un alias. */
const WORD_BOUNDARY = /[^a-z0-9]+/;

/** Carga de cheerio con las banderas CANONICAS del proyecto. */
const loadFragment = (html: string): cheerio.CheerioAPI =>
  cheerio.load(html, { xml: { xmlMode: false } }, false);

/** Minusculas sin acentos, que es el terreno comun de la comparacion. */
const normalize = (value: string): string =>
  foldDiacritics(value).toLowerCase();

/**
 * Si un termino aparece como SECUENCIA DE PALABRAS completa dentro del texto.
 *
 * No es un `includes` suelto, y la diferencia importa: con `includes`, el alias
 * `uax` casaria dentro de cualquier palabra que lo contenga y mandaria el panel
 * a una universidad ajena. Un alias de tres letras tiene demasiadas formas de
 * aparecer por accidente como para fiarse de la subcadena.
 *
 * Se trocea por los caracteres que no forman palabra en vez de construir una
 * expresion regular con el termino dentro: los alias llevan espacios y numeros
 * romanos (`carlos iii`), y meterlos en una regex obligaria a escaparlos.
 */
const containsPhrase = (haystack: string, needle: string): boolean => {
  const words = haystack.split(WORD_BOUNDARY).filter((word) => word.length > 0);
  const target = needle.split(WORD_BOUNDARY).filter((word) => word.length > 0);

  if (target.length === 0) {
    return false;
  }

  return words.some((_, index) =>
    target.every((word, offset) => words[index + offset] === word),
  );
};

/**
 * Sub-acordeon de la universidad que menciona un texto, o `null`.
 *
 * Es el ULTIMO recurso del despacho: solo se consulta cuando el panel no trae
 * `data-parent` ni en si mismo ni en su enlace, y entonces se mira el texto del
 * encabezado. Devolver `null` no es un fallo que se trague: quien llama lo
 * convierte en un error que nombra el comite afectado.
 *
 * Se comparan los dos lados PLEGADOS. El codigo del enunciado comparaba el
 * texto plegado contra `u.name.toLowerCase()` sin plegar, de modo que ningun
 * nombre con tilde —«Universidad Politécnica de Madrid», «Autónoma», «Alcalá»,
 * «Camilo José Cela»— podia encontrarse a si mismo.
 */
export const resolveUniversityAccordion = (textOrCode: string): string | null =>
  findUniversity(textOrCode)?.accordionId ?? null;

/**
 * Universidad del catalogo que menciona un texto, o `undefined`.
 *
 * Los espacios se colapsan ANTES de plegar: el texto de un encabezado de Drupal
 * llega con saltos de linea, tabuladores y `&nbsp;` de la indentacion, y
 * `\s` cubre los tres (U+00A0 incluido).
 */
const findUniversity = (text: string): UniversityMapping | undefined => {
  const normalized = normalize(text.replace(/\s+/g, ' ').trim());

  return DRUPAL_UNIVERSITIES_CATALOG.find(
    (university) =>
      university.aliases.some((alias) => containsPhrase(normalized, alias)) ||
      containsPhrase(normalized, normalize(university.name)),
  );
};

/** Enlace de un encabezado de panel que despliega un colapsable de la pagina. */
const PANEL_TOGGLE_SELECTOR = '.panel-heading a[href^="#"]';

/** Identificador HTML que se puede buscar sin escapar nada. */
const SAFE_ID_PATTERN = /^[A-Za-z][\w-]*$/;

/**
 * Sub-acordeon de una universidad localizado por el TEXTO de su encabezado.
 *
 * Es el ultimo recurso del despacho, para cuando el identificador resuelto no
 * existe en la pagina: el portal no garantiza que el panel de una universidad
 * se llame como dice el catalogo, y en el de ESIC el colapsable ha aparecido
 * como `#collapseESIC` y como `#collapseUFV`. Lo estable es el texto visible
 * del encabezado («ESIC Universidad»), asi que se busca por el y se sigue su
 * `href` hasta el `.panel-group` que cuelga dentro.
 *
 * Tres guardas, y las tres vienen de averias reales:
 *
 * - El encabezado tiene que nombrar a LA MISMA universidad del catalogo que el
 *   comite. Francisco de Vitoria comparte pagina con ESIC y NO esta en el
 *   catalogo: su encabezado no resuelve a ninguna universidad y se descarta, de
 *   modo que un comite de ESIC no puede acabar en su acordeon (ver migracion
 *   038, que revirtio exactamente ese error).
 * - El `href` se resuelve DENTRO del `.panel` del propio encabezado y no con un
 *   `$('#collapseUFV')` global: si dos paneles repiten identificador, el global
 *   devuelve el primero del documento, que puede ser el de otra universidad.
 * - El destino tiene que ser un `.panel-group` con id. El encabezado de un
 *   COMITE («ESIC 1 Facultad...») tambien nombra a ESIC, pero su colapsable no
 *   contiene ningun sub-acordeon, asi que se salta solo.
 *
 * Funcion pura sobre el DOM ya cargado: no lo modifica.
 */
export const findAccordionByHeading = (
  $: CheerioAPI,
  committeeHeading: string,
): Cheerio<AnyNode> | null => {
  const university = findUniversity(committeeHeading);

  if (university === undefined) {
    return null;
  }

  for (const element of $(PANEL_TOGGLE_SELECTOR).toArray()) {
    const link = $(element);

    if (findUniversity(link.text()) !== university) {
      continue;
    }

    const targetId = (link.attr('href') ?? '').slice(1);

    if (!SAFE_ID_PATTERN.test(targetId)) {
      continue;
    }

    const group = link
      .closest('.panel')
      .find(`[id="${targetId}"]`)
      .first()
      .find('.panel-group[id]')
      .first();

    if (group.length > 0) {
      return group;
    }
  }

  return null;
};

/**
 * Trocea un selector en sus alternativas, separadas por comas de primer nivel.
 *
 * `data-parent="#collapseESIC, #collapseUFV"` se lee como ALTERNATIVAS EN
 * ORDEN y no como un grupo de cheerio: el grupo devolveria los candidatos de
 * las dos en orden de documento, y el primero podria ser el de la segunda
 * aunque la primera exista. Las comas dentro de parentesis, corchetes o
 * comillas (`:is(a, b)`, `[title="a, b"]`) no separan.
 */
export const splitSelectorAlternatives = (selector: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const char of selector) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  parts.push(current);

  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

/**
 * Contenedor donde va un panel, o `null` si la pagina no tiene ninguno.
 *
 * Primero las alternativas declaradas, en orden y prefiriendo la copia visible
 * de cada una; despues, si ninguna existe, el encabezado por texto. Un selector
 * que cheerio no sabe leer cuenta como inexistente: es el mismo desenlace —no
 * hay donde insertar— y debe acabar en el mismo error que nombra el comite.
 */
export const resolvePanelContainer = (
  $: CheerioAPI,
  panel: PanelDispatch,
): Cheerio<AnyNode> | null => {
  for (const alternative of splitSelectorAlternatives(
    panel.targetSelector ?? '',
  )) {
    try {
      const container = selectVisibleTarget($, alternative);

      if (container.length > 0) {
        return container;
      }
    } catch {
      // Selector invalido: se prueba la siguiente alternativa.
    }
  }

  return findAccordionByHeading($, panel.heading);
};

/** Un panel del marcado entrante, con el destino que se le ha resuelto. */
export interface PanelDispatch {
  /** Texto de `.panel-comite-codigo` (ej. "UAM 9"), para poder nombrarlo. */
  readonly committeeCode: string;

  /** Sub-acordeon de destino, o `null` si no se ha podido deducir. */
  readonly targetSelector: string | null;

  /** Texto del `.panel-heading`, para el ultimo recurso por encabezado. */
  readonly heading: string;

  /** El panel entero, listo para insertar. */
  readonly html: string;
}

/** Panel que el despacho reconoce como unidad insertable. */
const PANEL_SELECTOR = '.panel.panel-default';

/**
 * Reparte el marcado entrante en paneles con su destino resuelto.
 *
 * Precedencia del destino, de mayor a menor:
 *
 *   1. `data-parent` del propio `.panel`.
 *   2. `data-parent` del primer `a[data-parent]` descendiente.
 *   3. El texto del `.panel-heading`, por `resolveUniversityAccordion`.
 *
 * Los dos primeros escalones existen porque el encargo pedia una cosa y la
 * plantilla hace otra: Bootstrap pone `data-parent` en el enlace que dispara el
 * colapsable, y ahi es donde lo siembra la migracion 034. Mirar solo el panel
 * no habria encontrado nunca el atributo que el sistema ya escribe.
 *
 * Devuelve lista VACIA cuando el marcado no trae ningun `.panel.panel-default`,
 * y es la senal que usa la estrategia para conservar su ruta de siempre: los
 * demas flujos que publican por `APPEND_HTML_BLOCK` —licitaciones, Notiweb—
 * emiten bloques que no son paneles, y deben seguir yendo al contenedor unico
 * del nodo.
 */
export const planPanelDispatch = (markup: string): readonly PanelDispatch[] => {
  const $ = loadFragment(markup);

  return $(PANEL_SELECTOR)
    .toArray()
    .map((element) => {
      const panel = $(element);

      const declared =
        panel.attr('data-parent') ??
        panel.find('a[data-parent]').first().attr('data-parent');

      const heading = panel.find('.panel-heading').first().text();

      const targetSelector =
        declared !== undefined && declared.trim().length > 0
          ? declared.trim()
          : resolveUniversityAccordion(heading);

      return {
        committeeCode:
          panel.find('.panel-comite-codigo').first().text().trim() ||
          heading.trim() ||
          'comite sin codigo',
        targetSelector,
        heading,
        // `$.html(panel)` y no `panel.html()`: el segundo devolveria el
        // CONTENIDO del panel y perderia el `<div class="panel panel-default">`
        // que lo envuelve, que es justo lo que el acordeon necesita.
        html: $.html(panel),
      };
    });
};
