/**
 * Claves de metadata y mensajes compartidos por la capa de seguridad perimetral (PROT-05)
 * y el control de acceso basado en roles (PROT-04.2).
 */

/** Marca una ruta o controlador como exento de la validacion de subred corporativa. */
export const IS_PUBLIC_IP_KEY = 'isPublicIp';

/** Almacena los roles autorizados a invocar una ruta o controlador. */
export const ROLES_KEY = 'roles';

/** Mensaje unico de rechazo perimetral: no revela los rangos configurados. */
export const ACCESS_DENIED_MESSAGE =
  'Acceso denegado: IP fuera de la red corporativa autorizada.';

/**
 * Variable de entorno con los rangos CIDR corporativos / VPN separados por comas.
 * Desde la persistencia dinamica de IPs (`AllowedIpsService`), solo se consulta como
 * fallback de arranque cuando la tabla `allowed_ips` esta vacia (semillado seguro).
 */
export const ALLOWED_IP_RANGES_ENV = 'ALLOWED_IP_RANGES';

/** Vigencia de la cache en memoria de rangos autorizados antes de releer la tabla. */
export const ALLOWED_IPS_CACHE_TTL_MS = 60_000;

/**
 * Rangos que siempre se consideran autorizados cuando `allowed_ips` esta vacia:
 * evita que un `TRUNCATE` accidental o una base recien provisionada bloqueen
 * incluso al acceso local (127.0.0.1 / ::1).
 */
export const DEFAULT_LOCALHOST_RANGES = ['127.0.0.1/32', '::1/128'];

const IPV4_SEGMENT = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_ADDRESS = `${IPV4_SEGMENT}(\\.${IPV4_SEGMENT}){3}`;
const IPV4_CIDR_SUFFIX = '(3[0-2]|[12]?[0-9])';

const IPV6_SEGMENT = '[0-9a-fA-F]{1,4}';
const IPV6_ADDRESS = [
  `(${IPV6_SEGMENT}:){7}${IPV6_SEGMENT}`,
  `(${IPV6_SEGMENT}:){1,7}:`,
  `(${IPV6_SEGMENT}:){1,6}:${IPV6_SEGMENT}`,
  `(${IPV6_SEGMENT}:){1,5}(:${IPV6_SEGMENT}){1,2}`,
  `(${IPV6_SEGMENT}:){1,4}(:${IPV6_SEGMENT}){1,3}`,
  `(${IPV6_SEGMENT}:){1,3}(:${IPV6_SEGMENT}){1,4}`,
  `(${IPV6_SEGMENT}:){1,2}(:${IPV6_SEGMENT}){1,5}`,
  `${IPV6_SEGMENT}:((:${IPV6_SEGMENT}){1,6})`,
  `:((:${IPV6_SEGMENT}){1,7}|:)`,
].join('|');
const IPV6_CIDR_SUFFIX = '(12[0-8]|1[01][0-9]|[1-9]?[0-9])';

/**
 * Formato de `ipOrCidr` aceptado por `CreateAllowedIpDto`: una IPv4/IPv6 exacta o
 * con sufijo de notacion CIDR (`/n`). No valida semantica de rango (ej. host bits
 * distintos de cero en la mascara), solo forma sintactica.
 */
export const IP_OR_CIDR_REGEX = new RegExp(
  `^((${IPV4_ADDRESS})(/${IPV4_CIDR_SUFFIX})?|(${IPV6_ADDRESS})(/${IPV6_CIDR_SUFFIX})?)$`,
);
