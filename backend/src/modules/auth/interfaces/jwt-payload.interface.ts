import type { UserRole } from '@modules/users/enums/user-role.enum';

/**
 * Contenido firmado del JWT emitido tras validar el OTP corporativo.
 * `sub` es el identificador del usuario (`id_usuario`), siguiendo la convencion RFC 7519.
 */
export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

/**
 * Identidad que `JwtStrategy.validate()` inyecta en `req.user`.
 * Es la unica forma tipada de leer el usuario autenticado en guards y controladores;
 * nunca se accede a `req.user` como `any`.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
}

/** Peticion Express con la identidad ya resuelta por `JwtAuthGuard`. */
export interface RequestWithUser {
  user?: AuthenticatedUser;
}
