import type { UserRole } from '@/types/user';

// Replica exacta de los DTOs expuestos por AuthController (NestJS). Cualquier
// cambio en el backend debe reflejarse aqui: son el contrato entre ambos lados.

/** Identidad que el backend adjunta al abrir sesion (`AuthenticatedUser`). */
export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
}

/** Respuesta de `POST /auth/otp/validate` y de `POST /auth/refresh`. */
export interface AuthTokenResponse {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

/** Respuesta de `POST /auth/otp/generate`. Jamas contiene el codigo. */
export interface OtpRequestResponse {
  message: string;
  expiresInSeconds: number;
}

/**
 * Claims del access token que consume el monitor de expiracion.
 * `exp` e `iat` van en segundos desde epoch (RFC 7519), no en milisegundos.
 */
export interface JwtClaims {
  sub: string;
  email: string;
  role: UserRole;
  exp: number;
  iat: number;
}
