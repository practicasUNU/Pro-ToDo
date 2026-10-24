import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { isUUID } from 'class-validator';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { UserRole } from '@modules/users/enums/user-role.enum';
import { UsersService } from '@modules/users/users.service';

import type {
  AuthenticatedUser,
  JwtPayload,
} from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Estrategia de verificacion del JWT corporativo (PROT-04.2).
 *
 * Solo VERIFICA tokens ya emitidos: la generacion tras el OTP corresponde a
 * PROT-04.1.
 *
 * SI CONSULTA LA BASE DE DATOS, y el cambio es deliberado: hasta la migracion
 * 051 la identidad viajaba entera en el payload firmado y no habia forma de
 * desautorizar un token ya emitido. Revocar los refresh tokens no bastaba
 * —eso solo impide RENOVAR—, de modo que un ADMIN degradado a EDITOR, o una
 * cuenta recien desactivada, conservaban sus privilegios hasta que el token
 * caducaba solo (`JWT_EXPIRES_IN`, hoy 1h). Ahora cada peticion comprueba la
 * generacion del token contra `usuarios.token_version`.
 *
 * El coste es un `SELECT` por peticion autenticada, acotado a dos columnas en
 * `UsersService.findAuthState`. Es el precio de poder cortar una sesion
 * privilegiada en el acto, y se paga a sabiendas.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
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
   *
   * Rechaza, por este orden: claims incompletos o rol desconocido (el token ni
   * siquiera describe una identidad), cuenta inexistente o desactivada, y
   * token de una generacion anterior a la vigente.
   *
   * El mensaje de las tres ultimas es el MISMO y no distingue el motivo: a
   * quien presenta un token caduco no se le confirma si la cuenta existe, si
   * sigue activa o si simplemente le cambiaron el rol.
   */
  public async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // `isUUID` y no un simple "existe": el `sub` acaba en una columna UUID de
    // PostgreSQL, y un valor con otra forma hacia saltar al driver con
    // `invalid input syntax for type uuid` —un 500 que ademas delataba el
    // motor— en lugar del 401 que corresponde a un token sin identidad valida.
    if (
      !payload?.sub ||
      !isUUID(payload.sub) ||
      !payload.role ||
      !Object.values(UserRole).includes(payload.role)
    ) {
      throw new UnauthorizedException(
        'Token invalido: el payload no contiene una identidad valida.',
      );
    }

    const authState = await this.usersService.findAuthState(payload.sub);

    if (authState === null || !authState.isActive) {
      throw new UnauthorizedException(
        'Token invalido: la sesion ya no es valida. Vuelve a iniciar sesion.',
      );
    }

    // `?? 0` cubre los tokens emitidos ANTES de la migracion 051, que no traen
    // el claim: se tratan como la generacion inicial para que el despliegue no
    // expulse de golpe a todas las sesiones vivas.
    if ((payload.tokenVersion ?? 0) !== authState.tokenVersion) {
      throw new UnauthorizedException(
        'Token invalido: la sesion ya no es valida. Vuelve a iniciar sesion.',
      );
    }

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
