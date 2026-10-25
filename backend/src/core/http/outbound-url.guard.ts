import { Injectable } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

import type { AxiosRequestConfig } from 'axios';
import type { LookupAddress, LookupOptions } from 'node:dns';

/** Variante de callback de `AxiosRequestConfig.lookup`. */
type AxiosCallbackLookup = Extract<
  NonNullable<AxiosRequestConfig['lookup']>,
  (hostname: string, options: object, cb: never) => void
>;

/**
 * Proteccion SSRF de las peticiones salientes cuyo destino escribe un usuario.
 *
 * El nodo DESTINO_HTTP_GENERICO es el primero en el que un EDITOR decide la
 * URL. Sin esta guarda, `http://169.254.169.254/` (metadatos del proveedor de
 * nube), `http://localhost:5432` o cualquier servicio de la intranet serian
 * alcanzables desde el backend con su identidad de red.
 *
 * DOS BARRERAS, y hacen falta las dos:
 *
 * 1. `assertPublicHttpUrl` comprueba el protocolo y, si el host es una IP
 *    LITERAL, que no este en un rango bloqueado. Rechaza antes de abrir nada.
 * 2. `blockingLookup` sustituye la resolucion DNS de la conexion y rechaza
 *    las IP que resuelve un NOMBRE. Es la que cierra el DNS rebinding: validar
 *    el nombre por separado y conectar despues dejaria una ventana en la que
 *    el mismo nombre resuelve a 127.0.0.1. Aqui la IP comprobada es la misma
 *    con la que se conecta.
 *
 * Consecuencia aceptada: los hosts de la red corporativa NO son destinos
 * validos de este nodo.
 */

/** Rangos que jamas son destino: privados, bucle local, enlace local, reservados. */
const BLOCKED_RANGES: ReadonlyArray<
  readonly [string, number, 'ipv4' | 'ipv6']
> = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

const BLOCK_LIST = BLOCKED_RANGES.reduce((list, [network, prefix, family]) => {
  list.addSubnet(network, prefix, family);
  return list;
}, new BlockList());

/** Prefijo de una IPv4 escrita como IPv6 (`::ffff:10.0.0.1`). */
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Protocolos admitidos. `file:`, `gopher:` o `ftp:` no son HTTP. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** Fallo de la guarda, con el motivo listo para el operador. */
export class BlockedOutboundTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedOutboundTargetError';
  }
}

/**
 * `true` si la IP pertenece a un rango bloqueado.
 *
 * Una IPv4 mapeada en IPv6 se comprueba como IPv4: `::ffff:127.0.0.1` es el
 * bucle local y no debe colarse por la sintaxis.
 */
export const isBlockedAddress = (address: string): boolean => {
  const mapped = IPV4_MAPPED_PATTERN.exec(address)?.[1];

  if (mapped !== undefined) {
    return BLOCK_LIST.check(mapped, 'ipv4');
  }

  const family = isIP(address);

  if (family === 0) {
    // Lo que no es una IP no se puede afirmar publico: se bloquea.
    return true;
  }

  return BLOCK_LIST.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * Valida protocolo e IP literal de una URL ya interpolada.
 *
 * @throws BlockedOutboundTargetError Si la URL no es http(s), trae
 *         credenciales embebidas o apunta a una IP literal bloqueada.
 */
export const assertPublicHttpUrl = (rawUrl: string): URL => {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedOutboundTargetError(
      `"${rawUrl}" no es una URL absoluta valida.`,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedOutboundTargetError(
      `Protocolo "${url.protocol}" no admitido: solo http y https.`,
    );
  }

  // `https://usuario:clave@host` escondia un secreto en la URL, que acaba en
  // los logs de acceso de cualquier proxy. La autenticacion va por credencial.
  if (url.username !== '' || url.password !== '') {
    throw new BlockedOutboundTargetError(
      'La URL no puede llevar usuario ni contrasena embebidos: usa una credencial de la boveda.',
    );
  }

  // `URL` deja las IPv6 entre corchetes en `hostname`.
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new BlockedOutboundTargetError(
      `El destino ${host} pertenece a una red privada, local o reservada.`,
    );
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new BlockedOutboundTargetError(
      'El destino "localhost" apunta al propio servidor.',
    );
  }

  return url;
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Sustituto de `dns.lookup` que rechaza cualquier IP bloqueada.
 *
 * Se pasa como `lookup` a Axios, que lo entrega al agente HTTP de Node: es la
 * resolucion con la que DE VERDAD se conecta. Resuelve TODAS las direcciones
 * (`all: true`) y rechaza si alguna esta bloqueada, para que un nombre con un
 * registro publico y otro privado no gane por orden de respuesta.
 *
 * @param resolver Inyectable para las pruebas; por defecto, `dns.lookup`.
 */
export const createBlockingLookup =
  (resolver: typeof dnsLookup = dnsLookup) =>
  (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, []);
        return;
      }

      const list = Array.isArray(addresses) ? addresses : [];
      const blocked = list.find(({ address }) => isBlockedAddress(address));

      if (blocked !== undefined || list.length === 0) {
        callback(
          new BlockedOutboundTargetError(
            `"${hostname}" resuelve a ${blocked?.address ?? 'ninguna direccion'}, que pertenece a una red privada, local o reservada.`,
          ),
          [],
        );
        return;
      }

      if (options.all === true) {
        callback(null, list);
        return;
      }

      const [first] = list;
      callback(null, first?.address ?? '', first?.family);
    });
  };

/** Instancia por defecto, con el resolutor del sistema. */
export const blockingLookup = createBlockingLookup();

/**
 * Guarda SSRF inyectable, para que las estrategias no dependan del DNS real.
 *
 * Las pruebas unitarias tienen PROHIBIDO salir a la red (`testing-standards.md`
 * §2), y la comprobacion previa resuelve nombres: con funciones sueltas, cada
 * spec de una estrategia acabaria preguntando al DNS del sistema. Como servicio
 * se sustituye por un doble.
 */
@Injectable()
export class OutboundTargetGuard {
  /**
   * Resolucion con la que se conecta; va a `AxiosRequestConfig.lookup`.
   *
   * Adaptada a la firma de Axios, que espera la familia como `4 | 6` y se
   * encarga el mismo de la opcion `all` que le pasa Node.
   */
  public readonly lookup: AxiosCallbackLookup = (
    hostname,
    _options,
    callback,
  ) => {
    blockingLookup(hostname, { all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, []);
        return;
      }

      callback(
        null,
        (addresses as LookupAddress[]).map(({ address, family }) => ({
          address,
          family: family === 6 ? 6 : 4,
        })),
      );
    });
  };

  /**
   * Comprueba protocolo, IP literal y TODAS las IP a las que resuelve el host.
   *
   * Es la primera barrera: da un error claro antes de abrir la conexion. La
   * segunda (`lookup`) repite la comprobacion en el momento de conectar, que
   * es la que cierra el DNS rebinding.
   *
   * @throws BlockedOutboundTargetError Con el motivo legible.
   */
  public async assertPublicTarget(rawUrl: string): Promise<URL> {
    const url = assertPublicHttpUrl(rawUrl);
    const host = url.hostname.replace(/^\[|\]$/g, '');

    if (isIP(host) !== 0) {
      return url;
    }

    await new Promise<void>((resolve, reject) => {
      blockingLookup(host, { all: true }, (error) => {
        if (error === null) {
          resolve();
          return;
        }

        reject(
          error instanceof BlockedOutboundTargetError
            ? error
            : new BlockedOutboundTargetError(
                `No se pudo resolver "${host}": ${error.message}`,
              ),
        );
      });
    });

    return url;
  }

  /**
   * Motivo por el que un destino GUARDADO apuntaria a la red interna, o `null`.
   *
   * Variante para el validador de esquemas, que no puede usar
   * `assertPublicTarget` tal cual: aquella convierte un fallo de DNS en
   * `BlockedOutboundTargetError`, y al guardar eso impediria persistir un flujo
   * solo porque el DNS no responde en ese momento. Aqui SOLO bloquea lo que
   * resuelve —o es literalmente— a una red privada; lo irresoluble pasa, y la
   * guarda de ejecucion lo vuelve a comprobar al conectar.
   *
   * @param rawUrl URL ya sin marcadores en el host.
   * @param lookup Resolucion bloqueante; parametro para los dobles de prueba.
   */
  public async describeBlockedTarget(
    rawUrl: string,
    lookup: typeof blockingLookup = blockingLookup,
  ): Promise<string | null> {
    let url: URL;

    try {
      url = assertPublicHttpUrl(rawUrl);
    } catch (error) {
      if (error instanceof BlockedOutboundTargetError) {
        return error.message;
      }

      throw error;
    }

    const host = url.hostname.replace(/^\[|\]$/g, '');

    if (isIP(host) !== 0) {
      return null;
    }

    return new Promise<string | null>((resolve) => {
      lookup(host, { all: true }, (error) => {
        resolve(
          error instanceof BlockedOutboundTargetError ? error.message : null,
        );
      });
    });
  }
}
