import { defineRouter } from '#q-app';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';

import { Dialog, Notify } from 'quasar';

import { useSessionStore } from '@stores/session.store';

import { HOME_ROUTE, isDenied, resolveNavigation } from './navigation-guard';
import routes from './routes';

/*
 * If not building with SSR mode, you can
 * directly export the Router instantiation;
 *
 * The function below can be async too; either use
 * async/await or return a Promise which resolves
 * with the Router instance.
 */

export default defineRouter(({ store }) => {
  const createHistory = import.meta.env.QUASAR_SERVER
    ? createMemoryHistory
    : import.meta.env.QUASAR_VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave this as is and make changes in quasar.conf.js instead!
    // quasar.conf.js -> build -> vueRouterMode
    // quasar.conf.js -> build -> publicPath
    history: createHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE),
  });

  // Guarda de navegacion. La DECISION vive en `navigation-guard.ts` como funcion
  // pura y probable; aqui solo se adapta: se le entrega la sesion en forma plana
  // y se traduce su veredicto a lo que espera vue-router.
  Router.beforeEach((to) => {
    const sessionStore = useSessionStore(store);

    const decision = resolveNavigation(to, {
      isAuthenticated: sessionStore.isAuthenticated,
      role: sessionStore.user?.role ?? null,
    });

    if (decision === true) {
      return true;
    }

    if (!isDenied(decision)) {
      return decision;
    }

    // `Dialog` importado del paquete, no `useQuasar()`: aqui no hay componente
    // montado del que obtener la instancia.
    Dialog.create({
      title: 'Acceso denegado',
      message: 'Esta seccion esta reservada a administradores. Tu cuenta no tiene ese permiso.',
      persistent: true,
      ok: { label: 'Entendido', unelevated: true, noCaps: true, color: 'negative' },
    });

    // Se devuelve la ruta de inicio en lugar de `next(false)`: cancelar sin mas
    // dejaria la barra de direcciones mostrando la URL prohibida, porque el
    // navegador ya la habia escrito.
    return { path: HOME_ROUTE };
  });

  // Un chunk de ruta que no carga (asset inexistente, import sin resolver, o un
  // despliegue nuevo que invalida los hashes del anterior) deja el <router-view>
  // vacio: la app arranca pero la vista no pinta, y la promesa rechazada del
  // import() diferido muere sin ruido. Aqui se hace visible.
  Router.onError((error) => {
    console.error('[router] fallo al cargar la vista', error);

    Notify.create({
      type: 'negative',
      message: 'No se pudo cargar la vista. Recarga la pagina.',
      timeout: 0,
      actions: [{ label: 'Recargar', color: 'white', handler: () => window.location.reload() }],
    });
  });

  return Router;
});
