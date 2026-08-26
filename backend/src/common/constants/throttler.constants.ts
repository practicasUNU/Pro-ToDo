/**
 * Configuracion del limite de tasa aplicado a los endpoints de OTP (PROT-04.1).
 * Los valores por defecto se pueden sobreescribir con `OTP_THROTTLE_TTL_MS` y
 * `OTP_THROTTLE_LIMIT` sin tocar codigo.
 */

/** Nombre del throttler declarado en `ThrottlerModule`, referenciado por `@Throttle`. */
export const OTP_THROTTLER_NAME = 'otp';

/** Ventana de conteo por defecto: 60 segundos. */
export const DEFAULT_OTP_THROTTLE_TTL_MS = 60_000;

/** Peticiones permitidas por ventana y por IP: 3 intentos. */
export const DEFAULT_OTP_THROTTLE_LIMIT = 3;
