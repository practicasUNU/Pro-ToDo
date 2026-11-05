import { describe, expect, it } from 'vitest';

import { isEmailAddress, parseEmailList } from './email-address';

describe('email-address · guardas Poka-Yoke del campo de destinatarios', () => {
  describe('1. isEmailAddress', () => {
    it('1.1 deberia aceptar una direccion con dominio y punto', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(isEmailAddress('guardia@unuware.com')).toBe(true);
    });

    it('1.2 deberia rechazar un dominio sin punto', () => {
      // 1. Arrange 📐: el error frecuente al teclear deprisa.
      expect(isEmailAddress('guardia@unuware')).toBe(false);
    });
  });

  describe('2. parseEmailList', () => {
    it('2.1 deberia separar por comas, espacios y puntos y coma', () => {
      // 1. Arrange 📐: los tres separadores que aparecen al copiar una lista
      //    desde un cliente de correo o una hoja de calculo.
      const raw = 'a@x.com, b@y.com; c@z.com d@w.com';

      // 2. Act ⚙️
      const parsed = parseEmailList(raw);

      // 3. Assert 🎯
      expect(parsed).toEqual(['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com']);
    });

    it('2.2 deberia DESCARTAR los fragmentos que no son direcciones', () => {
      // 1. Arrange 📐: es el objetivo entero del helper. Sin el, cada trozo
      //    suelto entraba como un chip que el backend rechazaba despues con un
      //    400 sobre el esquema completo.
      const raw = 'a@b.com, c@d.com;;  basura  e@f.com';

      // 2. Act ⚙️
      const parsed = parseEmailList(raw);

      // 3. Assert 🎯
      expect(parsed).toEqual(['a@b.com', 'c@d.com', 'e@f.com']);
    });

    it('2.3 deberia deduplicar preservando el orden', () => {
      // 1. Arrange 📐: repetir el correo en el origen no es un error que
      //    merezca aviso, pero mandar dos copias del aviso si molesta.
      const raw = 'b@y.com, a@x.com, b@y.com';

      // 2. Act ⚙️
      const parsed = parseEmailList(raw);

      // 3. Assert 🎯
      expect(parsed).toEqual(['b@y.com', 'a@x.com']);
    });

    it('2.4 deberia devolver vacio para un texto sin ninguna direccion', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(parseEmailList('   ;; , basura ')).toEqual([]);
    });
  });
});
