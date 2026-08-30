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

/**
 * Par de credenciales entregado al validar el OTP y en cada renovacion.
 *
 * `accessToken` es un JWT corto y autocontenido; `refreshToken` es una cadena
 * opaca de larga duracion cuya validez vive en la tabla `refresh_tokens`.
 */
export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

/** Respuesta de `POST /auth/otp/generate`: nunca incluye el codigo. */
export interface OtpRequestResponse {
  message: string;
  /** Vigencia del codigo, para que el cliente pinte su cuenta regresiva. */
  expiresInSeconds: number;
}
