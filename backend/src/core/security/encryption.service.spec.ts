import { randomBytes } from 'node:crypto';

import {
  CREDENTIALS_ENCRYPTION_KEY_VAR,
  EncryptionService,
} from '@core/security/encryption.service';

import type { ConfigService } from '@nestjs/config';

const VALID_KEY = randomBytes(32).toString('base64');
const RECORD_ID = '0b9a2c47-5d1e-4f3a-8c6b-2e7d9f1a4b30';

const buildService = (key: string | undefined): EncryptionService => {
  const config = {
    get: jest.fn((name: string) =>
      name === CREDENTIALS_ENCRYPTION_KEY_VAR ? key : undefined,
    ),
  };
  const service = new EncryptionService(config as unknown as ConfigService);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

  return service;
};

describe('EncryptionService (AES-256-GCM)', () => {
  it('1.1 deberia descifrar exactamente lo que cifro', () => {
    // 1. Arrange 📐
    const service = buildService(VALID_KEY);
    const secret = JSON.stringify({ token: 'tok_ñandú_123' });

    // 2. Act ⚙️
    const payload = service.encrypt(secret, RECORD_ID);
    const restored = service.decrypt(payload, RECORD_ID);

    // 3. Assert 🎯
    expect(restored).toBe(secret);
    expect(payload.ciphertext).not.toContain('tok_');
  });

  it('1.2 deberia usar un IV distinto en cada cifrado', () => {
    // 1. Arrange 📐: reutilizar IV con la misma clave rompe GCM.
    const service = buildService(VALID_KEY);

    // 2. Act ⚙️
    const first = service.encrypt('mismo secreto', RECORD_ID);
    const second = service.encrypt('mismo secreto', RECORD_ID);

    // 3. Assert 🎯
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('2.1 deberia rechazar un texto cifrado alterado', () => {
    // 1. Arrange 📐
    const service = buildService(VALID_KEY);
    const payload = service.encrypt('secreto', RECORD_ID);
    const bytes = Buffer.from(payload.ciphertext, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(() =>
      service.decrypt(
        { ...payload, ciphertext: bytes.toString('base64') },
        RECORD_ID,
      ),
    ).toThrow();
  });

  it('2.2 deberia rechazar un blob copiado a otra fila (AAD distinto)', () => {
    // 1. Arrange 📐
    const service = buildService(VALID_KEY);
    const payload = service.encrypt('secreto', RECORD_ID);

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(() =>
      service.decrypt(payload, '7c1e3f5a-0000-4000-8000-000000000000'),
    ).toThrow();
  });

  it('2.3 deberia rechazar una clave distinta', () => {
    // 1. Arrange 📐
    const payload = buildService(VALID_KEY).encrypt('secreto', RECORD_ID);
    const other = buildService(randomBytes(32).toString('base64'));

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(() => other.decrypt(payload, RECORD_ID)).toThrow();
  });

  it('3.1 no deberia ser utilizable sin clave o con una clave de otra longitud', () => {
    // 1. Arrange 📐 + 2. Act ⚙️ + 3. Assert 🎯
    expect(buildService(undefined).isUsable).toBe(false);
    expect(buildService('   ').isUsable).toBe(false);
    expect(buildService(randomBytes(16).toString('base64')).isUsable).toBe(
      false,
    );
    expect(buildService(VALID_KEY).isUsable).toBe(true);
  });

  it('3.2 deberia negarse a cifrar sin clave, sin filtrar el valor', () => {
    // 1. Arrange 📐
    const service = buildService(undefined);

    // 2. Act ⚙️ + 3. Assert 🎯
    expect(() => service.encrypt('no-me-filtres', RECORD_ID)).toThrow(
      /CREDENTIALS_ENCRYPTION_KEY/,
    );
    expect(() => service.encrypt('no-me-filtres', RECORD_ID)).not.toThrow(
      /no-me-filtres/,
    );
  });
});
