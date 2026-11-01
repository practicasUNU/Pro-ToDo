// Replica del contrato de `PostIaSanitizerConfigDto` (backend). Cualquier cambio
// alla debe reflejarse aqui.

/**
 * Namespace del que el escudo lee la respuesta del modelo.
 *
 * REPLICA de `DEFAULT_POST_IA_SOURCE_NAMESPACE`. Es el `outputNamespace`
 * canonico del `PROCESADOR_IA`, el nodo al que este escudo sigue por diseno.
 */
export const DEFAULT_POST_IA_SOURCE_NAMESPACE = 'llm_response';

/**
 * Campo del que lee el marcado.
 *
 * REPLICA de `DEFAULT_POST_IA_SOURCE_FIELD`. Lo publica `LlmExtractorStrategy`
 * desde PROT-26, y SOLO cuando su prompt cita una plantilla base: sin esa cita
 * el modelo no maqueta nada y el campo llega a `null`. De ahi el aviso que el
 * store levanta cuando no encuentra un mapeador por delante.
 *
 * Se llama `filled_markup` y no `compiled_markup` para no colisionar con
 * `rendered_html.compiled_markup`, que es la plantilla base VACIA.
 */
export const DEFAULT_POST_IA_SOURCE_FIELD = 'filled_markup';

/**
 * Que audita el escudo. Replica de `PostIaContentMode`.
 *
 * `TEXT` permite poner el escudo directamente detras de un `PROCESADOR_IA`, sin
 * `MAPEADOR_PLANTILLA`, en los flujos que no maquetan (Cerrar licitacion,
 * Innodays, Innobar): audita campos de texto y les quita toda etiqueta.
 */
export enum PostIaContentMode {
  HTML = 'HTML',
  TEXT = 'TEXT',
}

export const DEFAULT_POST_IA_CONTENT_MODE = PostIaContentMode.HTML;

/** Campos que audita el modo TEXT por defecto; replica de `DEFAULT_POST_IA_SOURCE_FIELDS`. */
export const DEFAULT_POST_IA_SOURCE_FIELDS: readonly string[] = ['headline', 'summary'];

/** Techo de campos en modo TEXT; replica de `MAX_POST_IA_SOURCE_FIELDS`. */
export const MAX_POST_IA_SOURCE_FIELDS = 20;

/** Tope de selectores estructurales, replicado de `MAX_REQUIRED_SELECTORS`. */
export const MAX_REQUIRED_SELECTORS = 10;

/** Longitud maxima de un selector CSS, replicada de `MAX_SELECTOR_LENGTH`. */
export const MAX_SELECTOR_LENGTH = 120;

/** Tope de la lista blanca por nodo, replicado de `MAX_ALLOWED_TAGS`. */
export const MAX_ALLOWED_TAGS = 40;

/**
 * Nombre de etiqueta HTML en minusculas, replicado del `HTML_TAG_PATTERN` del DTO.
 *
 * El saneador escribe las etiquetas en minusculas, y una que no coincida seria
 * un recorte silenciosamente inerte: el operador creeria haber restringido la
 * lista blanca y no habria restringido nada.
 */
export const HTML_TAG_PATTERN = /^[a-z][a-z0-9]*$/;

/**
 * Etiquetas que el saneador del backend admite, para poblar el selector cerrado.
 *
 * REPLICA de `TEMPLATE_SANITIZER_CONFIG.allowedTags`
 * (`template-renderer.service.ts`). La copia es lo que permite que `allowedTags`
 * sea un selector CERRADO en vez de texto libre: el parametro solo puede
 * RESTRINGIR esta lista, y pedir algo que no figure en ella es
 * `ERR_POST_IA_UNSUPPORTED_TAGS`. Ofrecer texto libre dejaria al operador
 * descubriendo esa regla con el flujo ya PAUSADO.
 */
export const SANITIZER_ALLOWED_TAGS: readonly string[] = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'a',
  'b',
  'i',
  'strong',
  'em',
  'u',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'div',
  'span',
  'img',
  'br',
  'hr',
  'blockquote',
  'figure',
  'figcaption',
  'code',
  'pre',
  'sub',
  'sup',
  'small',
  'time',
];

/** Clave de un atajo de la lista de etiquetas permitidas. */
export type AllowedTagPresetKey =
  'RICH_TEXT' | 'PANEL_ACORDEON' | 'FULL_STRUCTURE' | 'UNRESTRICTED';

/** Un atajo: su rotulo para el boton y las etiquetas que escribe. */
export interface AllowedTagPreset {
  readonly label: string;
  readonly tags: readonly string[];
}

/**
 * Atajos para `allowedTags`, ordenados de mas restrictivo a menos.
 *
 * `allowedTags` solo puede RESTRINGIR `SANITIZER_ALLOWED_TAGS`: pedir una
 * etiqueta que no figure alli es `ERR_POST_IA_UNSUPPORTED_TAGS` al ejecutar.
 * Por eso cada atajo es un subconjunto comprobable de esa lista, y la prueba
 * del componente lo verifica en vez de confiar en la revision.
 *
 * `UNRESTRICTED` es la lista VACIA y no la lista entera: un `allowedTags: []`
 * significa "no recortes nada" y deja que el saneador aplique su propia lista
 * blanca. Copiar aqui las 39 etiquetas crearia una segunda fuente de verdad que
 * se quedaria atras en cuanto el saneador admitiese una mas.
 */
export const ALLOWED_TAG_PRESETS: Readonly<Record<AllowedTagPresetKey, AllowedTagPreset>> = {
  RICH_TEXT: {
    label: 'Texto enriquecido basico',
    tags: ['p', 'strong', 'em', 'ul', 'li', 'a'],
  },
  // Exactamente lo que necesita el panel colapsable de Bootstrap del canal de
  // verificacion de titulos, y nada mas. Es MAS ESTRECHO que "estructura
  // completa" a proposito: deja fuera `p`, `img`, `ul` y `li`, que en este
  // fragmento solo pueden venir de que el modelo se haya puesto a redactar por
  // su cuenta dentro de la tabla.
  PANEL_ACORDEON: {
    label: 'Panel colapsable (acordeon)',
    tags: ['div', 'h5', 'a', 'strong', 'span', 'table', 'tbody', 'tr', 'th', 'td'],
  },
  FULL_STRUCTURE: {
    label: 'Estructura completa',
    tags: [
      'p',
      'strong',
      'em',
      'ul',
      'li',
      'a',
      'img',
      'table',
      'tr',
      'th',
      'td',
      'div',
      'span',
      'h3',
      'h4',
      'h5',
      'hr',
    ],
  },
  UNRESTRICTED: {
    label: 'Sin restricciones',
    tags: [],
  },
};

/**
 * Configuracion del nodo `ESCUDO_POST_IA` en el cliente.
 *
 * NINGUN campo es opcional aqui, aunque el DTO del backend los admita todos
 * ausentes: un `undefined` enlazado a un control de Quasar lo convierte en campo
 * descontrolado y avisa por consola en cada pulsacion. La ausencia se representa
 * con `''` o `[]`, y es `toNodeParams()` quien decide que se publica en el
 * `pipeline_schema` y que se omite.
 */
export interface PostIaSanitizerNodeConfig {
  contentMode: PostIaContentMode;
  sourceNamespace: string;
  /** Solo modo TEXT. */
  sourceFields: string[];
  sourceField: string;
  requiredSelectors: string[];
  allowedTags: string[];
}
