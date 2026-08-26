import { OtpConfigService } from '@modules/auth/services/otp-config.service';

import type { ConfigService } from '@nestjs/config';

const MASTER_SECRET = 'semilla-maestra-de-pruebas';
const USER_A = 'admin@unuware.com';
const USER_B = 'editor@unuware.com';

/** `ConfigService` doble con la semilla y la ventana de expiracion. */
const buildConfigService = (
  overrides: { otpSecret?: string; expirationMinutes?: number } = {},
): ConfigService =>
  ({
    get: jest.fn((key: string) => {
      if (key === 'OTP_SECRET')
        return 'otpSecret' in overrides ? overrides.otpSecret : MASTER_SECRET;
      if (key === 'OTP_EXPIRATION_MINUTES')
        return overrides.expirationMinutes ?? 5;
      return undefined;
    }),
  }) as unknown as ConfigService;

describe('OtpConfigService (PROT-04.1)', () => {
  let service: OtpConfigService;

  beforeEach(() => {
    service = new OtpConfigService(buildConfigService());
  });

  it('deberia generar un codigo de exactamente 6 digitos numericos', async () => {
    // 2. Act
    const code = await service.generateCode(USER_A);

    // 3. Assert
    expect(code).toMatch(/^\d{6}$/);
  });

  it('deberia verificar como valido el codigo que acaba de generar para ese usuario', async () => {
    // 1. Arrange
    const code = await service.generateCode(USER_A);

    // 2. Act
    const isValid = await service.verifyCode(USER_A, code);

    // 3. Assert
    expect(isValid).toBe(true);
  });

  it('deberia rechazar el codigo del usuario A cuando se presenta como usuario B', async () => {
    // 1. Arrange: el secreto se deriva del correo, asi que cada cuenta tiene el suyo
    const codeForUserA = await service.generateCode(USER_A);

    // 2. Act
    const isValidForOtherUser = await service.verifyCode(USER_B, codeForUserA);

    // 3. Assert
    expect(isValidForOtherUser).toBe(false);
  });

  it('deberia derivar codigos distintos para usuarios distintos en el mismo instante', async () => {
    // 2. Act
    const [codeA, codeB] = await Promise.all([
      service.generateCode(USER_A),
      service.generateCode(USER_B),
    ]);

    // 3. Assert
    expect(codeA).not.toBe(codeB);
  });

  it('deberia normalizar el correo: mayusculas y espacios producen el mismo secreto', async () => {
    // 1. Arrange
    const code = await service.generateCode(USER_A);

    // 2. Act
    const isValid = await service.verifyCode('  ADMIN@UNUWARE.COM  ', code);

    // 3. Assert
    expect(isValid).toBe(true);
  });

  it('deberia rechazar un codigo arbitrario que nunca fue emitido', async () => {
    // 2. Act
    const isValid = await service.verifyCode(USER_A, '000000');

    // 3. Assert
    expect(isValid).toBe(false);
  });

  it('deberia rechazar el codigo emitido con una semilla maestra distinta', async () => {
    // 1. Arrange
    const otherInstance = new OtpConfigService(
      buildConfigService({ otpSecret: 'otra-semilla' }),
    );
    const codeFromOtherSeed = await otherInstance.generateCode(USER_A);

    // 2. Act
    const isValid = await service.verifyCode(USER_A, codeFromOtherSeed);

    // 3. Assert
    expect(isValid).toBe(false);
  });

  it('deberia fallar si OTP_SECRET no esta definida', async () => {
    // 1. Arrange
    const serviceWithoutSecret = new OtpConfigService(
      buildConfigService({ otpSecret: undefined }),
    );

    // 2. Act & 3. Assert
    await expect(serviceWithoutSecret.generateCode(USER_A)).rejects.toThrow(
      /OTP_SECRET/,
    );
  });
});
