/**
 * Normaliza un texto para comparar sin acentos ni mayusculas.
 *
 * Helper PURO (`frontend-architecture.md` §2.1): sin estado ni E/S.
 *
 * El plegado NFD separa cada letra de su diacritico y el reemplazo los descarta,
 * de modo que "licitacion" encuentra "Licitación". Sin el, buscar en un idioma
 * con tildes obliga a teclearlas exactamente igual que quien creo el registro,
 * que es la clase de friccion que un filtro existe para quitar.
 *
 * Es el mismo criterio que `normalizeSubjectText` aplica en el backend al
 * filtro de asunto del nodo IMAP.
 */
export const foldText = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** Lo minimo que este filtro necesita saber de una opcion. */
export interface FilterableOption {
  readonly label?: string;
  readonly value?: unknown;
  readonly name?: string;
}

/**
 * Texto por el que se busca una opcion.
 *
 * Se concatenan la etiqueta y el valor porque los selectores del proyecto usan
 * las dos formas: unos llevan `{ label, value }` y otros objetos de dominio con
 * `name`. Buscar solo por la etiqueta dejaria sin encontrar un namespace por su
 * clave tecnica, que es justamente como lo recuerda quien escribe marcadores.
 */
export const searchableText = (option: unknown): string => {
  if (typeof option === 'string') {
    return foldText(option);
  }

  if (option === null || typeof option !== 'object') {
    return foldText(String(option));
  }

  const { label, value, name } = option as FilterableOption;

  return foldText(
    [label, name, typeof value === 'string' ? value : undefined]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  );
};

/**
 * Filtra una lista de opciones por subcadena, sin acentos ni mayusculas.
 *
 * Subcadena y no prefijo: el operador recuerda un trozo del nombre, no como
 * empieza.
 */
export const filterOptions = <T>(options: readonly T[], needle: string): T[] => {
  const folded = foldText(needle);

  if (folded === '') {
    return [...options];
  }

  return options.filter((option) => searchableText(option).includes(folded));
};
