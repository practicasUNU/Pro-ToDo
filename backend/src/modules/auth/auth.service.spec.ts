import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from '@modules/auth/auth.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { EmailService } from '@common/services/email.service';
import type { JwtService } from '@nestjs/jwt';
import type { OtpConfigService } from '@modules/auth/services/otp-config.service';
import type { User } from '@modules/users/entities/user.entity';
import type { UsersService } from '@modules/users/users.service';

const ACTIVE_USER: User = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
  isActive: true,
};

const INACTIVE_USER: User = {
  ...ACTIVE_USER,
  email: 'baja@unuware.com',
  isActive: false,
};

const GENERATED_CODE = '123456';
const SIGNED_TOKEN = 'jwt.firmado.de.prueba';

describe('AuthService (PROT-04.1)', () => {
  let usersService: jest.Mocked<Pick<UsersService, 'findByEmail'>>;
  let otpConfigService: jest.Mocked<
    Pick<OtpConfigService, 'generateCode' | 'verifyCode'>
  >;
  let emailService: jest.Mocked<Pick<EmailService, 'sendOtpCode'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let service: AuthService;

  beforeEach(() => {
    usersService = { findByEmail: jest.fn() };
    otpConfigService = {
      generateCode: jest.fn().mockResolvedValue(GENERATED_CODE),
      verifyCode: jest.fn().mockResolvedValue(true),
    };
    emailService = { sendOtpCode: jest.fn().mockResolvedValue(undefined) };
    jwtService = { sign: jest.fn().mockReturnValue(SIGNED_TOKEN) };

    service = new AuthService(
      usersService as unknown as UsersService,
      otpConfigService as unknown as OtpConfigService,
      emailService as unknown as EmailService,
      jwtService as unknown as JwtService,
    );
  });

  describe('requestOtp', () => {
    it('deberia generar el codigo y enviarlo por correo cuando el usuario esta activo', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      await service.requestOtp(ACTIVE_USER.email);

      // 3. Assert
      expect(otpConfigService.generateCode).toHaveBeenCalledWith(
        ACTIVE_USER.email,
      );
      expect(emailService.sendOtpCode).toHaveBeenCalledWith(
        ACTIVE_USER.email,
        GENERATED_CODE,
      );
    });

    it('NUNCA deberia retornar el codigo generado en el valor de retorno', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.requestOtp(ACTIVE_USER.email);

      // 3. Assert: el unico canal del codigo es el correo
      expect(result).toBeUndefined();
      expect(JSON.stringify(result ?? {})).not.toContain(GENERATED_CODE);
    });

    it('deberia terminar en silencio, sin lanzar, si el correo no existe (anti-enumeracion)', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(
        service.requestOtp('fantasma@unuware.com'),
      ).resolves.toBeUndefined();
      expect(otpConfigService.generateCode).not.toHaveBeenCalled();
      expect(emailService.sendOtpCode).not.toHaveBeenCalled();
    });

    it('deberia terminar en silencio si la cuenta existe pero esta desactivada', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(INACTIVE_USER);

      // 2. Act & 3. Assert
      await expect(
        service.requestOtp(INACTIVE_USER.email),
      ).resolves.toBeUndefined();
      expect(emailService.sendOtpCode).not.toHaveBeenCalled();
    });
  });

  describe('verifyOtp', () => {
    it('deberia emitir el token y la identidad cuando el codigo es valido', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.verifyOtp(ACTIVE_USER.email, GENERATED_CODE);

      // 3. Assert
      expect(result).toEqual({
        accessToken: SIGNED_TOKEN,
        user: {
          id: ACTIVE_USER.id,
          email: ACTIVE_USER.email,
          role: UserRole.ADMIN,
        },
      });
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: ACTIVE_USER.id,
        email: ACTIVE_USER.email,
        role: UserRole.ADMIN,
      });
    });

    it('NUNCA deberia incluir el codigo OTP en la respuesta de sesion', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.verifyOtp(ACTIVE_USER.email, GENERATED_CODE);

      // 3. Assert
      expect(JSON.stringify(result)).not.toContain(GENERATED_CODE);
    });

    it('deberia lanzar UnauthorizedException cuando el codigo es invalido o expiro', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(ACTIVE_USER);
      otpConfigService.verifyCode.mockResolvedValue(false);

      // 2. Act & 3. Assert
      await expect(
        service.verifyOtp(ACTIVE_USER.email, '000000'),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('deberia lanzar UnauthorizedException, no NotFound, si el correo no existe', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(null);

      // 2. Act & 3. Assert: mismo error que un codigo erroneo, para no enumerar cuentas
      await expect(
        service.verifyOtp('fantasma@unuware.com', GENERATED_CODE),
      ).rejects.toThrow(UnauthorizedException);
      expect(otpConfigService.verifyCode).not.toHaveBeenCalled();
    });

    it('deberia rechazar a un usuario desactivado aunque el codigo fuese correcto', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValue(INACTIVE_USER);

      // 2. Act & 3. Assert
      await expect(
        service.verifyOtp(INACTIVE_USER.email, GENERATED_CODE),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('deberia devolver el mismo mensaje para cuenta inexistente y codigo invalido', async () => {
      // 1. Arrange
      usersService.findByEmail.mockResolvedValueOnce(null);
      const missingAccountError = await service
        .verifyOtp('fantasma@unuware.com', GENERATED_CODE)
        .catch((error: UnauthorizedException) => error.message);

      usersService.findByEmail.mockResolvedValueOnce(ACTIVE_USER);
      otpConfigService.verifyCode.mockResolvedValueOnce(false);

      // 2. Act
      const wrongCodeError = await service
        .verifyOtp(ACTIVE_USER.email, '000000')
        .catch((error: UnauthorizedException) => error.message);

      // 3. Assert
      expect(missingAccountError).toBe(wrongCodeError);
    });
  });
});
