import { ImapFlow } from 'imapflow';

import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';

/**
 * Espera maxima para establecer la conexion TCP/TLS con el servidor IMAP.
 *
 * Sesenta segundos y no quince: los buzones corporativos grandes tardan en
 * aceptar el handshake cuando el servidor esta bajo carga, y el corte prematuro
 * se presentaba como `ERR_IMAP_TIMEOUT` —un fallo del nodo— cuando lo unico que
 * pasaba es que no se habia esperado lo suficiente. Un timeout generoso aqui no
 * cuelga el pipeline: la inactividad POSTERIOR la acota `socketTimeout`.
 */
export const CONNECTION_TIMEOUT_MS = 60_000;

/**
 * Espera maxima del saludo inicial del servidor tras conectar.
 *
 * La mitad que la conexion: el saludo es la primera linea que el servidor
 * escribe una vez ya hay socket, de modo que tardar mas de treinta segundos en
 * emitirla describe un servidor que no va a responder, no uno ocupado.
 */
export const GREETING_TIMEOUT_MS = 30_000;

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
 * Temporizadores de un cliente IMAP, en milisegundos.
 *
 * Todos opcionales: quien solo necesita otra inactividad de socket pasa
 * `socketTimeoutMs`, y quien necesita acotar tambien la conexion —el worker de
 * reanudacion, que prefiere rendirse antes y reintentar en el ciclo
 * siguiente— pasa los tres.
 */
export interface ImapClientTimeouts {
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

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
 * @param timeouts Inactividad maxima del socket en ms (por defecto la de una
 *        comprobacion), u objeto con los tres temporizadores. Los que no se
 *        indiquen conservan los valores del proyecto.
 */
export const createImapClient = (
  config: ResolvedImapConfig,
  password: string,
  onSocketError: (error: Error) => void,
  timeouts: number | ImapClientTimeouts = PROBE_SOCKET_TIMEOUT_MS,
): ImapFlow => {
  const {
    connectionTimeoutMs = CONNECTION_TIMEOUT_MS,
    greetingTimeoutMs = GREETING_TIMEOUT_MS,
    socketTimeoutMs = PROBE_SOCKET_TIMEOUT_MS,
  }: ImapClientTimeouts = typeof timeouts === 'number'
    ? { socketTimeoutMs: timeouts }
    : timeouts;

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: password },
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: connectionTimeoutMs,
    greetingTimeout: greetingTimeoutMs,
    socketTimeout: socketTimeoutMs,
  });

  client.on('error', onSocketError);

  return client;
};

/**
 * Cierra la sesion IMAP sin dejar rastro, pase lo que pase.
 *
 * Reemplaza a las tres copias de `logoutQuietly` que tenian la estrategia, el
 * sondeo y el canal de ordenes. Las tres hacian lo mismo y las tres estaban
 * MAL del mismo modo: `await client.logout()` dentro de un `try` y rendirse en
 * el `catch`. Sobre un socket ya roto —una VPN que se cae a mitad del ciclo—
 * `logout()` lanza `Connection not available`, de modo que el cierre nunca
 * llegaba a ocurrir y el socket TCP con sus oyentes sobrevivia al ciclo. Un
 * sondeo cada minuto convertia eso en una fuga: clientes huerfanos
 * acumulandose hasta que el proceso agotaba descriptores.
 *
 * Dos pasos, y el orden importa:
 *
 * 1. `logout()` SOLO si `client.usable`. Es el cierre LIMPIO —despide la sesion
 *    y libera el slot en el servidor de correo—, pero exige un socket vivo.
 *    Preguntar antes evita provocar justo la excepcion que tapaba el paso 2.
 * 2. `close()` SIEMPRE, y fuera de todo condicional. Es la destruccion
 *    imperativa del socket y de sus oyentes. Es lo unico que corre en el caso
 *    que motiva esta funcion, asi que no puede depender de que el paso
 *    anterior haya salido bien.
 *
 * Nunca relanza: la invocan `finally` de bloques que ya estan gestionando otro
 * error, y dejar escapar un fallo de cierre taparia la causa real. Quien
 * quiera enterarse pasa `onCloseError`.
 *
 * @param client Cliente a cerrar, utilizable o no.
 * @param onCloseError Observador opcional del fallo de cierre. Recibe tanto el
 *        de `logout()` como el de `close()`.
 */
export const closeImapClientQuietly = async (
  client: ImapFlow,
  onCloseError?: (error: unknown) => void,
): Promise<void> => {
  try {
    if (client.usable) {
      await client.logout();
    }
  } catch (error: unknown) {
    onCloseError?.(error);
  }

  try {
    client.close();
  } catch (error: unknown) {
    onCloseError?.(error);
  }
};
