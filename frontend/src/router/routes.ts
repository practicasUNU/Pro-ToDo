import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  // Autenticacion: layout desnudo, fuera del shell corporativo
  {
    path: '/login',
    component: () => import('@/layouts/AuthLayout.vue'),
    children: [{ path: '', name: 'login', component: () => import('@/pages/LoginPage.vue') }],
  },

  // Area privada: `requiresAuth` en el padre cubre toda la rama, de modo que una
  // ruta nueva nace protegida sin depender de que alguien recuerde marcarla.
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', component: () => import('@/pages/IndexPage.vue') },
      {
        path: 'users',
        component: () => import('@/pages/UsersPage.vue'),
        // Espeja el @Roles(UserRole.ADMIN) del UsersController: un EDITOR que
        // llegue aqui solo veria una tabla vacia y un 403 en la consola.
        meta: { requiresAdmin: true },
      },
      {
        path: 'ip-whitelist',
        component: () => import('@/pages/IpWhitelistPage.vue'),
        // Espeja el @Roles(UserRole.ADMIN) del AllowedIpsController.
        meta: { requiresAdmin: true },
      },
      {
        path: 'templates',
        component: () => import('@/pages/templates/TemplatesPage.vue'),
        // SIN requiresAdmin: TemplatesController admite @Roles(ADMIN, EDITOR).
        // Configurar plantillas es operacion de flujos, no gestion de cuentas.
      },
      {
        path: 'nodos/config-sandbox',
        component: () => import('@/pages/nodes/NodeConfigSandboxPage.vue'),
      },
    ],
  },

  // Ruta comodin: debe ir siempre al final
  {
    path: '/:catchAll(.*)*',
    component: () => import('@/pages/ErrorNotFound.vue'),
  },
];

export default routes;
