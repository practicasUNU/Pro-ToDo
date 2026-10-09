import { clamp } from './clamp.util';

describe('clamp', () => {
  describe('1. Recorte a los extremos', () => {
    it('1.1 deberia devolver el valor intacto cuando ya cabe en el intervalo', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯: el caso corriente, que es el
      //    de un `timeoutMs` declarado en los `params` del nodo y ya validado.
      expect(clamp(60_000, 1_000, 120_000)).toBe(60_000);
    });

    it('1.2 deberia recortar por arriba y por abajo', () => {
      // 1. Arrange 📐: el caso que justifica la funcion — un valor que llega del
      //    `.env`, donde `class-validator` no alcanza.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(clamp(999_999_999, 1_000, 120_000)).toBe(120_000);
      expect(clamp(50, 1_000, 120_000)).toBe(1_000);
    });

    it('1.3 deberia admitir los propios extremos', () => {
      // 1. Arrange 📐: el intervalo es CERRADO. Importa porque el cero es un
      //    valor legitimo de `maxRetries` ("no reintentes") y recortarlo a uno
      //    haria imposible desactivar el reintento.
      // 2. Act ⚙️ + 3. Assert 🎯
      expect(clamp(0, 0, 5)).toBe(0);
      expect(clamp(5, 0, 5)).toBe(5);
    });
  });
});
