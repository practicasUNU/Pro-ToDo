import { SetMetadata } from '@nestjs/common';

import { ROLES_KEY } from '@common/constants/security.constants';

import type { CustomDecorator } from '@nestjs/common';
import type { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Declara los roles autorizados a invocar un controlador o ruta (RBAC, PROT-04.2).
 * Requiere que `RolesGuard` este activo junto a `JwtAuthGuard`.
 */
export const Roles = (...roles: UserRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);
