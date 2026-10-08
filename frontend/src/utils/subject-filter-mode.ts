// Helper puro de dominio (frontend-architecture.md §2.1): sin estado ni E/S.
//
// Traduce entre el PATRON que persiste el nodo TRIGGER_IMAP
// (`params.subjectFilterRegex`, una expresion regular) y los dos modos
// asistidos que ofrece el formulario. El DTO del backend valida con
// `forbidNonWhitelisted`, de modo que el modo elegido NO puede guardarse como
// una clave mas: se DERIVA de la forma del patron al hidratar, igual que
// `web-scraper.store.ts` deduce `isFirstEligibleTarget` de la forma de
// `targetUrl`.

/**
 * Modos de coincidencia del asunto.
 *
 * `ADVANCED` es la valvula de escape y tambien el respaldo: cualquier patron
 * que no se reconozca como generado por los otros dos cae aqui, de modo que un
 * flujo heredado jamas pierde su expresion.
 */
export type SubjectMatchMode = 'CONTAINS' | 'STARTS_WITH' | 'ADVANCED';

/** Modo con el que arranca un nodo nuevo. */
export const DEFAULT_SUBJECT_MATCH_MODE: SubjectMatchMode = 'CONTAINS';

/** Separador de terminos del modo "contiene", tal y como lo teclea el operador. */
const TERM_SEPARATOR = ',';

/** Metacaracteres que hay que neutralizar para tratar un texto como literal. */
const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Forma exacta que produce `buildContainsPattern` con dos o mas terminos. */
const ALTERNATION_SHAPE = /^\(\?:(.+)\)$/;

/** Forma exacta que produce `buildStartsWithPattern`. */
const ANCHORED_SHAPE = /^\^(.*)$/;

/** Neutraliza los metacaracteres para que el texto case consigo mismo. */
export const escapeRegExpLiteral = (value: string): string =>
  value.replace(REGEXP_METACHARACTERS, '\\$&');

/**
 * Deshace `escapeRegExpLiteral`.
 *
 * Solo se usa para COMPROBAR el viaje de ida y vuelta: si al volver a escapar
 * no sale el mismo patron, el patron no lo genero este modulo y pertenece a
 * `ADVANCED`.
 */
const unescapeRegExpLiteral = (value: string): string => value.replace(/\\(.)/g, '$1');

/** El patron es exactamente lo que este modulo produciria para ese literal. */
const isPlainLiteral = (pattern: string): boolean =>
  pattern !== '' && escapeRegExpLiteral(unescapeRegExpLiteral(pattern)) === pattern;

/** Trocea la entrada del operador en terminos limpios y sin repetir. */
export const splitSubjectTerms = (draft: string): string[] => [
  ...new Set(
    draft
      .split(TERM_SEPARATOR)
      .map((term) => term.trim())
      .filter((term) => term !== ''),
  ),
];

/**
 * Compone el patron del modo "contiene texto".
 *
 * Sin anclas: en una expresion regular, buscar sin anclar YA es "contiene".
 * Con un solo termino se omite el grupo, porque `(?:licitacion)` y
 * `licitacion` casan lo mismo y el segundo es el que el operador reconoce al
 * volver a abrir el formulario.
 *
 * La insensibilidad a mayusculas NO se codifica aqui: la aporta el flag `i`
 * con el que la estrategia compila el patron. Expresarla en el propio texto
 * exigiria clases de caracteres por letra, ilegibles al editarlas a mano desde
 * el modo avanzado.
 */
export const buildContainsPattern = (draft: string): string => {
  const terms = splitSubjectTerms(draft).map(escapeRegExpLiteral);

  if (terms.length === 0) return '';
  if (terms.length === 1) return terms[0] as string;

  return `(?:${terms.join('|')})`;
};

/** Compone el patron del modo "empieza por": ancla de inicio y literal escapado. */
export const buildStartsWithPattern = (draft: string): string => {
  const prefix = draft.trim();

  return prefix === '' ? '' : `^${escapeRegExpLiteral(prefix)}`;
};

/** Compone el patron correspondiente al modo activo. */
export const buildSubjectPattern = (mode: SubjectMatchMode, draft: string): string => {
  if (mode === 'CONTAINS') return buildContainsPattern(draft);
  if (mode === 'STARTS_WITH') return buildStartsWithPattern(draft);

  // En `ADVANCED` el operador escribe el patron directamente: no hay nada que
  // componer y el borrador ES el patron.
  return draft;
};

/** Modo y borrador legible que corresponden a un patron ya guardado. */
export interface SubjectPatternReading {
  mode: SubjectMatchMode;
  draft: string;
}

/**
 * Deduce de que modo salio un patron guardado.
 *
 * El orden importa: `^S_2026_` tambien es un literal escapado valido, asi que
 * la forma anclada se comprueba ANTES que la llana.
 */
export const readSubjectPattern = (pattern: string): SubjectPatternReading => {
  if (pattern === '') {
    return { mode: DEFAULT_SUBJECT_MATCH_MODE, draft: '' };
  }

  const anchored = ANCHORED_SHAPE.exec(pattern);
  if (anchored !== null && isPlainLiteral(anchored[1] as string)) {
    return { mode: 'STARTS_WITH', draft: unescapeRegExpLiteral(anchored[1] as string) };
  }

  const alternation = ALTERNATION_SHAPE.exec(pattern);
  if (alternation !== null) {
    const terms = (alternation[1] as string).split('|');

    if (terms.length > 1 && terms.every(isPlainLiteral)) {
      return { mode: 'CONTAINS', draft: terms.map(unescapeRegExpLiteral).join(', ') };
    }
  }

  if (isPlainLiteral(pattern)) {
    return { mode: 'CONTAINS', draft: unescapeRegExpLiteral(pattern) };
  }

  return { mode: 'ADVANCED', draft: pattern };
};
