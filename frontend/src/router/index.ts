import { defineRouter } from '#q-app';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';

import { Dialog, Notify } from 'quasar';

import { useSessionStore } from '@stores/session.store';

import { UserRole } from '@/types/user';

import routes from './routes';

const LOGIN_ROUTE = '/login';
const HOME_ROUTE = '/';

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

  // Guarda de sesion. Solo mira el estado local: la autoridad real es el backend,
  // que responde 401 si el token no vale. Esto evita pintar vistas privadas que
  // acabarian vacias, no sustituye a la comprobacion del servidor.
  Router.beforeEach((to) => {
    const sessionStore = useSessionStore(store);
    const requiresAuth = to.matched.some((record) => record.meta.requiresAuth);
    const requiresAdmin = to.matched.some((record) => record.meta.requiresAdmin);

    if (requiresAuth && !sessionStore.isAuthenticated) {
      // Se recuerda el destino para volver a el tras validar el codigo.
      return { path: LOGIN_ROUTE, query: { redirect: to.fullPath } };
    }

    // RBAC: espejo del @Roles(UserRole.ADMIN) del backend. Evita enseñar una
    // vista que el servidor contestaria con 403; NO es el control de acceso real,
    // que sigue siendo el RolesGuard de NestJS.
    if (requiresAdmin && sessionStore.user?.role !== UserRole.ADMIN) {
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
    }

    if (to.path === LOGIN_ROUTE && sessionStore.isAuthenticated) {
      return { path: HOME_ROUTE };
    }

    return true;
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
