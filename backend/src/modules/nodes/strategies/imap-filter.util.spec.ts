import {
  matchesSubjectKeywords,
  parseKeywords,
  tokenizeSubject,
} from './imap-filter.util';
import { SubjectMatchMode } from './imap-trigger.types';

describe('imap-filter.util', () => {
  describe('tokenizeSubject', () => {
    it('deberia partir el asunto en palabras sin puntuacion ni acentos', () => {
      // Arrange 📐
      const subject = '  PRUEBA: Destino-HTTP, ¡Verificación! ';

      // Act ⚙️
      const tokens = tokenizeSubject(subject);

      // Assert 🎯
      expect(tokens).toEqual(['prueba', 'destino', 'http', 'verificacion']);
    });

    it('deberia conservar la enie como letra de la palabra', () => {
      // Arrange 📐 / Act ⚙️
      const tokens = tokenizeSubject('Diseño del año');

      // Assert 🎯
      expect(tokens).toEqual(['diseño', 'del', 'año']);
    });
  });

  describe('parseKeywords', () => {
    it('deberia aceptar una lista separada por comas y eliminar duplicados', () => {
      // Arrange 📐 / Act ⚙️
      const keywords = parseKeywords(' Verificación, titulos ,, verificacion ');

      // Assert 🎯
      expect(keywords).toEqual(['verificacion', 'titulos']);
    });
  });

  describe('matchesSubjectKeywords', () => {
    it('no deberia casar "de" dentro de la palabra "DESTINO"', () => {
      // Arrange 📐
      const subject = 'PRUEBA DESTINO HTTP';

      // Act ⚙️
      const matches = matchesSubjectKeywords(
        subject,
        'de',
        SubjectMatchMode.AL_MENOS_UNA,
      );

      // Assert 🎯
      expect(matches).toBe(false);
    });

    it('deberia casar todas las palabras completas en modo AND', () => {
      // Arrange 📐
      const subject = 'Solicitud de verificacion de titulos';

      // Act ⚙️
      const matches = matchesSubjectKeywords(
        subject,
        'verificacion, titulos',
        SubjectMatchMode.TODAS_LAS_PALABRAS,
      );

      // Assert 🎯
      expect(matches).toBe(true);
    });

    it('deberia rechazar en modo AND si falta una palabra', () => {
      // Arrange 📐 / Act ⚙️
      const matches = matchesSubjectKeywords(
        'Solicitud de verificacion',
        ['verificacion', 'titulos'],
        SubjectMatchMode.TODAS_LAS_PALABRAS,
      );

      // Assert 🎯
      expect(matches).toBe(false);
    });

    it('deberia casar en modo OR con una sola palabra presente', () => {
      // Arrange 📐 / Act ⚙️
      const matches = matchesSubjectKeywords(
        'Solicitud de verificacion',
        ['verificacion', 'titulos'],
        SubjectMatchMode.AL_MENOS_UNA,
      );

      // Assert 🎯
      expect(matches).toBe(true);
    });

    it('deberia tolerar tildes y mayusculas en ambos lados', () => {
      // Arrange 📐 / Act ⚙️
      const matches = matchesSubjectKeywords(
        'VERIFICACIÓN de títulos',
        'verificacion',
        SubjectMatchMode.AL_MENOS_UNA,
      );
      const reversed = matchesSubjectKeywords(
        'verificacion de titulos',
        'VERIFICACIÓN',
        SubjectMatchMode.AL_MENOS_UNA,
      );

      // Assert 🎯
      expect(matches).toBe(true);
      expect(reversed).toBe(true);
    });

    it('no deberia filtrar si no hay palabras clave', () => {
      // Arrange 📐 / Act ⚙️
      const matches = matchesSubjectKeywords(
        'Cualquier asunto',
        ' , ',
        SubjectMatchMode.TODAS_LAS_PALABRAS,
      );

      // Assert 🎯
      expect(matches).toBe(true);
    });

    it('no deberia casar con un asunto vacio cuando hay palabras clave', () => {
      // Arrange 📐 / Act ⚙️
      const matches = matchesSubjectKeywords(
        '',
        'titulos',
        SubjectMatchMode.AL_MENOS_UNA,
      );

      // Assert 🎯
      expect(matches).toBe(false);
    });
  });
});
