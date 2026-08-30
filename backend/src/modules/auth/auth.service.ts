import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EmailService } from '@common/services/email.service';
import { OtpConfigService } from '@modules/auth/services/otp-config.service';
import { RefreshTokenService } from '@modules/auth/services/refresh-token.service';
import { UsersService } from '@modules/users/users.service';

import type {
  AuthTokenResponse,
  AuthenticatedUser,
  JwtPayload,
} from '@modules/auth/interfaces/jwt-payload.interface';
import type { User } from '@modules/users/entities/user.entity';

/** Mensaje unico de fallo de autenticacion: no distingue la causa. */
const INVALID_CREDENTIALS_MESSAGE = 'Credenciales invalidas o codigo expirado.';

/**
 * Orquestador de la autenticacion sin contrasena (PROT-04.1) y del ciclo de
 * sesion (PROT-06.4).
 *
 * Coordina la busqueda del usuario, la emision del codigo, su envio por correo y
 * la entrega del par de tokens. No conoce HTTP: los codigos de estado los decide
 * el controlador.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly otpConfigService: OtpConfigService,
    private readonly emailService: EmailService,
    private readonly jwtService: JwtService,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * Genera y envia un codigo temporal al correo corporativo indicado.
   *
   * ANTI-ENUMERACION: correo inexistente y cuenta desactivada terminan **igual**,
   * con un `return` silencioso y exito aparente. Nunca se lanza 401, 403 ni 404.
   *
   * Es deliberado y no negociable: cualquier respuesta que distinga esos casos
   * del camino feliz convierte el endpoint en un validador de cuentas. Un
   * atacante recorreria una lista de correos corporativos y sabria cuales estan
   * dados de alta solo mirando el codigo de estado.
   *
   * El motivo real del descarte viaja unicamente al log del servidor.
   *
   * El codigo generado JAMAS se retorna ni se registra: su unico canal es el correo.
   */
  public async requestOtp(email: string): Promise<void> {
    const user = await this.usersService.findByEmailWithOtpSecret(email);

    if (!user) {
      this.logger.warn(`Solicitud de OTP para un correo inexistente: ${email}`);
      return;
    }

    if (!user.isActive) {
      this.logger.warn(
        `Solicitud de OTP para una cuenta desactivada: ${email}`,
      );
      return;
    }

    // Inscripcion perezosa: las cuentas creadas antes de TOTP, o desde el CRUD,
    // no traen secreto. Se genera en la primera solicitud, sin migrar datos.
    const secret =
      user.otpSecret ??
      (await this.usersService.ensureOtpSecret(
        user.id,
        this.otpConfigService.generateSecret(),
      ));

    const code = await this.otpConfigService.generateCode(secret);

    await this.emailService.sendOtpCode(user.email, code);
  }

  /**
   * Valida el codigo y, si es correcto, abre la sesion.
   *
   * @throws UnauthorizedException si el codigo es invalido, ha expirado, pertenece a
   *         otro usuario, o la cuenta no existe o esta desactivada.
   */
  public async verifyOtp(
    email: string,
    code: string,
    deviceId: string,
  ): Promise<AuthTokenResponse> {
    const user = await this.usersService.findByEmailWithOtpSecret(email);

    // Mismo error para cuenta inexistente, inactiva, sin inscribir y codigo
    // erroneo: el cliente no debe poder distinguir cual de los casos ocurrio.
    //
    // Sin secreto NO se inscribe aqui: si la cuenta nunca solicito un codigo, no
    // hay codigo legitimo que validar, e inscribirla en este punto convertiria la
    // ruta de validacion en un canal de alta silencioso.
    if (!user || !user.isActive || !user.otpSecret) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const isValidCode = await this.otpConfigService.verifyCode(
      user.otpSecret,
      code,
    );

    if (!isValidCode) {
      this.logger.warn(`Codigo OTP invalido para ${user.email}`);
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    return this.buildTokenResponse(user, deviceId);
  }

  /**
   * Renueva la sesion canjeando el refresh token por un par nuevo (PROT-06.4).
   *
   * La rotacion la resuelve `RefreshTokenService`: aqui solo se vuelve a firmar
   * el access token para el usuario que aquel devuelve.
   *
   * El dispositivo no lo reenvia el cliente: viene del token canjeado, de modo que
   * la sesion conserva el mismo dispositivo durante toda su cadena de rotaciones.
   *
   * @throws UnauthorizedException propagada desde la rotacion.
   */
  public async refreshSession(rawToken: string): Promise<AuthTokenResponse> {
    const { user, deviceId } = await this.refreshTokenService.rotate(rawToken);

    return this.buildTokenResponse(user, deviceId);
  }

  /**
   * Cierra la sesion revocando el refresh token presentado.
   *
   * El access token sigue siendo valido hasta que caduque por su cuenta: es la
   * contrapartida de un JWT autocontenido, y el motivo de que su vigencia sea de
   * una hora y no de ocho.
   */
  public async logout(rawToken: string): Promise<void> {
    await this.refreshTokenService.revoke(rawToken);
  }

  /** Firma el access token, emite el refresh y arma la respuesta de sesion. */
  private async buildTokenResponse(
    user: User,
    deviceId: string,
  ): Promise<AuthTokenResponse> {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const authenticatedUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      refreshToken: await this.refreshTokenService.issue(user, deviceId),
      user: authenticatedUser,
    };
  }
}
