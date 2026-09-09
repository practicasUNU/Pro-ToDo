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
        path: 'flujos',
        component: () => import('@/pages/workflows/WorkflowsPage.vue'),
        // SIN requiresAdmin: WorkflowsController admite @Roles(ADMIN, EDITOR).
        // Operar flujos es operacion, no gestion de cuentas.
      },
      {
        path: 'flujos/nuevo',
        component: () => import('@/pages/WizardPage.vue'),
        // SIN requiresAdmin: idem. Se declara DESPUES de 'flujos' por claridad;
        // vue-router resuelve por especificidad y no por orden en rutas
        // estaticas, asi que no hay riesgo de que una capture a la otra.
      },
      {
        path: 'flujos/:id/editar',
        component: () => import('@/pages/WizardPage.vue'),
        // MISMA pagina que el alta, en modo edicion. Comparten componente a
        // proposito: duplicar el stepper daria dos asistentes que mantener
        // sincronizados, y el segundo se quedaria atras en cuanto aparezca un
        // tipo de nodo nuevo. El modo lo decide `route.params.id`.
        //
        // 'flujos/nuevo' se declara ANTES: una ruta estatica gana siempre a una
        // dinamica en vue-router, asi que '/flujos/nuevo' no cae aqui con
        // id="nuevo".
      },
      {
        path: 'plantillas-flujo',
        component: () => import('@/pages/workflow-templates/WorkflowTemplatesPage.vue'),
        // SIN requiresAdmin a proposito, aunque las ESCRITURAS del backend sean
        // solo de ADMIN: un EDITOR necesita consultar el catalogo para saber de
        // que puede partir. El 403 en el alta y la edicion lo impone el
        // servidor, que es la autoridad; bloquear la ruta entera le ocultaria
        // informacion que si puede ver.
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
