import { describe, expect, it } from 'vitest';

import { areParamsEqual, parseParamsObject, stringifyParams } from './params-json';

describe('params-json · editor de parametros de un nodo de plantilla', () => {
  describe('1. Interpretacion del texto', () => {
    it('1.1 deberia devolver el objeto cuando el texto es JSON valido', () => {
      // 1. Arrange & 2. Act
      const result = parseParamsObject('{"cronExpression":"0 9 * * 1-5"}');

      // 3. Assert
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toEqual({ cronExpression: '0 9 * * 1-5' });
    });

    it('1.2 deberia aceptar el objeto vacio', () => {
      // 1. Arrange & 2. Act: es el `params` por defecto legitimo de una
      //    plantilla, y el backend lo admite (`@IsObject()` a secas).
      const result = parseParamsObject('{}');

      // 3. Assert
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).toEqual({});
    });

    it('1.3 deberia rechazar un arreglo', () => {
      // 1. Arrange & 2. Act: pasaria el `typeof === 'object'` de JavaScript y lo
      //    rechazaria el servidor mucho mas tarde y peor explicado.
      const result = parseParamsObject('[1, 2]');

      // 3. Assert
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain('objeto JSON');
    });

    it.each([
      ['null', 'nulo'],
      ['42', 'numero'],
      ['"texto"', 'cadena'],
      ['true', 'booleano'],
    ])('1.4 deberia rechazar %s (%s)', (text) => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(parseParamsObject(text).ok).toBe(false);
    });

    it('1.5 deberia rechazar el texto vacio sin lanzar', () => {
      // 1. Arrange & 2. Act
      const result = parseParamsObject('   ');

      // 3. Assert: se sugiere `{}` en vez de dejar al operador adivinando.
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message).toContain('{}');
    });

    it('1.6 deberia conservar el mensaje del motor con un JSON a medio escribir', () => {
      // 1. Arrange & 2. Act: el mensaje nativo indica la posicion del caracter
      //    que rompe el documento, que es lo util para corregirlo.
      const result = parseParamsObject('{"host":');

      // 3. Assert
      expect(result.ok).toBe(false);
      expect(!result.ok && result.message.length).toBeGreaterThan(0);
    });
  });

  describe('2. Serializacion', () => {
    it('2.1 deberia indentar a dos espacios', () => {
      // 1. Arrange & 2. Act
      const text = stringifyParams({ host: 'imap.unuware.com' });

      // 3. Assert
      expect(text).toBe('{\n  "host": "imap.unuware.com"\n}');
    });

    it('2.2 deberia reproducir el objeto en la ida y vuelta', () => {
      // 1. Arrange
      const params = { host: 'imap.unuware.com', port: 993, secure: true };

      // 2. Act
      const result = parseParamsObject(stringifyParams(params));

      // 3. Assert
      expect(result.ok && result.value).toEqual(params);
    });
  });

  describe('3. Igualdad canonica', () => {
    it('3.1 deberia considerar iguales dos objetos con las claves en otro orden', () => {
      // 1. Arrange & 2. Act & 3. Assert: `JSON.stringify` respeta el orden de
      //    insercion, asi que sin normalizar, un objeto reconstruido con las
      //    mismas claves reescribiria el editor y moveria el cursor sin motivo.
      expect(areParamsEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    });

    it('3.2 deberia distinguir un valor cambiado en profundidad', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(
        areParamsEqual({ filtros: { asunto: 'Notiweb' } }, { filtros: { asunto: 'Otro' } }),
      ).toBe(false);
    });

    it('3.3 deberia respetar el orden dentro de un arreglo', () => {
      // 1. Arrange & 2. Act & 3. Assert: en un arreglo el orden SI es dato.
      expect(areParamsEqual({ pasos: [1, 2] }, { pasos: [2, 1] })).toBe(false);
    });
  });
});
