/**
 * Codigos de `errno` que describen un enlace caido, no un servidor averiado.
 *
 * Todos son recuperables SIN intervencion: en cuanto la ruta vuelve, la
 * siguiente conexion funciona. Esa es exactamente la propiedad que separa un
 * microcorte —apagar la VPN, saltar de WiFi a cable— de un fallo que un
 * operador tiene que atender, como unas credenciales caducadas o un buzon
 * inexistente.
 */
const TRANSIENT_ERROR_CODES: readonly string[] = [
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  // Codigos propios de `imapflow` (v1.7): sus temporizadores de conexion,
  // saludo, STARTTLS e inactividad no conservan el `errno` del socket, sino que
  // fabrican un error con uno de estos `code`. Sin ellos, el
  // "Failed to establish connection in required time" de un microcorte se
  // clasificaba como averia del buzon y escalaba a `logger.error` en cada ciclo.
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'ETIMEOUT',
];

/**
 * Fragmentos de mensaje que delatan un enlace caido cuando NO hay `code`.
 *
 * `imapflow` envuelve la caida del socket en errores propios que pierden el
 * `errno` original, asi que sin esta segunda via un corte de VPN se clasifica
 * como averia del buzon. Se comparan en minusculas.
 */
const TRANSIENT_MESSAGE_FRAGMENTS: readonly string[] = [
  'connection not available',
  'connection closed',
  'socket timeout',
  'socket closed',
  'network is unreachable',
  // Mensaje del `CONNECT_TIMEOUT` de `imapflow` cuando llega reenvuelto sin
  // `code` por una capa intermedia.
  'failed to establish connection',
];

/** Profundidad maxima al desenvolver `cause` / `AggregateError.errors`. */
const MAX_UNWRAP_DEPTH = 4;

const hasTransientCode = (error: object): boolean => {
  const { code } = error as { code?: unknown };

  return typeof code === 'string' && TRANSIENT_ERROR_CODES.includes(code);
};

const hasTransientMessage = (error: Error): boolean => {
  const message = error.message.toLowerCase();

  return TRANSIENT_MESSAGE_FRAGMENTS.some((fragment) =>
    message.includes(fragment),
  );
};

/**
 * Decide si un fallo describe un corte de red transitorio.
 *
 * Existe porque los dos servicios que escuchan buzones —`ImapPollingService` e
 * `InboundEmailResumeService`— tienen que distinguir "el enlace se cayo" de "el
 * buzon esta averiado", y la consecuencia es opuesta: lo primero se registra
 * como aviso y se reintenta en el ciclo siguiente, lo segundo escala a
 * `alertas_error` para que alguien lo mire. Sin esta separacion, apagar la VPN
 * llenaba la bandeja del operador de incidencias GRAVE que se resolvian solas.
 *
 * SE DESENVUELVE EL ERROR, y no es un detalle: Node entrega el fallo de una
 * resolucion con varias direcciones como un `AggregateError` cuyo `code` es
 * `undefined` y cuyos `ETIMEDOUT` reales viven en `.errors`. Mirar solo el
 * nivel superior los daba todos por averia del buzon. Se recorre tambien
 * `cause`, por donde los suben las librerias que reenvuelven.
 *
 * La profundidad esta acotada (`MAX_UNWRAP_DEPTH`) para que una cadena de
 * `cause` circular no cuelgue el `catch` de un `setInterval`.
 *
 * Funcion pura, sin estado ni E/S (`code-conventions.md` §2.1).
 */
export const isTransientNetworkError = (error: unknown, depth = 0): boolean => {
  if (depth > MAX_UNWRAP_DEPTH || typeof error !== 'object' || error === null) {
    return false;
  }

  if (hasTransientCode(error)) {
    return true;
  }

  if (error instanceof Error && hasTransientMessage(error)) {
    return true;
  }

  if (error instanceof AggregateError) {
    const nested: unknown[] = Array.isArray(error.errors) ? error.errors : [];

    if (nested.some((inner) => isTransientNetworkError(inner, depth + 1))) {
      return true;
    }
  }

  const { cause } = error as { cause?: unknown };

  return cause !== undefined && isTransientNetworkError(cause, depth + 1);
};
