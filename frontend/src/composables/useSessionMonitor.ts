import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';

import SessionExpiryDialog from '@components/session/SessionExpiryDialog.vue';
import { useSessionStore } from '@stores/session.store';

// Monitor proactivo de expiracion del JWT (PROT-06.4).
//
// Es un composable y no un componente porque no pinta nada: solo programa
// temporizadores y lanza un dialogo. Se invoca desde MainLayout.vue, que envuelve
// todas las rutas autenticadas, asi que su ciclo de vida coincide exactamente con
// el de la sesion activa. El $q.dialog sigue perteneciendo a la capa de
// componentes (frontend-architecture.md §2.1); el store nunca conoce Quasar.

/** Antelacion del aviso respecto a la caducidad del access token. */
const WARNING_MS = 60_000;

const MILLISECONDS_PER_SECOND = 1000;

const LOGIN_ROUTE = '/login';

export const useSessionMonitor = (): void => {
  const $q = useQuasar();
  const router = useRouter();
  const sessionStore = useSessionStore();

  let warningTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let isDialogOpen = false;

  const clearScheduledWarning = (): void => {
    if (warningTimeoutId) {
      clearTimeout(warningTimeoutId);
      warningTimeoutId = undefined;
    }
  };

  /** Purga la sesion y devuelve al login. Punto unico de salida del monitor. */
  const terminateSession = async (message: string): Promise<void> => {
    clearScheduledWarning();
    await sessionStore.logout();

    $q.notify({ type: 'negative', message });

    if (router.currentRoute.value.path !== LOGIN_ROUTE) {
      await router.replace(LOGIN_ROUTE);
    }
  };

  /**
   * Reprograma el aviso a partir del `exp` del token vigente.
   *
   * Se llama al montar, en cada cambio de token y al recuperar visibilidad, de
   * modo que el temporizador nunca queda apoyado en un calculo antiguo.
   */
  const scheduleWarning = (): void => {
    clearScheduledWarning();

    const millisecondsUntilExpiry = sessionStore.millisecondsUntilExpiry;

    // Sin token legible no hay nada que vigilar; si alguna peticion sale con esas
    // credenciales, el 401 del interceptor cubre el caso.
    if (millisecondsUntilExpiry === null) return;

    if (millisecondsUntilExpiry <= 0) {
      void terminateSession('Tu sesion expiro. Vuelve a iniciar sesion.');
      return;
    }

    // Token ya dentro de su ultimo minuto (p. ej. tras recargar la pagina): el
    // aviso se muestra de inmediato, con el tiempo que reste de verdad.
    if (millisecondsUntilExpiry <= WARNING_MS) {
      openExpiryDialog(millisecondsUntilExpiry);
      return;
    }

    warningTimeoutId = setTimeout(() => {
      openExpiryDialog(WARNING_MS);
    }, millisecondsUntilExpiry - WARNING_MS);
  };

  function openExpiryDialog(millisecondsUntilExpiry: number): void {
    if (isDialogOpen) return;
    isDialogOpen = true;

    $q.dialog({
      component: SessionExpiryDialog,
      componentProps: {
        secondsUntilExpiry: Math.round(millisecondsUntilExpiry / MILLISECONDS_PER_SECOND),
      },
    })
      .onOk(() => {
        isDialogOpen = false;

        // El watch sobre accessToken reprograma el ciclo al llegar el par nuevo.
        void sessionStore.refreshTokens().catch(() => {
          void terminateSession('No se pudo renovar la sesion. Vuelve a iniciar sesion.');
        });
      })
      .onCancel(() => {
        isDialogOpen = false;
        void terminateSession('Sesion cerrada.');
      });
  }

  /**
   * Resiliencia ante suspension del equipo.
   *
   * `setTimeout` no sobrevive de forma fiable a una suspension del sistema
   * operativo: al despertar puede dispararse tarde, o no haberse disparado
   * mientras el token ya caducaba. Por eso, cada vez que la pestaña vuelve a ser
   * visible se recalcula el tiempo restante contra el reloj real, en lugar de
   * confiar en el temporizador programado.
   */
  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (!sessionStore.isAuthenticated) return;

    const millisecondsUntilExpiry = sessionStore.millisecondsUntilExpiry;

    if (millisecondsUntilExpiry !== null && millisecondsUntilExpiry <= 0) {
      // El token murio mientras el equipo estaba suspendido: fuera de inmediato,
      // sin ofrecer renovacion.
      void terminateSession('Tu sesion expiro mientras el equipo estaba suspendido.');
      return;
    }

    scheduleWarning();
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
