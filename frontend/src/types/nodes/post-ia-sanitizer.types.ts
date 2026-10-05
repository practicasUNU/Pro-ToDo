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
  sourceNamespace: string;
  sourceField: string;
  requiredSelectors: string[];
  allowedTags: string[];
}
