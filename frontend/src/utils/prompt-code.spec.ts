import { describe, expect, it } from 'vitest';

import { deriveCodeFromName, MAX_CODE_LENGTH, sanitizeCodeInput } from './prompt-code';

/**
 * Suite de la derivacion del codigo de una plantilla de prompt.
 *
 * Lo que se fija aqui es que el cliente y el backend produzcan el MISMO slug a
 * partir del mismo nombre: la funcion esta duplicada a proposito —el navegador
 * no puede importar del servidor— y una divergencia se manifestaria como un
 * codigo que cambia al guardar, sin ningun error que lo explique. Los casos de
 * `ai-prompt-templates.service.spec.ts` (bloque 8) son deliberadamente los
 * mismos.
 */
describe('prompt-code · derivacion de la clave de maquina', () => {
  describe('1. deriveCodeFromName', () => {
    it.each([
      ['Extraccion de noticias (ES)', 'EXTRACCION_DE_NOTICIAS_ES'],
      ['Licitacion   publica', 'LICITACION_PUBLICA'],
      ['  margenes  ', 'MARGENES'],
      ['ya_es_un_codigo', 'YA_ES_UN_CODIGO'],
    ])('1.1 deberia derivar "%s" en %s', (name, expected) => {
      // 1. Arrange 📐 & 2. Act ⚙️ & 3. Assert 🎯
      expect(deriveCodeFromName(name)).toBe(expected);
    });

    it('1.2 deberia plegar los acentos en vez de convertirlos en guion bajo', () => {
      // 1. Arrange 📐: el backfill SQL de la migracion 023 daba `EXTRACCI_N`
      //    porque en SQL plegar diacriticos no sale gratis. Este es el camino
      //    permanente y si puede permitirse el NFD.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(deriveCodeFromName('Extracción')).toBe('EXTRACCION');
    });

    it('1.3 deberia caer en PROMPT si el nombre no deja alfanumericos', () => {
      // 1. Arrange 📐: `CODE_PATTERN` exige al menos un caracter.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(deriveCodeFromName('---')).toBe('PROMPT');
    });

    it('1.4 deberia recortar al limite de la columna', () => {
      // 1. Arrange 📐
      const name = 'palabra '.repeat(20);

      // 2. Act ⚙️
      const code = deriveCodeFromName(name);

      // 3. Assert 🎯
      expect(code.length).toBeLessThanOrEqual(MAX_CODE_LENGTH);
      expect(code.startsWith('PALABRA_PALABRA')).toBe(true);
    });
  });

  describe('2. sanitizeCodeInput', () => {
    it('2.1 deberia respetar los guiones bajos de los extremos', () => {
      // 1. Arrange 📐: si los recortase, teclear `MI_CODIGO` seria imposible:
      //    el `_` desapareceria en cuanto se pulsara.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(sanitizeCodeInput('MI_')).toBe('MI_');
    });

    it('2.2 deberia pasar a mayusculas y convertir lo invalido en guion bajo', () => {
      // 1. Arrange 📐 & 2. Act ⚙️ & 3. Assert 🎯
      expect(sanitizeCodeInput('licitación 2027')).toBe('LICITACION_2027');
    });

    it('2.3 NO deberia caer en PROMPT con la cadena vacia', () => {
      // 1. Arrange 📐: el campo es opcional, y un respaldo aqui impediria
      //    borrarlo para que lo derive el backend.
      // 2. Act ⚙️ & 3. Assert 🎯
      expect(sanitizeCodeInput('')).toBe('');
    });
  });
});
