import { UserRole } from '@modules/users/enums/user-role.enum';

import type { JwtPayload } from '@modules/auth/interfaces/jwt-payload.interface';
import type { JwtService } from '@nestjs/jwt';

/** Identidad por defecto del token de pruebas, sin correspondencia en `usuarios`. */
const DEFAULT_DEV_USER_ID = '00000000-0000-0000-0000-000000000001';
const DEFAULT_DEV_EMAIL = 'dev.test@unuware.com';

/** Datos de la identidad a firmar; todo lo omitido cae a los valores de arriba. */
export interface DevTokenOptions {
  userId?: string;
  email?: string;
  role?: UserRole;
  /**
   * Generacion del token (`usuarios.token_version`). Omitida, el claim no
   * viaja y `JwtStrategy` lo trata como 0, igual que un token anterior a la 051.
   */
  tokenVersion?: number;
}

/**
 * Firma un JWT de pruebas con la misma clave y vigencia que la API real.
 *
 * Sirve para saltarse el flujo OTP en pruebas manuales contra endpoints
 * protegidos: `curl -H "Authorization: Bearer <token>"`. NO lo consume ningun
 * script que invoque estrategias en proceso, porque ahi no hay peticion HTTP y
 * los guards —`IpWhitelistGuard`, `JwtAuthGuard`, `RolesGuard`— son `CanActivate`
 * del router y no llegan a ejecutarse.
 *
 * ## Por que recibe el `JwtService` en vez de firmar por su cuenta
 *
 * Porque asi el secreto y el `expiresIn` salen del `JwtModule.registerAsync` de
 * `AuthModule`, que es la unica configuracion real. Leer `process.env.JWT_SECRET`
 * aqui obligaria a repetir tambien el defecto de vigencia (`'8h'`), y un segundo
 * sitio donde vive el mismo valor es un sitio donde puede divergir: el token
 * saldria firmado con una caducidad que la API no usa.
 *
 * El llamador lo obtiene con `app.get(JwtService)` sobre un contexto de Nest, o
 * construyendo uno a mano si no quiere levantar el contenedor.
 *
 * ## Por que `role` es el enum y no un union de cadenas
 *
 * `JwtStrategy.validate` rechaza con 401 cualquier rol que no este en
 * `Object.values(UserRole)`. Tipar aqui con un union suelto permitiria fabricar
 * un token sintacticamente valido que el guard tira, y el fallo aparecerian en
 * la peticion y no al compilar.
 *
 * ADVERTENCIA: desde la migracion 051, `JwtStrategy.validate` SI consulta
 * `usuarios`: el `userId` tiene que ser una cuenta REAL y activa, y la
 * generacion del token tiene que casar con su `token_version`. Un id inventado
 * recibe un 401. Aun asi, con un id real esta funcion concede acceso real a la
 * API sin pasar por el OTP. Solo para desarrollo local y pruebas.
 *
 * @returns el JWT ya firmado, listo para la cabecera `Authorization`.
 */
export const generateDevJwt = (
  jwtService: JwtService,
  options: DevTokenOptions = {},
): string => {
  // Replica del payload de `AuthService.buildTokenResponse`: los tres campos
  // de identidad y, si se pide, la generacion. `iat` y `exp` los pone la libreria al firmar.
  const payload: JwtPayload = {
    sub: options.userId ?? DEFAULT_DEV_USER_ID,
    email: options.email ?? DEFAULT_DEV_EMAIL,
    role: options.role ?? UserRole.ADMIN,
    ...(options.tokenVersion !== undefined
      ? { tokenVersion: options.tokenVersion }
      : {}),
  };

  return jwtService.sign(payload);
};
