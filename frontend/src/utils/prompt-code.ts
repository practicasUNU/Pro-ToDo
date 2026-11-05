/** Replica `plantillas_prompts_ia.codigo VARCHAR(50)` y el DTO del backend. */
export const MAX_CODE_LENGTH = 50;

/** Forma admitida: mayusculas, digitos y guion bajo. Replica `CODE_PATTERN`. */
export const CODE_PATTERN = /^[A-Z0-9_]+$/;

/** Codigo de ultimo recurso cuando el nombre no deja un solo alfanumerico. */
const FALLBACK_CODE = 'PROMPT';

/** Marcas diacriticas que deja la descomposicion NFD. */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Deriva la clave de maquina de un prompt a partir de su nombre visible.
 *
 * "Extraccion de noticias (ES)" → `EXTRACCION_DE_NOTICIAS_ES`.
 *
 * DUPLICA A PROPOSITO la funcion homonima de
 * `AiPromptTemplatesService` (backend). No es una omision que se pueda
 * arreglar compartiendo codigo: el navegador no puede importar del servidor, y
 * el servidor no puede fiarse de lo que le mande el navegador, asi que la
 * derivacion tiene que existir en los dos lados. Aqui sirve para que el
 * operador VEA el codigo mientras teclea el nombre; alli es la garantia.
 *
 * Los simbolos pasan a `_` en vez de borrarse: borrarlos pegaria las palabras
 * ("Plan de innovacion" → `PLANDEINNOVACION`), ilegible justo donde el codigo
 * tiene que leerse.
 */
export const deriveCodeFromName = (name: string): string => {
  const normalized = name
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');

  // Los `_` de los extremos se recortan ANTES del corte y el respaldo se aplica
  // DESPUES: un nombre que sea todo simbolos colapsa a cadena vacia, y
  // `CODE_PATTERN` exige al menos un caracter.
  const trimmed = normalized.replace(/^_+|_+$/g, '').slice(0, MAX_CODE_LENGTH);

  return trimmed.length > 0 ? trimmed : FALLBACK_CODE;
};

/**
 * Sanea lo que el operador teclea en el campo de codigo.
 *
 * A diferencia de `deriveCodeFromName`, NO recorta los `_` de los extremos ni
 * aplica respaldo: hacerlo impediria escribir `MI_CODIGO` porque el `_` se
 * borraria en cuanto se tecleara. La validez final la decide la regla del
 * campo, no esta funcion.
 */
export const sanitizeCodeInput = (value: string): string =>
  value
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, MAX_CODE_LENGTH);
