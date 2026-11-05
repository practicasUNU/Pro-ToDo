// Helper puro: sin estado ni E/S.
//
// Sustituye la coincidencia por subcadena que hacia el patron `(?:a|b)` del
// modo "contiene": con el, el termino "de" casaba dentro de "DESTINO" y el
// filtro dejaba pasar casi cualquier correo en espanol. Aqui el asunto se parte
// en palabras y cada termino se compara contra palabras COMPLETAS.

import { normalizeSubjectText } from '@modules/nodes/utils/diacritics.util';

import { SubjectMatchMode } from './imap-trigger.types';

/**
 * Separador de palabras: cualquier caracter que no sea letra ni digito.
 *
 * Se usa `\p{L}` / `\p{N}` y no `\w` porque `\w` solo cubre ASCII: partiria
 * "año" en "a" y "o". La enie sobrevive a la normalizacion (`normalizeSubjectText`
 * la recompone en NFC), de modo que llega aqui como una sola letra.
 */
const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;

/**
 * Parte un texto en palabras normalizadas: minusculas, sin acentos y sin
 * puntuacion. "PRUEBA: Destino-HTTP" → `["prueba", "destino", "http"]`.
 */
export const tokenizeSubject = (text: string): string[] =>
  normalizeSubjectText(text)
    .split(WORD_SEPARATOR)
    .filter((token) => token.length > 0);

/**
 * Convierte la lista de terminos que escribio el operador en palabras sueltas.
 *
 * Acepta tanto un arreglo como una cadena separada por comas. Un termino con
 * varias palabras ("titulo oficial") se parte en sus palabras, porque la
 * comparacion es palabra a palabra; los duplicados se eliminan.
 */
export const parseKeywords = (
  keywords: string | readonly string[],
): string[] => {
  const terms = typeof keywords === 'string' ? keywords.split(',') : keywords;

  return [...new Set(terms.flatMap((term) => tokenizeSubject(term)))];
};

/**
 * Decide si un asunto casa con las palabras clave.
 *
 * - `TODAS_LAS_PALABRAS` (AND): cada palabra debe aparecer como palabra completa.
 * - `AL_MENOS_UNA` (OR): basta con una palabra completa.
 *
 * Sin palabras clave no hay filtro y devuelve `true`.
 */
export const matchesSubjectKeywords = (
  subject: string,
  keywords: string | readonly string[],
  mode: SubjectMatchMode,
): boolean => {
  const terms = parseKeywords(keywords);

  if (terms.length === 0) return true;

  const tokens = new Set(tokenizeSubject(subject));

  return mode === SubjectMatchMode.TODAS_LAS_PALABRAS
    ? terms.every((term) => tokens.has(term))
    : terms.some((term) => tokens.has(term));
};
