import { UnauthorizedException } from '@nestjs/common';

import { AuthService } from '@modules/auth/auth.service';
import { UserRole } from '@modules/users/enums/user-role.enum';

import type { EmailService } from '@common/services/email.service';
import type { JwtService } from '@nestjs/jwt';
import type { OtpConfigService } from '@modules/auth/services/otp-config.service';
import type { RefreshTokenService } from '@modules/auth/services/refresh-token.service';
import type { User } from '@modules/users/entities/user.entity';
import type { UsersService } from '@modules/users/users.service';

const OTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const NEW_SECRET = 'KRUGS4ZANFZSAYJANFZSAYJANFZSAYJA';

const ACTIVE_USER: User = {
  id: '3f1c2b64-8a5e-4c2f-9d3a-7b6e5f4c1a20',
  email: 'admin@unuware.com',
  role: UserRole.ADMIN,
  otpSecret: OTP_SECRET,
  isActive: true,
};

/** Cuenta creada desde el CRUD que aun no ha solicitado ningun codigo. */
const UNENROLLED_USER: User = { ...ACTIVE_USER, otpSecret: null };

const INACTIVE_USER: User = {
  ...ACTIVE_USER,
  email: 'baja@unuware.com',
  isActive: false,
};

const GENERATED_CODE = '123456';
const SIGNED_TOKEN = 'jwt.firmado.de.prueba';
const ISSUED_REFRESH_TOKEN = 'refresh-opaco-de-prueba';

/** Dispositivo que el cliente envia al validar el OTP. */
const DEVICE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

/** Dispositivo grabado en un token ya emitido, para la ruta de renovacion. */
const ROTATED_DEVICE_ID = 'e1d2c3b4-a5f6-4e7d-8c9b-0a1f2e3d4c5b';

describe('AuthService (PROT-04.1 / PROT-06.4)', () => {
  let usersService: jest.Mocked<
    Pick<UsersService, 'findByEmailWithOtpSecret' | 'ensureOtpSecret'>
  >;
  let otpConfigService: jest.Mocked<
    Pick<OtpConfigService, 'generateSecret' | 'generateCode' | 'verifyCode'>
  >;
  let emailService: jest.Mocked<Pick<EmailService, 'sendOtpCode'>>;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let refreshTokenService: jest.Mocked<
    Pick<RefreshTokenService, 'issue' | 'rotate' | 'revoke'>
  >;
  let service: AuthService;

  beforeEach(() => {
    usersService = {
      findByEmailWithOtpSecret: jest.fn(),
      ensureOtpSecret: jest.fn().mockResolvedValue(NEW_SECRET),
    };
    otpConfigService = {
      generateSecret: jest.fn().mockReturnValue(NEW_SECRET),
      generateCode: jest.fn().mockResolvedValue(GENERATED_CODE),
      verifyCode: jest.fn().mockResolvedValue(true),
    };
    emailService = { sendOtpCode: jest.fn().mockResolvedValue(undefined) };
    jwtService = { sign: jest.fn().mockReturnValue(SIGNED_TOKEN) };
    refreshTokenService = {
      issue: jest.fn().mockResolvedValue(ISSUED_REFRESH_TOKEN),
      rotate: jest
        .fn()
        .mockResolvedValue({ user: ACTIVE_USER, deviceId: ROTATED_DEVICE_ID }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };

    service = new AuthService(
      usersService as unknown as UsersService,
      otpConfigService as unknown as OtpConfigService,
      emailService as unknown as EmailService,
      jwtService as unknown as JwtService,
      refreshTokenService as unknown as RefreshTokenService,
    );
  });

  describe('requestOtp', () => {
    it('deberia generar el codigo y enviarlo por correo cuando el usuario esta activo', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      await service.requestOtp(ACTIVE_USER.email);

      // 3. Assert
      expect(otpConfigService.generateCode).toHaveBeenCalledWith(OTP_SECRET);
      expect(emailService.sendOtpCode).toHaveBeenCalledWith(
        ACTIVE_USER.email,
        GENERATED_CODE,
      );
    });

    it('NUNCA deberia retornar el codigo generado en el valor de retorno', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.requestOtp(ACTIVE_USER.email);

      // 3. Assert: el unico canal del codigo es el correo
      expect(result).toBeUndefined();
      expect(JSON.stringify(result ?? {})).not.toContain(GENERATED_CODE);
    });

    it('deberia terminar en silencio, sin lanzar, si el correo no existe (anti-enumeracion)', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(
        service.requestOtp('fantasma@unuware.com'),
      ).resolves.toBeUndefined();
      expect(otpConfigService.generateCode).not.toHaveBeenCalled();
      expect(emailService.sendOtpCode).not.toHaveBeenCalled();
    });

    it('deberia inscribir la cuenta y usar el secreto nuevo si aun no tiene uno', async () => {
      // 1. Arrange: cuenta creada desde el CRUD, sin secreto TOTP
      usersService.findByEmailWithOtpSecret.mockResolvedValue(UNENROLLED_USER);

      // 2. Act
      await service.requestOtp(UNENROLLED_USER.email);

      // 3. Assert
      expect(otpConfigService.generateSecret).toHaveBeenCalledTimes(1);
      expect(usersService.ensureOtpSecret).toHaveBeenCalledWith(
        UNENROLLED_USER.id,
        NEW_SECRET,
      );
      expect(otpConfigService.generateCode).toHaveBeenCalledWith(NEW_SECRET);
    });

    it('NO deberia reinscribir una cuenta que ya tiene secreto', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      await service.requestOtp(ACTIVE_USER.email);

      // 3. Assert: sobreescribir el secreto invalidaria los codigos ya enviados
      expect(usersService.ensureOtpSecret).not.toHaveBeenCalled();
      expect(otpConfigService.generateSecret).not.toHaveBeenCalled();
    });

    it('deberia respetar el secreto ganador ante una inscripcion concurrente', async () => {
      // 1. Arrange: otro proceso inscribio la cuenta primero, asi que la
      // actualizacion condicional devuelve el secreto preexistente
      usersService.findByEmailWithOtpSecret.mockResolvedValue(UNENROLLED_USER);
      usersService.ensureOtpSecret.mockResolvedValue(OTP_SECRET);

      // 2. Act
      await service.requestOtp(UNENROLLED_USER.email);

      // 3. Assert: el codigo se emite con el secreto persistido, no con el propio
      expect(otpConfigService.generateCode).toHaveBeenCalledWith(OTP_SECRET);
    });

    it('deberia terminar en silencio si la cuenta existe pero esta desactivada', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(INACTIVE_USER);

      // 2. Act & 3. Assert
      await expect(
        service.requestOtp(INACTIVE_USER.email),
      ).resolves.toBeUndefined();
      expect(emailService.sendOtpCode).not.toHaveBeenCalled();
    });

    it('ANTI-ENUMERACION: cuenta inexistente, inactiva y valida son indistinguibles', async () => {
      // 1. Arrange: se recoge el desenlace de los tres caminos posibles
      const outcomeFor = async (
        user: User | null,
        email: string,
      ): Promise<string> => {
        usersService.findByEmailWithOtpSecret.mockResolvedValueOnce(user);
        return service
          .requestOtp(email)
          .then((result) => `resuelve:${String(result)}`)
          .catch((error: Error) => `lanza:${error.message}`);
      };

      // 2. Act
      const unknown = await outcomeFor(null, 'fantasma@unuware.com');
      const inactive = await outcomeFor(INACTIVE_USER, INACTIVE_USER.email);
      const active = await outcomeFor(ACTIVE_USER, ACTIVE_USER.email);

      // 3. Assert: identicos hacia fuera. Si esta prueba falla, se reabrio el
      // oraculo y el endpoint volvio a ser un validador de cuentas.
      expect(unknown).toBe('resuelve:undefined');
      expect(inactive).toBe(unknown);
      expect(active).toBe(unknown);
    });
  });

  describe('verifyOtp', () => {
    it('deberia emitir el par de tokens y la identidad cuando el codigo es valido', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.verifyOtp(
        ACTIVE_USER.email,
        GENERATED_CODE,
        DEVICE_ID,
      );

      // 3. Assert
      expect(result).toEqual({
        accessToken: SIGNED_TOKEN,
        refreshToken: ISSUED_REFRESH_TOKEN,
        user: {
          id: ACTIVE_USER.id,
          email: ACTIVE_USER.email,
          role: UserRole.ADMIN,
        },
      });
      expect(refreshTokenService.issue).toHaveBeenCalledWith(
        ACTIVE_USER,
        DEVICE_ID,
      );
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: ACTIVE_USER.id,
        email: ACTIVE_USER.email,
        role: UserRole.ADMIN,
      });
    });

    it('NUNCA deberia incluir el codigo OTP en la respuesta de sesion', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.verifyOtp(
        ACTIVE_USER.email,
        GENERATED_CODE,
        DEVICE_ID,
      );

      // 3. Assert
      expect(JSON.stringify(result)).not.toContain(GENERATED_CODE);
    });

    it('deberia lanzar UnauthorizedException cuando el codigo es invalido o expiro', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);
      otpConfigService.verifyCode.mockResolvedValue(false);

      // 2. Act & 3. Assert
      await expect(
        service.verifyOtp(ACTIVE_USER.email, '000000', DEVICE_ID),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('deberia lanzar UnauthorizedException, no NotFound, si el correo no existe', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(null);

      // 2. Act & 3. Assert: mismo error que un codigo erroneo, para no enumerar cuentas
      await expect(
        service.verifyOtp('fantasma@unuware.com', GENERATED_CODE, DEVICE_ID),
      ).rejects.toThrow(UnauthorizedException);
      expect(otpConfigService.verifyCode).not.toHaveBeenCalled();
    });

    it('deberia rechazar a un usuario desactivado aunque el codigo fuese correcto', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(INACTIVE_USER);

      // 2. Act & 3. Assert
      await expect(
        service.verifyOtp(INACTIVE_USER.email, GENERATED_CODE, DEVICE_ID),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('deberia rechazar a una cuenta sin secreto sin inscribirla', async () => {
      // 1. Arrange: nunca pidio un codigo, asi que no hay codigo legitimo
      usersService.findByEmailWithOtpSecret.mockResolvedValue(UNENROLLED_USER);

      // 2. Act & 3. Assert
      await expect(
        service.verifyOtp(UNENROLLED_USER.email, GENERATED_CODE, DEVICE_ID),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.ensureOtpSecret).not.toHaveBeenCalled();
      expect(otpConfigService.verifyCode).not.toHaveBeenCalled();
    });

    it('deberia validar el codigo contra el secreto persistido del usuario', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      await service.verifyOtp(ACTIVE_USER.email, GENERATED_CODE, DEVICE_ID);

      // 3. Assert
      expect(otpConfigService.verifyCode).toHaveBeenCalledWith(
        OTP_SECRET,
        GENERATED_CODE,
      );
    });

    it('NUNCA deberia incluir el secreto TOTP en la respuesta de sesion', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValue(ACTIVE_USER);

      // 2. Act
      const result = await service.verifyOtp(
        ACTIVE_USER.email,
        GENERATED_CODE,
        DEVICE_ID,
      );

      // 3. Assert
      expect(JSON.stringify(result)).not.toContain(OTP_SECRET);
    });

    it('deberia devolver el mismo mensaje para cuenta inexistente y codigo invalido', async () => {
      // 1. Arrange
      usersService.findByEmailWithOtpSecret.mockResolvedValueOnce(null);
      const missingAccountError = await service
        .verifyOtp('fantasma@unuware.com', GENERATED_CODE, DEVICE_ID)
        .catch((error: UnauthorizedException) => error.message);

      usersService.findByEmailWithOtpSecret.mockResolvedValueOnce(ACTIVE_USER);
      otpConfigService.verifyCode.mockResolvedValueOnce(false);

      // 2. Act
      const wrongCodeError = await service
        .verifyOtp(ACTIVE_USER.email, '000000', DEVICE_ID)
        .catch((error: UnauthorizedException) => error.message);

      // 3. Assert
      expect(missingAccountError).toBe(wrongCodeError);
    });
  });

  describe('refreshSession', () => {
    it('deberia entregar un par nuevo canjeando el refresh token', async () => {
      // 2. Act
      const result = await service.refreshSession('refresh-anterior');

      // 3. Assert
      expect(refreshTokenService.rotate).toHaveBeenCalledWith(
        'refresh-anterior',
      );
      expect(result).toEqual({
        accessToken: SIGNED_TOKEN,
        refreshToken: ISSUED_REFRESH_TOKEN,
        user: {
          id: ACTIVE_USER.id,
          email: ACTIVE_USER.email,
          role: UserRole.ADMIN,
        },
      });
    });

    it('deberia emitir un refresh distinto del presentado (rotacion)', async () => {
      // 2. Act
      const result = await service.refreshSession('refresh-anterior');

      // 3. Assert
      expect(result.refreshToken).not.toBe('refresh-anterior');
      expect(refreshTokenService.issue).toHaveBeenCalledWith(
        ACTIVE_USER,
        ROTATED_DEVICE_ID,
      );
    });

    it('deberia arrastrar el deviceId del token rotado sin que el cliente lo reenvie', async () => {
      // 2. Act: `/auth/refresh` solo recibe el refresh token, nunca un deviceId
      await service.refreshSession('refresh-anterior');

      // 3. Assert: el dispositivo sale del token canjeado, asi que la sesion
      // conserva el mismo equipo durante toda su cadena de rotaciones.
      expect(refreshTokenService.issue).toHaveBeenCalledWith(
        ACTIVE_USER,
        ROTATED_DEVICE_ID,
      );
      expect(refreshTokenService.issue).not.toHaveBeenCalledWith(
        ACTIVE_USER,
        DEVICE_ID,
      );
    });

    it('deberia propagar el UnauthorizedException de la rotacion sin firmar nada', async () => {
      // 1. Arrange
      refreshTokenService.rotate.mockRejectedValue(
        new UnauthorizedException('Sesion invalida o expirada.'),
      );

      // 2. Act & 3. Assert
      await expect(service.refreshSession('robado')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwtService.sign).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('deberia revocar el refresh token presentado', async () => {
      // 2. Act
      await service.logout('refresh-vigente');

      // 3. Assert
      expect(refreshTokenService.revoke).toHaveBeenCalledWith(
        'refresh-vigente',
      );
    });
  });
});
