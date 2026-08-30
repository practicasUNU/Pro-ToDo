import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Exige un `Authorization: Bearer <token>` valido y publica la identidad
 * verificada en `req.user`. Se combina siempre con `RolesGuard`, que aplica el RBAC.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
