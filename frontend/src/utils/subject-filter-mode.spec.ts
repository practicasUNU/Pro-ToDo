import { describe, expect, it } from 'vitest';

import {
  buildSubjectPattern,
  escapeRegExpLiteral,
  readSubjectPattern,
  splitSubjectTerms,
} from '@/utils/subject-filter-mode';

describe('subject-filter-mode · composicion y lectura del filtro de asunto', () => {
  describe('1. Composicion del patron', () => {
    it('1.1 deberia unir varios terminos en una alternancia', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const pattern = buildSubjectPattern('CONTAINS', 'licitacion, convocatoria');

      // 3. Assert 🎯
      expect(pattern).toBe('(?:licitacion|convocatoria)');
    });

    it('1.2 deberia omitir el grupo con un solo termino', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: `(?:x)` y `x` casan lo mismo, y el segundo es
      //    el que el operador reconoce al reabrir el formulario.
      expect(buildSubjectPattern('CONTAINS', 'licitacion')).toBe('licitacion');
    });

    it('1.3 deberia anclar el prefijo en el modo "empieza por"', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      expect(buildSubjectPattern('STARTS_WITH', 'S_2026_')).toBe('^S_2026_');
    });

    it('1.4 deberia escapar los metacaracteres que teclee el operador', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: sin escapar, un punto casaria cualquier
      //    caracter y el filtro admitiria correos que nadie quiso admitir.
      const pattern = buildSubjectPattern('CONTAINS', 'acta n.1 (2026)');

      // 3. Assert 🎯
      expect(pattern).toBe(escapeRegExpLiteral('acta n.1 (2026)'));
      expect(new RegExp(pattern).test('acta n.1 (2026)')).toBe(true);
      expect(new RegExp(pattern).test('acta nX1 (2026)')).toBe(false);
    });

    it('1.5 deberia devolver cadena vacia cuando no hay terminos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: vacio significa "sin filtro", y el store lo
      //    omite de los `params` porque el DTO rechaza `''`.
      expect(buildSubjectPattern('CONTAINS', '  ,  , ')).toBe('');
      expect(buildSubjectPattern('STARTS_WITH', '   ')).toBe('');
    });

    it('1.6 deberia entregar el texto intacto en modo avanzado', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      expect(buildSubjectPattern('ADVANCED', '^S_2026_.*')).toBe('^S_2026_.*');
    });
  });

  describe('2. Troceado de terminos', () => {
    it('2.1 deberia recortar espacios y descartar repetidos', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      expect(splitSubjectTerms(' licitacion , convocatoria ,licitacion, ')).toEqual([
        'licitacion',
        'convocatoria',
      ]);
    });
  });

  describe('3. Lectura de un patron ya guardado', () => {
    it('3.1 deberia reconocer el patron que genera cada modo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: viaje de ida y vuelta, que es
      //    lo que permite no persistir el modo como un `param` mas.
      expect(readSubjectPattern('(?:licitacion|convocatoria)')).toEqual({
        mode: 'CONTAINS',
        draft: 'licitacion, convocatoria',
      });
      expect(readSubjectPattern('licitacion')).toEqual({
        mode: 'CONTAINS',
        draft: 'licitacion',
      });
      expect(readSubjectPattern('^S_2026_')).toEqual({
        mode: 'STARTS_WITH',
        draft: 'S_2026_',
      });
    });

    it('3.2 deberia abrir en modo avanzado un patron que no sabe expresar', () => {
      // 1. Arrange 📐 + 2. Act ⚙️: un flujo heredado jamas pierde su expresion.
      expect(readSubjectPattern('^S_2026_.*')).toEqual({
        mode: 'ADVANCED',
        draft: '^S_2026_.*',
      });
      expect(readSubjectPattern('(?:abc|[0-9]+)')).toEqual({
        mode: 'ADVANCED',
        draft: '(?:abc|[0-9]+)',
      });
    });

    it('3.3 deberia leer el patron vacio como "contiene" sin texto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      expect(readSubjectPattern('')).toEqual({ mode: 'CONTAINS', draft: '' });
    });

    it('3.4 deberia cerrar la ida y vuelta sobre un texto con metacaracteres', () => {
      // 1. Arrange 📐
      const draft = 'acta n.1, resolucion (final)';

      // 2. Act ⚙️
      const reading = readSubjectPattern(buildSubjectPattern('CONTAINS', draft));

      // 3. Assert 🎯
      expect(reading).toEqual({ mode: 'CONTAINS', draft });
    });
  });
});
