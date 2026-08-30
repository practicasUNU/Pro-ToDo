import { OtpConfigService } from '@modules/auth/services/otp-config.service';

import type { ConfigService } from '@nestjs/config';

const EXPIRATION_MINUTES = 5;

/** `ConfigService` doble con la ventana de expiracion. */
const buildConfigService = (
  overrides: { expirationMinutes?: number } = {},
): ConfigService =>
  ({
    get: jest.fn((key: string) =>
      key === 'OTP_EXPIRATION_MINUTES'
        ? (overrides.expirationMinutes ?? EXPIRATION_MINUTES)
        : undefined,
    ),
  }) as unknown as ConfigService;

describe('OtpConfigService (PROT-04.1)', () => {
  let service: OtpConfigService;

  beforeEach(() => {
    service = new OtpConfigService(buildConfigService());
  });

  describe('generateSecret', () => {
    it('deberia devolver un secreto base32 de 32 caracteres sin relleno', () => {
      // 2. Act
      const secret = service.generateSecret();

      // 3. Assert
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    });

    it('deberia devolver un secreto distinto en cada llamada', () => {
      // 2. Act
      const secrets = new Set(
        Array.from({ length: 50 }, () => service.generateSecret()),
      );

      // 3. Assert: sin colisiones, el secreto es aleatorio y no derivado
      expect(secrets.size).toBe(50);
    });
  });

  describe('generateCode / verifyCode', () => {
    it('deberia generar un codigo de exactamente 6 digitos numericos', async () => {
      // 1. Arrange
      const secret = service.generateSecret();

      // 2. Act
      const code = await service.generateCode(secret);

      // 3. Assert
      expect(code).toMatch(/^\d{6}$/);
    });

    it('deberia verificar como valido el codigo que acaba de generar', async () => {
      // 1. Arrange
      const secret = service.generateSecret();
      const code = await service.generateCode(secret);

      // 2. Act
      const isValid = await service.verifyCode(secret, code);

      // 3. Assert
      expect(isValid).toBe(true);
    });

    it('deberia rechazar el codigo de un secreto cuando se valida contra otro', async () => {
      // 1. Arrange: cada cuenta tiene su propio secreto aleatorio
      const secretA = service.generateSecret();
      const secretB = service.generateSecret();
      const codeForA = await service.generateCode(secretA);

      // 2. Act
      const isValid = await service.verifyCode(secretB, codeForA);

      // 3. Assert
      expect(isValid).toBe(false);
    });

    it('deberia producir codigos distintos para secretos distintos en el mismo instante', async () => {
      // 1. Arrange
      const secretA = service.generateSecret();
      const secretB = service.generateSecret();

      // 2. Act
      const [codeA, codeB] = await Promise.all([
        service.generateCode(secretA),
        service.generateCode(secretB),
      ]);

      // 3. Assert
      expect(codeA).not.toBe(codeB);
    });

    it('deberia rechazar un codigo arbitrario que nunca fue emitido', async () => {
      // 1. Arrange
      const secret = service.generateSecret();

      // 2. Act
      const isValid = await service.verifyCode(secret, '000000');

      // 3. Assert
      expect(isValid).toBe(false);
    });

    it('deberia rechazar un codigo del futuro (tolerancia solo hacia el pasado)', async () => {
      // 1. Arrange: se adelanta el reloj para emitir un codigo aun no vigente
      const secret = service.generateSecret();
      const realNow = Date.now;
      Date.now = () => realNow() + 10 * 60 * 1000;
      const futureCode = await service.generateCode(secret);
      Date.now = realNow;

      // 2. Act
      const isValid = await service.verifyCode(secret, futureCode);

      // 3. Assert
      expect(isValid).toBe(false);
    });
  });

  describe('getExpirationSeconds', () => {
    it('deberia convertir OTP_EXPIRATION_MINUTES a segundos', () => {
      // 3. Assert
      expect(service.getExpirationSeconds()).toBe(EXPIRATION_MINUTES * 60);
    });

    it('deberia caer a 5 minutos si la variable no esta definida', () => {
      // 1. Arrange
      const withoutConfig = new OtpConfigService({
        get: jest.fn(() => undefined),
      } as unknown as ConfigService);

      // 3. Assert
      expect(withoutConfig.getExpirationSeconds()).toBe(300);
    });
  });
});
