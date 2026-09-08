import { ImapFlow } from 'imapflow';

import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';

/** Espera maxima para establecer la conexion TCP/TLS con el servidor IMAP. */
export const CONNECTION_TIMEOUT_MS = 15_000;

/** Espera maxima del saludo inicial del servidor tras conectar. */
export const GREETING_TIMEOUT_MS = 15_000;

/**
 * Inactividad maxima del socket en una comprobacion corta (sondeo o wizard).
 *
 * Basta para un `STATUS`, que devuelve unos pocos contadores.
 */
export const PROBE_SOCKET_TIMEOUT_MS = 15_000;

/**
 * Inactividad maxima del socket durante la descarga de un mensaje.
 *
 * Mas holgado que el del sondeo porque aqui viaja un MIME completo. Sin este
 * tope, un servidor que acepta la conexion y deja de responder a mitad de un
 * `FETCH` colgaria el paso del pipeline indefinidamente: el motor no impone
 * ningun timeout propio sobre `strategy.execute()`.
 */
export const DOWNLOAD_SOCKET_TIMEOUT_MS = 60_000;

/**
 * Construye un cliente IMAP con las opciones endurecidas del proyecto.
 *
 * Existe para que las tres rutas que hablan IMAP —la estrategia del nodo, el
 * sondeo periodico y la comprobacion del asistente— NO puedan divergir en las
 * decisiones que son de seguridad y no de gusto:
 *
 * - `logger: false` y `emitLogs: false`: sin esto, `imapflow` vuelca la
 *   conversacion IMAP completa —incluidas las cabeceras de autenticacion— al
 *   stdout del contenedor, saltandose el `Logger` de Nest.
 * - `disableAutoIdle: true`: todas las operaciones del proyecto son cortas y
 *   cierran; mantener IDLE abierto solo dejaria sockets ociosos contra el
 *   servidor de correo.
 * - Timeouts explicitos: sin ellos, un servidor que acepta la conexion y calla
 *   deja la operacion colgada sin limite.
 *
 * El oyente de `error` es un PARAMETRO OBLIGATORIO y no opcional a proposito:
 * `ImapFlow` es un `EventEmitter`, y un evento `error` sin oyente es una
 * excepcion no capturada que derriba el proceso de Node entero. Exigirlo en la
 * firma convierte ese olvido en un error de compilacion.
 *
 * @param config Configuracion del nodo con los defaults ya aplicados.
 * @param password Secreto ya resuelto desde el entorno. Nunca se registra.
 * @param onSocketError Oyente del evento `error` del cliente.
 * @param socketTimeoutMs Inactividad maxima; por defecto la de una comprobacion.
 */
export const createImapClient = (
  config: ResolvedImapConfig,
  password: string,
  onSocketError: (error: Error) => void,
  socketTimeoutMs: number = PROBE_SOCKET_TIMEOUT_MS,
): ImapFlow => {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: socketTimeoutMs,
  });

  client.on('error', onSocketError);

  return client;
};
