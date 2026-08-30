import { createParamDecorator } from '@nestjs/common';

import type { ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedUser,
  RequestWithUser,
} from '@modules/auth/interfaces/jwt-payload.interface';

/**
 * Extrae la identidad ya verificada por `JwtAuthGuard` de `req.user`.
 *
 * No repite la comprobacion de "sin usuario": para cuando este decorador se
 * evalua, `JwtAuthGuard` y `RolesGuard` ya se ejecutaron sobre la ruta, y este
 * ultimo lanza `ForbiddenException` si `req.user` falta. El controlador siempre
 * lo recibe resuelto.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const { user } = context.switchToHttp().getRequest<RequestWithUser>();

    return user as AuthenticatedUser;
  },
);
