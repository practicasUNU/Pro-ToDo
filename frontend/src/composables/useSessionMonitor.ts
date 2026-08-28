import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';

import SessionExpiryDialog from '@components/session/SessionExpiryDialog.vue';
import { useSessionStore } from '@stores/session.store';

import type { DialogChainObject } from 'quasar';

// Monitor proactivo de expiracion del JWT (PROT-06.4).
//
// Es un composable y no un componente porque no pinta nada: solo programa
// temporizadores y lanza un dialogo. Se invoca desde MainLayout.vue, que envuelve
// todas las rutas autenticadas, asi que su ciclo de vida coincide exactamente con
// el de la sesion activa. El $q.dialog sigue perteneciendo a la capa de
// componentes (frontend-architecture.md §2.1); el store nunca conoce Quasar.

/** Antelacion del aviso respecto a la caducidad del access token. */
const WARNING_MS = 60_000;

/**
 * Cadencia del sondeo. Se usa `setInterval` y no un `setTimeout` calculado:
 * un temporizador programado a 59 minutos vista no sobrevive a una suspension
 * del equipo ni a un salto del reloj del sistema, mientras que un sondeo corto
 * recalcula contra `Date.now()` en cada vuelta y se autocorrige.
 */
const CHECK_INTERVAL_MS = 1000;

const MILLISECONDS_PER_SECOND = 1000;

const LOGIN_ROUTE = '/login';

export const useSessionMonitor = (): void => {
  const $q = useQuasar();
  const router = useRouter();
  const sessionStore = useSessionStore();

  let checkIntervalId: ReturnType<typeof setInterval> | undefined;
  let isDialogOpen = false;

  /**
   * Renovacion en vuelo. Congela el sondeo mientras dura: hasta que llegue el par
   * nuevo, el token viejo sigue en el store y cada vuelta lo veria igual de
   * moribundo, reabriendo el aviso o cerrando la sesion por debajo de una
   * renovacion que iba a tener exito.
   */
  let isRefreshing = false;

  /** Handle del dialogo abierto, para poder cerrarlo desde fuera del propio dialogo. */
  let dialogHandle: DialogChainObject | undefined;

  const clearScheduledWarning = (): void => {
    if (checkIntervalId) {
      clearInterval(checkIntervalId);
      checkIntervalId = undefined;
    }
  };

  /** Cierra el aviso si sigue en pantalla y libera su estado. */
  const closeExpiryDialog = (): void => {
    dialogHandle?.hide();
    dialogHandle = undefined;
    isDialogOpen = false;
  };

  /** Purga la sesion y devuelve al login. Punto unico de salida del monitor. */
  const terminateSession = async (message: string): Promise<void> => {
    clearScheduledWarning();

    // El dialogo es `persistent` y el plugin lo monta fuera del arbol del layout:
    // sin este cierre explicito quedaria flotando sobre la vista de login.
    closeExpiryDialog();

    await sessionStore.logout();

    $q.notify({ type: 'negative', message });

    if (router.currentRoute.value.path !== LOGIN_ROUTE) {
      await router.replace(LOGIN_ROUTE);
    }
  };

  /**
   * Una vuelta del sondeo: lee el `exp` del JWT y decide.
   *
   * Todo el estado sale de `Date.now()` contra el claim, nunca de cuanto lleva
   * corriendo el temporizador, asi que da igual que el navegador haya frenado el
   * intervalo en segundo plano o que el equipo haya estado suspendido.
   */
  const checkExpiry = (): void => {
    // Con una renovacion en curso no hay nada que decidir: el veredicto lo dara
    // el par de tokens nuevo, y el `watch` sobre accessToken reprograma el ciclo.
    if (isRefreshing) return;

    const millisecondsUntilExpiry = sessionStore.millisecondsUntilExpiry;

    // Sin token legible no hay nada que vigilar; si alguna peticion sale con esas
    // credenciales, el 401 del interceptor cubre el caso.
    if (millisecondsUntilExpiry === null) return;

    if (millisecondsUntilExpiry <= 0) {
      void terminateSession('Tu sesion expiro. Vuelve a iniciar sesion.');
      return;
    }

    // Dentro del ultimo minuto: se avisa con el tiempo que reste de verdad, que
    // tras una recarga puede ser bastante menos de 60 s.
    if (millisecondsUntilExpiry <= WARNING_MS) {
      openExpiryDialog(millisecondsUntilExpiry);
    }
  };

  /** Arranca el sondeo desde cero y comprueba de inmediato, sin esperar un tick. */
  const scheduleWarning = (): void => {
    clearScheduledWarning();

    // Sin token legible no hay nada que vigilar: se sale sin reinstalar el
    // intervalo. Cubre el caso de `clear()`, que dispara este mismo `watch` y
    // dejaba un sondeo de 1 s corriendo en vacio tras cerrar sesion.
    if (sessionStore.millisecondsUntilExpiry === null) return;

    checkExpiry();

    checkIntervalId = setInterval(checkExpiry, CHECK_INTERVAL_MS);
  };

  function openExpiryDialog(millisecondsUntilExpiry: number): void {
    if (isDialogOpen) return;
    isDialogOpen = true;

    dialogHandle = $q
      .dialog({
        component: SessionExpiryDialog,
        componentProps: {
          secondsUntilExpiry: Math.round(millisecondsUntilExpiry / MILLISECONDS_PER_SECOND),
        },
      })
      .onOk(() => {
        dialogHandle = undefined;
        isDialogOpen = false;

        // `isRefreshing` se levanta ANTES de lanzar la peticion: el siguiente tick
        // del sondeo llega en 1 s y veria el token viejo todavia en el store.
        isRefreshing = true;

        // El watch sobre accessToken reprograma el ciclo al llegar el par nuevo.
        void sessionStore
          .refreshTokens()
          .catch(() => {
            void terminateSession('No se pudo renovar la sesion. Vuelve a iniciar sesion.');
          })
          .finally(() => {
            isRefreshing = false;
          });
      })
      .onCancel(() => {
        dialogHandle = undefined;
        isDialogOpen = false;
        void terminateSession('Sesion cerrada.');
      });
  }

  /**
   * Resiliencia ante suspension del equipo.
   *
   * El sondeo ya recalcula contra el reloj real, pero los navegadores frenan los
   * temporizadores de las pestañas en segundo plano (hasta ~1 vuelta por minuto),
   * asi que al volver puede pasar casi un minuto antes del siguiente tick. Este
   * listener fuerza la comprobacion en el acto.
   */
  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!sessionStore.isAuthenticated) return;

    // Misma razon que en checkExpiry: volver a la pestaña con una renovacion en
    // vuelo no debe cerrar la sesion mirando el token que esta a punto de morir.
    if (isRefreshing) return;

    const millisecondsUntilExpiry = sessionStore.millisecondsUntilExpiry;

    if (millisecondsUntilExpiry !== null && millisecondsUntilExpiry <= 0) {
      // El token murio mientras el equipo estaba suspendido: fuera de inmediato,
      // sin ofrecer renovacion.
      void terminateSession('Tu sesion expiro mientras el equipo estaba suspendido.');
      return;
    }

    checkExpiry();
  };

  // Un token nuevo (login o renovacion) reinicia el ciclo desde cero.
  watch(() => sessionStore.accessToken, scheduleWarning);

  onMounted(() => {
    scheduleWarning();
    document.addEventListener('visibilitychange', onVisibilityChange);
  });

  onBeforeUnmount(() => {
    clearScheduledWarning();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });
};
