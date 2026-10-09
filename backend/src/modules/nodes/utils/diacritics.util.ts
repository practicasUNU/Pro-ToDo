// Helper puro: sin estado ni E/S.
//
// El plegado de diacriticos vive duplicado a proposito entre el gestor de
// prompts (`ai-prompt-templates.service.ts`, `deriveCodeFromName`) y este
// modulo. Son dos usos distintos de la misma tecnica —alli se deriva una clave
// de maquina, aqui se compara un asunto de correo— y fundirlos en una utilidad
// comun acoplaria el nodo de ingesta al modulo de prompts sin que ninguno de
// los dos gane nada.

/** Marcas diacriticas que deja la descomposicion NFD. */
const DIACRITICS = /[̀-ͯ]/g;

/**
 * Pliega los acentos de una cadena: "Verificación" → "Verificacion".
 *
 * `normalize('NFD')` separa cada vocal acentuada en su letra base mas la marca
 * combinante, y el reemplazo retira esas marcas. La cadena se devuelve en NFD
 * sin diacriticos, que para el alfabeto latino coincide con su forma NFC.
 *
 * NO toca la enie ni la cedilla: `ñ` y `ç` descomponen igualmente en NFD, de
 * modo que plegarlas haria casar "ano" con "año". El rango `̀-ͯ`
 * cubre el bloque de marcas combinantes entero, la tilde de la enie incluida,
 * asi que la unica forma de preservarlas seria recomponer despues. Se asume la
 * perdida a conciencia: el proposito es tolerar la falta de tilde al teclear un
 * filtro, y nadie escribe "Diseno" esperando casar "Diseño" sin saberlo.
 */
export const foldDiacritics = (value: string): string =>
  value.normalize('NFD').replace(DIACRITICS, '');
