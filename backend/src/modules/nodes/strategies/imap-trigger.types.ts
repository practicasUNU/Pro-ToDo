/**
 * Modo de combinacion de las palabras clave del filtro de asunto.
 *
 * Los valores van en espanol porque viajan tal cual en el `pipeline_schema`
 * guardado y los lee el operador en el JSON del flujo, igual que los
 * `NodeType`.
 */
export enum SubjectMatchMode {
  /** AND: el asunto debe contener cada una de las palabras. */
  TODAS_LAS_PALABRAS = 'TODAS_LAS_PALABRAS',
  /** OR: basta con que el asunto contenga una de las palabras. */
  AL_MENOS_UNA = 'AL_MENOS_UNA',
}

/** Modo aplicado cuando el nodo declara palabras clave sin indicar el modo. */
export const DEFAULT_SUBJECT_MATCH_MODE = SubjectMatchMode.AL_MENOS_UNA;

/** Tope de palabras clave por nodo: un filtro mas largo deja de ser legible. */
export const MAX_SUBJECT_KEYWORDS = 20;

/** Longitud maxima de cada palabra clave. */
export const MAX_SUBJECT_KEYWORD_LENGTH = 100;
