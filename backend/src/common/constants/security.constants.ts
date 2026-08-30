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

/** Variable de entorno con los rangos CIDR corporativos / VPN separados por comas. */
export const ALLOWED_IP_RANGES_ENV = 'ALLOWED_IP_RANGES';
