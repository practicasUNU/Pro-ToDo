import {
  BlockedOutboundTargetError,
  assertPublicHttpUrl,
  createBlockingLookup,
  isBlockedAddress,
} from '@core/http/outbound-url.guard';

import type { LookupAddress } from 'node:dns';

/** Resolutor DNS falso: ninguna prueba pregunta al DNS del sistema. */
const fakeResolver =
  (addresses: LookupAddress[]) =>
  (
    _hostname: string,
    _options: unknown,
    callback: (
      error: NodeJS.ErrnoException | null,
      result: LookupAddress[],
    ) => void,
  ): void => {
    callback(null, addresses);
  };

const runLookup = (
  addresses: LookupAddress[],
): Promise<{ error: Error | null; address: unknown }> =>
  new Promise((resolve) => {
    const lookup = createBlockingLookup(
      fakeResolver(addresses) as unknown as Parameters<
        typeof createBlockingLookup
      >[0],
    );
    lookup('destino.ejemplo', {}, (error, address) =>
      resolve({ error, address }),
    );
  });

describe('outbound-url.guard (SSRF)', () => {
  describe('1. isBlockedAddress', () => {
    it.each([
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd12::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ])('1.1 deberia bloquear %s', (address) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(isBlockedAddress(address)).toBe(true);
    });

    it.each(['8.8.8.8', '151.101.1.69', '2606:4700::6810:84e5'])(
      '1.2 deberia permitir la direccion publica %s',
      (address) => {
        // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
        expect(isBlockedAddress(address)).toBe(false);
      },
    );
  });

  describe('2. assertPublicHttpUrl', () => {
    it.each([
      ['file:///etc/passwd', 'Protocolo'],
      ['gopher://ejemplo.org', 'Protocolo'],
      ['http://169.254.169.254/latest/meta-data', 'red privada'],
      ['http://[::1]:5432', 'red privada'],
      ['http://localhost:3000', 'localhost'],
      ['https://user:clave@api.ejemplo.org', 'contrasena'],
      ['no-es-una-url', 'URL absoluta'],
    ])('2.1 deberia rechazar %s', (url, reason) => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(() => assertPublicHttpUrl(url)).toThrow(
        BlockedOutboundTargetError,
      );
      expect(() => assertPublicHttpUrl(url)).toThrow(reason);
    });

    it('2.2 deberia admitir una URL https publica', () => {
      // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
      expect(assertPublicHttpUrl('https://api.ejemplo.org/v1').hostname).toBe(
        'api.ejemplo.org',
      );
    });
  });

  describe('3. createBlockingLookup (DNS rebinding)', () => {
    it('3.1 deberia rechazar un nombre que resuelve a una IP privada', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const { error } = await runLookup([{ address: '10.0.0.5', family: 4 }]);

      // 3. Assert 🎯
      expect(error).toBeInstanceOf(BlockedOutboundTargetError);
    });

    it('3.2 deberia rechazar si UNA de las direcciones es privada', async () => {
      // 1. Arrange 📐: un registro publico no puede tapar uno privado.
      // 2. Act ⚙️
      const { error } = await runLookup([
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);

      // 3. Assert 🎯
      expect(error).toBeInstanceOf(BlockedOutboundTargetError);
    });

    it('3.3 deberia devolver la direccion publica', async () => {
      // 1. Arrange 📐 + 2. Act ⚙️
      const { error, address } = await runLookup([
        { address: '8.8.8.8', family: 4 },
      ]);

      // 3. Assert 🎯
      expect(error).toBeNull();
      expect(address).toBe('8.8.8.8');
    });
  });
});
