import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
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
