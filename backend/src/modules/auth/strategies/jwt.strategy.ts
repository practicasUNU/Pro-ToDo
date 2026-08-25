import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UserRole } from '@modules/users/enums/user-role.enum';

import type {
  AuthenticatedUser,
  JwtPayload,
} from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Estrategia de verificacion del JWT corporativo (PROT-04.2).
 *
 * Solo VERIFICA tokens ya emitidos: la generacion tras el OTP corresponde a PROT-04.1.
 * No consulta la base de datos; la identidad viaja completa en el payload firmado.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    const jwtSecret = configService.get<string>('JWT_SECRET');

    // Guarda de arranque: sin secreto no se puede verificar nada, el proceso no debe levantar.
    if (!jwtSecret) {
      throw new Error(
        'JWT_SECRET no esta definida: el modulo de autenticacion no puede iniciarse.',
      );
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  /**
   * Normaliza el payload verificado a la identidad que consumen los guards.
   * Rechaza tokens bien firmados pero con claims incompletos o un rol desconocido.
   */
  public validate(payload: JwtPayload): AuthenticatedUser {
    if (
      !payload?.sub ||
      !payload.role ||
      !Object.values(UserRole).includes(payload.role)
    ) {
      throw new UnauthorizedException(
        'Token invalido: el payload no contiene una identidad valida.',
      );
    }

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
