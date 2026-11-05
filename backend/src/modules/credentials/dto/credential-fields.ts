/** Longitud maxima del nombre visible de una credencial (columna `nombre`). */
export const MAX_CREDENTIAL_NAME_LENGTH = 100;

/**
 * Techo de un valor secreto. Un JWT largo ronda los 2 KB; 4 KB deja holgura
 * sin permitir que la boveda se use como almacen de ficheros.
 */
export const MAX_SECRET_LENGTH = 4096;

/**
 * Nombre de la cabecera o del parametro que transporta una API key.
 *
 * Es el `token` de RFC 9110 restringido a lo que de verdad usan las APIs
 * (`X-Api-Key`, `api_key`): sin espacios, dos puntos ni saltos de linea, que
 * son justo los caracteres con los que se inyecta una cabecera extra.
 */
export const API_KEY_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
