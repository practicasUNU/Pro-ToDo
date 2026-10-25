// Deteccion en tiempo real de destinos HTTP que apuntan a la red interna.
//
// Replica de la guarda SSRF del backend (`core/http/outbound-url.guard.ts`,
// `BLOCKED_RANGES`), que es la autoridad: aqui solo se adelanta el veredicto
// mientras el operador escribe. Solo se juzgan IP LITERALES y `localhost`; un
// nombre que resuelve a una IP privada solo lo puede descubrir el backend, que
// consulta el DNS al guardar y otra vez al conectar.

/** Rango IPv4 como [primera, ultima] direccion en entero sin signo. */
type Ipv4Range = readonly [number, number];

const ipv4ToNumber = (ip: string): number | null => {
  const parts = ip.split('.');

  if (parts.length !== 4) return null;

  let value = 0;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;

    const octet = Number(part);

    if (octet > 255) return null;

    value = value * 256 + octet;
  }

  return value;
};

const cidr = (base: string, bits: number): Ipv4Range => {
  const start = ipv4ToNumber(base) ?? 0;
  const size = 2 ** (32 - bits);

  return [start, start + size - 1];
};

/** Los mismos rangos IPv4 que bloquea el backend. */
const BLOCKED_IPV4_RANGES: readonly Ipv4Range[] = [
  cidr('0.0.0.0', 8),
  cidr('10.0.0.0', 8),
  cidr('100.64.0.0', 10),
  cidr('127.0.0.0', 8),
  cidr('169.254.0.0', 16),
  cidr('172.16.0.0', 12),
  cidr('192.0.0.0', 24),
  cidr('192.168.0.0', 16),
  cidr('198.18.0.0', 15),
  cidr('224.0.0.0', 4),
  cidr('240.0.0.0', 4),
];

const isBlockedIpv4 = (ip: string): boolean => {
  const value = ipv4ToNumber(ip);

  return (
    value !== null && BLOCKED_IPV4_RANGES.some(([start, end]) => value >= start && value <= end)
  );
};

/**
 * IPv6 bloqueada: no especificada, bucle local, ULA (fc00::/7), enlace local
 * (fe80::/10), multicast (ff00::/8) e IPv4 mapeada (`::ffff:a.b.c.d`), que se
 * juzga por su IPv4. `URL` ya entrega el host normalizado y en minusculas.
 */
const isBlockedIpv6 = (ip: string): boolean => {
  if (ip === '::' || ip === '::1') return true;

  const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(ip);

  if (mapped !== null) {
    if (mapped[1] !== undefined) return isBlockedIpv4(mapped[1]);

    const high = parseInt(mapped[2] ?? '0', 16);
    const low = parseInt(mapped[3] ?? '0', 16);

    return isBlockedIpv4(
      [high >> 8, high & 255, low >> 8, low & 255].map((octet) => String(octet)).join('.'),
    );
  }

  const firstGroup = parseInt(ip.split(':')[0] ?? '', 16);

  if (Number.isNaN(firstGroup)) return false;

  return (
    (firstGroup & 0xfe00) === 0xfc00 ||
    (firstGroup & 0xffc0) === 0xfe80 ||
    (firstGroup & 0xff00) === 0xff00
  );
};

/** Marcador de interpolacion, para no juzgar un host que aun no existe. */
const MARKER_PATTERN = /\{\{[^}]*\}\}/;

/**
 * Motivo por el que `rawUrl` apunta a una red privada, local o reservada, o
 * `null` si no se puede afirmar.
 *
 * `new URL()` normaliza las formas raras de escribir una IPv4 (`http://2130706433`,
 * `http://0x7f.1`), que es justo como se intenta colar `127.0.0.1` por un filtro
 * de texto. Un host con marcador no se juzga: su valor llega en ejecucion.
 */
export const detectPrivateTarget = (rawUrl: string | null | undefined): string | null => {
  const text = rawUrl?.trim() ?? '';

  if (text === '') return null;

  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // El marcador puede sobrevivir codificado en el host (`%7B%7B`).
  if (MARKER_PATTERN.test(decodeURIComponent(url.hostname))) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return `"${host}" es la propia maquina: los destinos locales se rechazan por seguridad (SSRF).`;
  }

  if (isBlockedIpv4(host) || (host.includes(':') && isBlockedIpv6(host))) {
    return `"${host}" pertenece a una red privada, local o reservada: el destino se rechazara por seguridad (SSRF).`;
  }

  return null;
};
