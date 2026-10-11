import { UserRole } from '@/types/user';

import type { RouteLocationNormalized } from 'vue-router';

/** Ruta del login: destino del rechazo por falta de sesion. */
export const LOGIN_ROUTE = '/login';

/** Ruta de inicio: destino del rechazo por rol insuficiente. */
export const HOME_ROUTE = '/';

/**
 * Lo unico que la decision necesita saber de la sesion.
 *
 * Es un objeto plano y no el store: asi la funcion se prueba sin Pinia, y el
 * dia que la sesion cambie de forma solo se toca el adaptador de `index.ts`.
 */
export interface NavigationSession {
  readonly isAuthenticated: boolean;
  readonly role: UserRole | null;
}

/** Negacion por rol. El mensaje al usuario lo decide la capa de UI, no esta. */
export interface NavigationDenied {
  readonly denied: UserRole.ADMIN;
}

/** Redireccion a otra ruta. */
export interface NavigationRedirect {
  readonly path: string;
  readonly query?: Record<string, string>;
}

export type NavigationDecision = true | NavigationRedirect | NavigationDenied;

/** Discriminador de `NavigationDenied`, para que `index.ts` no inspeccione claves. */
export const isDenied = (
  decision: NavigationDecision,
): decision is NavigationDenied =>
  decision !== true && 'denied' in decision;

/**
 * Resuelve a donde debe ir una navegacion.
 *
 * FUNCION PURA a proposito: ni crea el router ni abre dialogos. El efecto visual
 * del rechazo vive en `router/index.ts`, y esa separacion es lo que permite
 * probar la matriz de permisos entera sin montar Quasar ni un DOM.
 *
 * Solo mira el estado local: la autoridad real es el backend, que responde 401 o
 * 403 si el token o el rol no valen. Esto evita pintar vistas privadas que
 * acabarian vacias, no sustituye a la comprobacion del servidor.
 */
export const resolveNavigation = (
  to: RouteLocationNormalized,
  session: NavigationSession,
): NavigationDecision => {
  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth);
  const requiresAdmin = to.matched.some((record) => record.meta.requiresAdmin);

  if (requiresAuth && !session.isAuthenticated) {
    // Se recuerda el destino para volver a el tras validar el codigo.
    return { path: LOGIN_ROUTE, query: { redirect: to.fullPath } };
  }

  // RBAC: espejo del @Roles(UserRole.ADMIN) del backend. Evita ensenar una vista
  // que el servidor contestaria con 403; NO es el control de acceso real, que
  // sigue siendo el RolesGuard de NestJS.
  if (requiresAdmin && session.role !== UserRole.ADMIN) {
    return { denied: UserRole.ADMIN };
  }

  if (to.path === LOGIN_ROUTE && session.isAuthenticated) {
    return { path: HOME_ROUTE };
  }

  return true;
};
