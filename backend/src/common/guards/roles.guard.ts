import { ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from '@common/constants/security.constants';

import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { RequestWithUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Control de acceso basado en roles (PROT-04.2).
 *
 * Se apoya en la metadata de `@Roles(...)` y en la identidad que `JwtAuthGuard` deja
 * en `req.user`. Un usuario autenticado con rol insuficiente recibe 403 Forbidden,
 * nunca 401: el token es valido, lo que falta es autorizacion.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  public canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      UserRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    // Ruta sin restriccion de rol: la autorizacion la resuelven otros guards.
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();

    if (!user) {
      throw new ForbiddenException(
        'Acceso denegado: no se pudo determinar la identidad del solicitante.',
      );
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Acceso denegado: se requiere uno de los siguientes roles (${requiredRoles.join(', ')}).`,
      );
    }

    return true;
  }
}
