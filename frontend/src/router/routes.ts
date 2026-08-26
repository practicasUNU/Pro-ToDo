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
      { path: 'users', component: () => import('@/pages/UsersPage.vue') },
    ],
  },

  // Ruta comodin: debe ir siempre al final
  {
    path: '/:catchAll(.*)*',
    component: () => import('@/pages/ErrorNotFound.vue'),
  },
];

export default routes;
