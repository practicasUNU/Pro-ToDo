import type { IncomingHttpHeaders } from 'http';

/** Prefijo que Node antepone a las IPv4 cuando el socket escucha en modo dual IPv6. */
const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * Normaliza una IP: recorta espacios y desnuda el prefijo de IPv4 mapeada en IPv6
 * (`::ffff:192.168.1.10` -> `192.168.1.10`) para que `ip-range-check` pueda compararla
 * contra rangos CIDR IPv4.
 */
const normalizeIp = (rawIp: string): string | null => {
  const trimmed = rawIp.trim();

  if (!trimmed) return null;

  return trimmed.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? trimmed.slice(IPV4_MAPPED_PREFIX.length)
    : trimmed;
};

/**
 * Lo minimo que hace falta para averiguar de donde viene una conexion.
 *
 * Es un tipo ESTRUCTURAL y no `Request` de Express a proposito: el handshake de
 * Socket.io no es una peticion HTTP del router —no tiene `ip`, ni `method`, ni
 * `originalUrl`— pero si tiene cabeceras y direccion remota, que es todo lo que
 * esta funcion mira. `Request` sigue siendo asignable a este tipo, de modo que
 * ningun llamante existente cambia.
 *
 * La alternativa era afirmar `handshake as unknown as Request`, que funciona
 * por casualidad estructural y se rompe en silencio el dia que alguien lea aqui
 * un campo que solo Express tiene.
 */
export interface ClientIpSource {
  readonly headers: IncomingHttpHeaders;
  readonly socket?: { readonly remoteAddress?: string | undefined };
  readonly ip?: string | undefined;
}

/**
 * PROT-05.1: extrae la IP real del cliente considerando proxies inversos.
 *
 * Orden de prioridad estricto:
 *   1. `x-forwarded-for` (primera IP de la cadena: el cliente original).
 *   2. `x-real-ip`.
 *   3. `req.socket.remoteAddress`.
 *   4. `req.ip`.
 *
 * Advertencia de seguridad: las cabeceras son falsificables si el backend se expone
 * directamente. Solo son fiables detras de un proxy inverso de confianza.
 *
 * @returns la IP normalizada, o `null` si no se pudo determinar (el llamador debe
 *          tratar ese caso como fail-closed).
 */
export const extractClientIp = (req: ClientIpSource): string | null => {
  const forwardedFor = req.headers['x-forwarded-for'];
  const forwardedChain = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor;

  if (forwardedChain) {
    const [originClient] = forwardedChain.split(',');
    const normalized = originClient ? normalizeIp(originClient) : null;
    if (normalized) return normalized;
  }

  const realIp = req.headers['x-real-ip'];
  const realIpValue = Array.isArray(realIp) ? realIp[0] : realIp;

  if (realIpValue) {
    const normalized = normalizeIp(realIpValue);
    if (normalized) return normalized;
  }

  const socketAddress = req.socket?.remoteAddress;

  if (socketAddress) {
    const normalized = normalizeIp(socketAddress);
    if (normalized) return normalized;
  }

  return req.ip ? normalizeIp(req.ip) : null;
};
