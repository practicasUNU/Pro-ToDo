import { onBeforeUnmount, onMounted } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';

import { subscribeToSessionEvents } from '@services/socket-events.service';
import { useSessionStore } from '@stores/session.store';

import ForcedLogoutDialog from '@components/session/ForcedLogoutDialog.vue';

import type { DialogChainObject } from 'quasar';
import type { UserModifiedPayload } from '@/types/session-events';

const LOGIN_ROUTE = '/login';

/**
 * Expulsa al usuario cuando un administrador cambia su cuenta.
 *
 * ## Que resuelve
 *
 * Un cambio de rol, una desactivacion o un cambio de correo dejan al cliente
 * mostrando una interfaz que ya no le corresponde: menus de ADMIN para quien
 * acaba de pasar a EDITOR, o el panel entero para una cuenta desactivada. El
 * backend ya rechaza sus peticiones —incremento `usuarios.token_version` y
 * `JwtStrategy` las responde con un 401—, pero sin este aviso el usuario solo
 * veria errores inexplicables al pulsar cualquier cosa.
 *
 * ## Que NO es
 *
 * NO es la medida de seguridad. La sesion ya esta muerta en el servidor cuando
 * este evento llega; el modal solo explica por que y limpia el almacenamiento
 * local. Un cliente desconectado no se entera y da igual: su siguiente
 * peticion recibe un 401 de todas formas.
 *
 * ## Donde se engancha
 *
 * En `MainLayout`, junto a los otros composables de socket: envuelve todas las
 * rutas autenticadas y se desmonta al salir a `/login`, que es exactamente la
 * ventana en la que el aviso tiene sentido.
 */
export const useForcedLogout = (): void => {
  const $q = useQuasar();
  const router = useRouter();
  const sessionStore = useSessionStore();

  let unsubscribe: (() => void) | null = null;
  let dialogHandle: DialogChainObject | undefined;

  /**
   * Cierra la sesion y manda al login.
   *
   * Replica la secuencia de `useSessionMonitor.terminateSession`, incluida la
   * guarda de la ruta: `router.replace` sobre la ruta actual rechaza la
   * promesa con una navegacion redundante.
   */
  const terminate = async (): Promise<void> => {
    await sessionStore.logout();

    if (router.currentRoute.value.path !== LOGIN_ROUTE) {
      await router.replace(LOGIN_ROUTE);
    }
  };

  const onUserModified = (payload: UserModifiedPayload): void => {
    // El gateway manda el evento SOLO a la sala de esa persona, pero se vuelve
    // a comprobar aqui: el socket sobrevive a un cambio de sesion dentro de la
    // misma pestana, y apoyar una expulsion en una suposicion del transporte
    // seria confiar la seguridad al reparto.
    if (payload.userId !== sessionStore.user?.id) {
      return;
    }

    // Un segundo aviso no abre un segundo modal: dos cuentas atras encimadas
    // llamarian dos veces a `terminate`, y la segunda navegaria sobre `/login`.
    if (dialogHandle !== undefined) {
      return;
    }

    dialogHandle = $q
      .dialog({
        component: ForcedLogoutDialog,
        componentProps: {
          actorEmail: payload.actorEmail,
          updatedFields: payload.updatedFields,
        },
      })
      .onOk(() => {
        void terminate();
      })
      .onDismiss(() => {
        dialogHandle = undefined;
      });
  };

  onMounted(() => {
    unsubscribe = subscribeToSessionEvents(onUserModified);
  });

  // Sin esta baja, cada montaje apilaria un juego mas de escuchas y un solo
  // evento abriria tantos modales como veces se hubiera montado el layout.
  onBeforeUnmount(() => {
    unsubscribe?.();
    unsubscribe = null;

    // El plugin de dialogo monta fuera del arbol del layout: sin este cierre
    // explicito, el modal quedaria flotando sobre la vista de login.
    dialogHandle?.hide();
    dialogHandle = undefined;
  });
};
