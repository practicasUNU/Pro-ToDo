import { io } from 'socket.io-client';

import { readAccessToken } from '@/utils/session-storage';

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@/types/execution';
import type { Socket } from 'socket.io-client';

/**
 * Cliente de Socket.io del canal de ejecuciones.
 *
 * Modulo HOJA a proposito: no importa Pinia ni `#q-app`. Quien necesite el
 * token lo lee de `session-storage`, igual que hace `boot/axios.ts`, y por el
 * mismo motivo — importar el store aqui cerraria el ciclo
 * `boot -> store -> service -> boot` que documenta `session-storage.ts`.
 */

/** Namespace del gateway. Debe coincidir con `@WebSocketGateway({ namespace })`. */
const SOCKET_NAMESPACE = '/events';

/**
 * Ruta del endpoint de Socket.io en el backend.
 *
 * Lleva el `/api` porque `setGlobalPrefix('api')` de Nest NO alcanza al
 * adaptador de sockets, asi que el gateway lo declara a mano en su decorador.
 * Si los dos valores dejan de coincidir, el handshake responde 404 y el
 * sintoma —"no conecta"— no apunta a su causa.
 */
const SOCKET_PATH = '/api/socket.io';

export type ExecutionSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: ExecutionSocket | null = null;

/**
 * Origen del servidor de sockets.
 *
 * `VITE_API_BASE_URL` vale `http://localhost:3000/api`, es decir YA trae el
 * prefijo. Concatenar daria `http://localhost:3000/api/events`, un namespace
 * que no existe, asi que se extrae el origen limpio con `URL`. `VITE_SOCKET_URL`
 * permite apuntar a otro host cuando el socket no comparte origen con la API.
 */
const resolveSocketOrigin = (): string => {
  const explicit = import.meta.env.VITE_SOCKET_URL;

  if (explicit) {
    return explicit;
  }

  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;

  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    // Una base relativa (despliegue tras proxy inverso) no es una URL absoluta:
    // ahi el origen del documento es exactamente el que toca.
    return window.location.origin;
  }
};

/**
 * Devuelve el socket, creandolo la primera vez.
 *
 * `autoConnect: false` porque la conexion la decide `boot/socket.ts` segun haya
 * sesion o no: conectar al importar el modulo lanzaria un handshake sin token
 * en la pantalla de login, que el backend rechaza y el reconector reintenta en
 * bucle.
 *
 * Sin fijar `transports`: dejar el sondeo HTTP como primer salto es lo que
 * permite conectar a traves de proxies corporativos que no negocian WebSocket,
 * y Socket.io asciende solo en cuanto puede.
 */
export const getSocket = (): ExecutionSocket => {
  socket ??= io(`${resolveSocketOrigin()}${SOCKET_NAMESPACE}`, {
    path: SOCKET_PATH,
    autoConnect: false,
    withCredentials: true,
    auth: { token: readAccessToken() },
  });

  return socket;
};

/** Abre la conexion si no estaba ya abierta. Idempotente. */
export const connectSocket = (): void => {
  const active = getSocket();

  if (!active.connected) {
    active.connect();
  }
};

/** Cierra la conexion. Idempotente; el socket se reutiliza despues. */
export const disconnectSocket = (): void => {
  socket?.disconnect();
};

/**
 * Cambia la credencial y reconecta.
 *
 * La reconexion no es opcional: el token viaja en el HANDSHAKE, que solo se
 * envia al abrir. Reescribir `auth` sobre un socket ya conectado no renueva
 * nada — el servidor sigue viendo la credencial con la que se autentico, y
 * cuando esta caduque la conexion morira sin que nadie entienda por que.
 *
 * Con `token` nulo —cierre de sesion— se desconecta sin volver a abrir.
 */
export const authenticateSocket = (token: string | null): void => {
  const active = getSocket();

  active.auth = { token };

  if (active.connected) {
    active.disconnect();
  }

  if (token) {
    active.connect();
  }
};
