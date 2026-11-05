import type { IncomingHttpHeaders } from 'http';

/** Prefijo que Node antepone a las IPv4 cuando el socket escucha en modo dual IPv6. */
const IPV4_MAPPED_PREFIX = '::ffff:';

/** Loopback IPv6 en su forma abreviada, la unica que entrega Node. */
const IPV6_LOOPBACK = '::1';

/** Loopback IPv4, al que se traducen todas las formas del bucle local. */
const IPV4_LOOPBACK = '127.0.0.1';

/**
 * Normaliza una IP a su forma IPv4 comparable.
 *
 * Hace dos cosas, y las dos existen para que `ip-range-check` —que razona en
 * CIDR IPv4— no reciba direcciones que describen el mismo origen con otra
 * sintaxis y acabe negando el acceso a quien si deberia tenerlo:
 *
 *   1. Desnuda el prefijo de IPv4 mapeada en IPv6:
 *      `::ffff:192.168.1.10` -> `192.168.1.10`.
 *   2. Traduce el loopback IPv6 `::1` a `127.0.0.1`.
 *
 * El segundo caso es el que rompia en la practica. Una peticion desde la propia
 * maquina llega como `::1` en cuanto Node escucha en modo dual, y ese literal no
 * pertenece a ningun rango IPv4: `RedLocalMiddleware` lo rechazaba con un 403
 * mientras la MISMA peticion por `127.0.0.1` pasaba sin problema. Las dos formas
 * nombran al mismo host, asi que el control de acceso tiene que verlas igual.
 */
const normalizeIp = (rawIp: string): string | null => {
  const trimmed = rawIp.trim();

  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();

  if (lowered === IPV6_LOOPBACK) {
    return IPV4_LOOPBACK;
  }

  return lowered.startsWith(IPV4_MAPPED_PREFIX)
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
