import type { JwtClaims } from '@/types/auth';

// Helper puro (frontend-architecture.md §2.1): decodifica, no verifica.
//
// La FIRMA no se comprueba aqui y no debe comprobarse: el navegador no tiene el
// secreto y cualquier validacion en cliente seria teatro. La autoridad sobre el
// token es el backend; esto solo sirve para saber CUANDO caduca y poder avisar
// al usuario antes de que ocurra.

/** Un JWT tiene exactamente tres segmentos: cabecera, payload y firma. */
const JWT_SEGMENTS = 3;

/**
 * Convierte base64url (alfabeto del JWT) a base64 estandar, que es lo unico que
 * entiende `atob`: sustituye `-`/`_` y restituye el relleno `=`.
 */
const base64UrlToBase64 = (segment: string): string => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const paddingLength = (4 - (base64.length % 4)) % 4;

  return base64 + '='.repeat(paddingLength);
};

/**
 * Extrae los claims del payload de un JWT.
 *
 * @returns Los claims, o `null` ante cualquier anomalia (token vacio, numero de
 *          segmentos incorrecto, base64 invalido, JSON corrupto o `exp` ausente).
 *          Nunca lanza: quien la usa decide que hacer con un token ilegible.
 */
export const decodeJwtClaims = (token: string | null): JwtClaims | null => {
  if (!token) return null;

  const segments = token.split('.');
  if (segments.length !== JWT_SEGMENTS) return null;

  const payloadSegment = segments[1];
  if (!payloadSegment) return null;

  try {
    const claims = JSON.parse(atob(base64UrlToBase64(payloadSegment))) as Partial<JwtClaims>;

    // Sin `exp` numerico el token es inservible para el monitor de expiracion.
    if (typeof claims.exp !== 'number') return null;

    return claims as JwtClaims;
  } catch {
    return null;
  }
};

/**
 * Milisegundos que faltan para que el token caduque.
 * Negativo si ya caduco, `null` si no se pudo leer el `exp`.
 */
export const getMillisecondsUntilExpiry = (token: string | null): number | null => {
  const claims = decodeJwtClaims(token);
  if (!claims) return null;

  // `exp` viaja en segundos desde epoch; Date.now() en milisegundos.
  return claims.exp * 1000 - Date.now();
};
