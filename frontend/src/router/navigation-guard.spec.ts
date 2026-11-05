import { describe, expect, it } from 'vitest';

import { isDenied, resolveNavigation } from './navigation-guard';

import { UserRole } from '@/types/user';

import type { NavigationSession } from './navigation-guard';
import type { RouteLocationNormalized, RouteMeta } from 'vue-router';

/**
 * Doble minimo de un destino de navegacion.
 *
 * Solo se puebla lo que la funcion mira —`matched[].meta`, `path` y `fullPath`—
 * en vez de construir un `RouteLocationNormalized` entero: lo demas seria ruido
 * que habria que mantener cada vez que vue-router anada un campo.
 */
const buildRoute = (
  path: string,
  meta: RouteMeta = {},
): RouteLocationNormalized =>
  ({
    path,
    fullPath: path,
    matched: [{ meta }],
  }) as unknown as RouteLocationNormalized;

const ADMIN_SESSION: NavigationSession = {
  isAuthenticated: true,
  role: UserRole.ADMIN,
};

const EDITOR_SESSION: NavigationSession = {
  isAuthenticated: true,
  role: UserRole.EDITOR,
};

const ANONYMOUS_SESSION: NavigationSession = {
  isAuthenticated: false,
  role: null,
};

const TEMPLATES_ROUTE = '/plantillas-flujo';

describe('resolveNavigation', () => {
  it('deberia dejar pasar a un ADMIN a la ruta de plantillas de flujo', () => {
    // Arrange
    const to = buildRoute(TEMPLATES_ROUTE, {
      requiresAuth: true,
      requiresAdmin: true,
    });

    // Act
    const decision = resolveNavigation(to, ADMIN_SESSION);

    // Assert
    expect(decision).toBe(true);
  });

  it('deberia negar a un EDITOR la ruta de plantillas de flujo', () => {
    // Arrange
    const to = buildRoute(TEMPLATES_ROUTE, {
      requiresAuth: true,
      requiresAdmin: true,
    });

    // Act
    const decision = resolveNavigation(to, EDITOR_SESSION);

    // Assert
    expect(isDenied(decision)).toBe(true);
    expect(decision).toEqual({ denied: UserRole.ADMIN });
  });

  it('deberia dejar pasar a un EDITOR a una ruta de operacion', () => {
    // Arrange: 'flujos' NO lleva requiresAdmin; operar flujos no es administrar.
    const to = buildRoute('/flujos', { requiresAuth: true });

    // Act
    const decision = resolveNavigation(to, EDITOR_SESSION);

    // Assert
    expect(decision).toBe(true);
  });

  it('deberia mandar al login recordando el destino cuando no hay sesion', () => {
    // Arrange
    const to = buildRoute(TEMPLATES_ROUTE, {
      requiresAuth: true,
      requiresAdmin: true,
    });

    // Act
    const decision = resolveNavigation(to, ANONYMOUS_SESSION);

    // Assert: la falta de sesion se resuelve ANTES que el rol. Un anonimo debe
    // acabar en el login con su destino guardado, no en el dialogo de rol.
    expect(decision).toEqual({
      path: '/login',
      query: { redirect: TEMPLATES_ROUTE },
    });
  });

  it('deberia sacar del login a quien ya tiene sesion', () => {
    // Arrange
    const to = buildRoute('/login');

    // Act
    const decision = resolveNavigation(to, EDITOR_SESSION);

    // Assert
    expect(decision).toEqual({ path: '/' });
  });

  it('deberia heredar el meta declarado en la rama padre', () => {
    // Arrange: `requiresAdmin` en el padre debe cubrir al hijo, que es como
    // `requiresAuth` protege toda el area privada desde un solo sitio.
    const to = {
      path: '/users/42',
      fullPath: '/users/42',
      matched: [{ meta: { requiresAdmin: true } }, { meta: {} }],
    } as unknown as RouteLocationNormalized;

    // Act
    const decision = resolveNavigation(to, EDITOR_SESSION);

    // Assert
    expect(isDenied(decision)).toBe(true);
  });
});
