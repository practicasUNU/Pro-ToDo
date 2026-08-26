import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { EmailService } from '@common/services/email.service';
import { OtpConfigService } from '@modules/auth/services/otp-config.service';
import { UsersService } from '@modules/users/users.service';

import type {
  AuthTokenResponse,
  AuthenticatedUser,
  JwtPayload,
} from '@modules/auth/interfaces/jwt-payload.interface';
import type { User } from '@modules/users/entities/user.entity';

/**
 * Orquestador de la autenticacion sin contrasena (PROT-04.1).
 *
 * Coordina la busqueda del usuario, la emision del codigo, su envio por correo y la
 * firma del JWT. No conoce HTTP: los codigos de estado los decide el controlador.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly otpConfigService: OtpConfigService,
    private readonly emailService: EmailService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Genera y envia un codigo temporal al correo corporativo indicado.
   *
   * Anti-enumeracion: si el correo no existe o la cuenta esta desactivada, la
   * operacion termina en silencio con exito aparente. Nunca lanza 404 ni 403, porque
   * eso convertiria el endpoint en un validador de cuentas para un atacante.
   *
   * El codigo generado JAMAS se retorna ni se registra: su unico canal es el correo.
   */
  public async requestOtp(email: string): Promise<void> {
    const user = await this.usersService.findByEmail(email);

    if (!user || !user.isActive) {
      this.logger.warn(`Solicitud de OTP para un correo no elegible: ${email}`);
      return;
    }

    const code = await this.otpConfigService.generateCode(user.email);

    await this.emailService.sendOtpCode(user.email, code);
  }

  /**
   * Valida el codigo y, si es correcto, emite el JWT de sesion.
   *
   * @throws UnauthorizedException si el codigo es invalido, ha expirado, pertenece a
   *         otro usuario, o la cuenta no existe o esta desactivada.
   */
  public async verifyOtp(
    email: string,
    code: string,
  ): Promise<AuthTokenResponse> {
    const user = await this.usersService.findByEmail(email);

    // Mismo error para cuenta inexistente, inactiva y codigo erroneo: el cliente no
    // debe poder distinguir cual de los tres casos ocurrio.
    if (!user || !user.isActive) {
      throw new UnauthorizedException(
        'Credenciales invalidas o codigo expirado.',
      );
    }

    const isValidCode = await this.otpConfigService.verifyCode(
      user.email,
      code,
    );

    if (!isValidCode) {
      this.logger.warn(`Codigo OTP invalido para ${user.email}`);
      throw new UnauthorizedException(
        'Credenciales invalidas o codigo expirado.',
      );
    }

    return this.buildTokenResponse(user);
  }

  /** Firma el token con la identidad del usuario y arma la respuesta de sesion. */
  private buildTokenResponse(user: User): AuthTokenResponse {
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
      user: authenticatedUser,
    };
  }
}
