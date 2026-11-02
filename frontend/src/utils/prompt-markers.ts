/**
 * Gramatica de los marcadores de PROMPT de IA, sin dependencias de CodeMirror.
 *
 * Un prompt admite `{{ns.campo}}` (opcional: si falta se sustituye por `""`) y
 * `{{*ns.campo}}` (obligatorio: si falta, el nodo PROCESADOR_IA pausa el flujo
 * antes de llamar al proveedor). Replica `INTERPOLATION_PATTERN` del backend
 * (`state-payload.context.ts`), donde el asterisco es opcional y no capturante.
 *
 * Vive fuera de `codemirror-markers.ts` porque la consumen tambien stores y
 * componentes que no montan ningun editor, y no deben arrastrar CodeMirror.
 */

/** Marcador de prompt; espacios interiores tolerados (`{{ * ns.campo }}`). */
export const PROMPT_MARKER_PATTERN =
  /\{\{\s*(?:\*\s*)?[a-zA-Z0-9_]+(?:\.(?:[a-zA-Z0-9_]+|\[\d+\]))+\s*\}\}/g;

/** Inicio de una marca obligatoria. */
const MANDATORY_PREFIX_PATTERN = /^\{\{\s*\*/;

/** Llaves, asterisco y espacios que envuelven la ruta. */
const MARKER_WRAPPER_PATTERN = /^\{\{\s*\*?\s*|\s*\}\}$/g;

/** El texto de un marcador ya casado es una marca obligatoria. */
export const isMandatoryMarker = (marker: string): boolean => MANDATORY_PREFIX_PATTERN.test(marker);

/** Clase del chip de una variable obligatoria (`{{*ns.campo}}`). Global, en `app.scss`. */
export const MANDATORY_CHIP_CLASS = 'pd-chip-mandatory';

/** Clase del chip de una variable opcional (`{{ns.campo}}`). Global, en `app.scss`. */
export const OPTIONAL_CHIP_CLASS = 'pd-chip-optional';

/** Clase de chip que corresponde al texto de un marcador de prompt. */
export const chipClassFor = (marker: string): string =>
  isMandatoryMarker(marker) ? MANDATORY_CHIP_CLASS : OPTIONAL_CHIP_CLASS;

/** Compone el marcador de un campo; con `mandatory`, lleva el asterisco. */
export const buildMarker = (namespace: string, field: string, mandatory = false): string =>
  `{{${mandatory ? '*' : ''}${namespace}.${field}}}`;

/**
 * Rutas (`ns.campo`) que un prompt marca como obligatorias, sin duplicados y en
 * orden de aparicion. Es lo que el nodo IA exigira al contexto en ejecucion.
 */
export const extractMandatoryPromptVariables = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(PROMPT_MARKER_PATTERN)]
      .map(([marker]) => marker)
      .filter(isMandatoryMarker)
      .map((marker) => marker.replace(MARKER_WRAPPER_PATTERN, '')),
  ),
];
