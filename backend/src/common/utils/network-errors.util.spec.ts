import { isTransientNetworkError } from './network-errors.util';

/**
 * Lo que se mide aqui es una DECISION DE OPERACION, no un detalle de formato:
 * un `true` significa "no molestes a nadie, vuelve a intentarlo" y un `false`
 * significa "abre una incidencia GRAVE". Equivocarse en el primer sentido
 * entierra una averia real; en el segundo, llena la bandeja del operador de
 * cortes de VPN.
 */
describe('isTransientNetworkError', () => {
  describe('1. Cortes de enlace que se resuelven solos', () => {
    it.each([
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'ECONNREFUSED',
      'EHOSTUNREACH',
      'EAI_AGAIN',
    ])('1.1 deberia reconocer el codigo %s', (code: string) => {
      // 1. Arrange 📐
      const error = Object.assign(new Error('fallo de red'), { code });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it('1.2 deberia reconocer "Connection not available" por el mensaje', () => {
      // 1. Arrange 📐: asi lo entrega `imapflow`, que pierde el `errno`.
      const error = new Error('Connection not available');

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(error)).toBe(true);
    });

    it('1.3 deberia desenvolver un AggregateError', () => {
      // 1. Arrange 📐: Node entrega asi el fallo de una resolucion con varias
      //    direcciones. El `code` de arriba es `undefined`.
      const aggregate = new AggregateError(
        [
          Object.assign(new Error('connect ETIMEDOUT 10.0.0.1:993'), {
            code: 'ETIMEDOUT',
          }),
        ],
        'ETIMEDOUT',
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(aggregate)).toBe(true);
    });

    it('1.4 deberia desenvolver la cadena de `cause`', () => {
      // 1. Arrange 📐
      const wrapped = new Error('No se pudo abrir el buzon', {
        cause: Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(wrapped)).toBe(true);
    });
  });

  describe('2. Averias que SI hay que escalar', () => {
    it('2.1 NO deberia tratar unas credenciales rechazadas como corte', () => {
      // 1. Arrange 📐: el control negativo que impide que la clasificacion se
      //    trague todo y el buzon caiga en silencio.
      const error = new Error('Invalid credentials (Failure)');

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it('2.2 NO deberia tratar un fallo de programacion como corte', () => {
      // 1. Arrange 📐
      const error = new TypeError('Cannot read properties of undefined');

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(error)).toBe(false);
    });

    it.each([null, undefined, 'ETIMEDOUT', 42])(
      '2.3 deberia devolver false ante un valor no-objeto (%p)',
      (value: unknown) => {
        // 1. Arrange 📐 & 2. Act ⚙️ & 3. Assert 🎯: un `catch` recibe
        //    cualquier cosa, no solo `Error`.
        expect(isTransientNetworkError(value)).toBe(false);
      },
    );
  });

  describe('3. Robustez del recorrido', () => {
    it('3.1 no deberia colgarse con una cadena de `cause` circular', () => {
      // 1. Arrange 📐: esto corre dentro del `catch` de un `setInterval`; un
      //    bucle aqui congelaria el worker entero.
      const first = new Error('primero');
      const second = new Error('segundo', { cause: first });
      Object.assign(first, { cause: second });

      // 2. Act ⚙️ & 3. Assert 🎯
      expect(isTransientNetworkError(first)).toBe(false);
    });
  });
});
