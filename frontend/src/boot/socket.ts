import { defineBoot } from '#q-app';
import { watch } from 'vue';

import {
  authenticateSocket,
  connectSocket,
  disconnectSocket,
  getSocket,
} from '@services/socket.client';
import { useSessionStore } from '@stores/session.store';

/** Ruta del login: destino del rechazo por credencial invalida. */
const LOGIN_ROUTE = '/login';

/**
 * Motivo con el que el gateway rechaza un handshake cuyo token no sirve.
 *
 * Copia literal de `backend/src/modules/notifications/notification.constants.ts`.
 * Viaja como `Error.message` del `connect_error`.
 */
const WS_INVALID_TOKEN = 'WS_INVALID_TOKEN';

/**
 * Ciclo de vida del canal WebSocket de ejecuciones.
 *
 * Aqui y no en un componente porque la conexion debe sobrevivir a la navegacion
 * entre vistas: montarla en una pagina la cerraria al salir de ella, y los
 * eventos de un flujo siguen llegando mientras el operador mira otra cosa.
 *
 * A diferencia de `boot/axios.ts`, este SI importa el store en el nivel de
 * modulo y puede hacerlo sin cerrar ciclo: `socket.client.ts` lee el token de
 * `session-storage`, no del store, asi que la cadena
 * `boot -> store -> service -> boot` nunca llega a formarse.
 */
export default defineBoot(({ router, store }) => {
  const sessionStore = useSessionStore(store);

  // Una recarga de pagina con sesion viva debe reconectar sola: el store se
  // rehidrata de `localStorage` al crearse, asi que aqui ya hay token si lo hay.
  if (sessionStore.accessToken) {
    connectSocket();
  }

  // El token viaja en el handshake, que solo se envia al abrir la conexion. Sin
  // esto, una renovacion del monitor de sesion dejaria al socket presentando una
  // credencial caducada hasta que el servidor lo echase.
  watch(
    () => sessionStore.accessToken,
    (accessToken) => {
      authenticateSocket(accessToken);
    },
  );

  getSocket().on('connect_error', (error: Error) => {
    // SOLO la credencial cierra la sesion. `connect_error` tambien se dispara
    // cuando el backend esta caido o la red se cae, y purgar la sesion ahi
    // expulsaria al usuario cada vez que se reinicia Nest. El resto de motivos
    // se dejan al reconector automatico de Socket.io, que reintenta solo.
    if (error.message !== WS_INVALID_TOKEN) {
      return;
    }

    disconnectSocket();
    sessionStore.clear();

    if (router.currentRoute.value.path !== LOGIN_ROUTE) {
      void router.replace(LOGIN_ROUTE);
    }
  });
});
