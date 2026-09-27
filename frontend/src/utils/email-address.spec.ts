import { describe, expect, it } from 'vitest';

import { isEmailAddress } from './email-address';

describe('isEmailAddress', () => {
  describe('1. Direcciones validas', () => {
    it.each([
      ['guardia@unuware.com', 'corporativa'],
      ['soporte@proveedor-externo.es', 'externa con guion en el dominio'],
      ['nombre.apellido@unuware.com', 'punto en la parte local'],
      ['alertas+flujos@unuware.com', 'etiqueta con mas'],
      ['a@b.co', 'la mas corta posible'],
      ['equipo@notificaciones.unuware.com', 'subdominio'],
    ])('1.1 deberia aceptar "%s" (%s)', (address) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(isEmailAddress(address)).toBe(true);
    });

    it('1.2 deberia tolerar los espacios de alrededor', () => {
      // 1. Arrange 📐: al pegar una direccion desde otra aplicacion viene con
      //    espacios, y el chip se crearia invalido sin motivo aparente.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(isEmailAddress('  guardia@unuware.com  ')).toBe(true);
    });
  });

  describe('2. Direcciones invalidas', () => {
    it.each([
      ['', 'cadena vacia'],
      ['   ', 'solo espacios'],
      ['guardia', 'sin arroba'],
      ['guardia@unuware', 'dominio sin punto'],
      ['guardia@@unuware.com', 'doble arroba'],
      ['@unuware.com', 'sin parte local'],
      ['guardia@', 'sin dominio'],
      ['guardia@unuware.', 'dominio terminado en punto'],
      ['guardia@.com', 'dominio que empieza por punto'],
      ['dos correos@unuware.com', 'espacio en medio'],
      ['guardia@unuware.com, otro@unuware.com', 'dos direcciones en una cadena'],
    ])('2.1 deberia rechazar "%s" (%s)', (address) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(isEmailAddress(address)).toBe(false);
    });
  });

  describe('3. Alcance declarado', () => {
    it('3.1 no deberia aspirar a RFC 5322 completo', () => {
      // 1. Arrange 📐: una direccion entrecomillada es valida segun la norma y
      //    aqui se rechaza. Queda aseverado para que el dia que alguien la
      //    necesite sea una decision y no un descubrimiento: quien manda sobre
      //    la validez es el `@IsEmail()` del DTO del backend.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(isEmailAddress('"nombre raro"@unuware.com')).toBe(false);
    });
  });
});
