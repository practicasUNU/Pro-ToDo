/**
 * Helpers puros compartidos por los destinos HTTP con plantilla JSON
 * (DESTINO_HTTP_GENERICO y DESTINO_ACENS). Viven junto a la clase base porque
 * son transporte, no dialecto de ninguna API concreta.
 */

/**
 * Techo del cuerpo de respuesta que se publica en el namespace.
 *
 * El namespace acaba en `contexto_acumulado` (jsonb) en CADA checkpoint, y una
 * API que devuelva un listado entero multiplicaria la fila por cada paso. Se
 * conserva el principio, marcado, que es donde las APIs ponen el resultado.
 */
export const MAX_RESPONSE_BODY_CHARS = 64_000;

/** Sustituye cada cadena de un valor JSON aplicando `interpolate`. */
export const mapJsonStrings = (
  value: unknown,
  interpolate: (template: string) => string,
): unknown => {
  if (typeof value === 'string') {
    return interpolate(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => mapJsonStrings(item, interpolate));
  }

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapJsonStrings(item, interpolate),
      ]),
    );
  }

  return value;
};

/** Cuerpo de respuesta acotado a `MAX_RESPONSE_BODY_CHARS`. */
export const boundResponseBody = (body: unknown): unknown => {
  if (body === undefined || body === '') {
    return null;
  }

  const serialized = typeof body === 'string' ? body : JSON.stringify(body);

  if (serialized.length <= MAX_RESPONSE_BODY_CHARS) {
    return body;
  }

  return `${serialized.slice(0, MAX_RESPONSE_BODY_CHARS)}… [recortado: ${serialized.length} caracteres]`;
};
