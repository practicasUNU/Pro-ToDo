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
        path: 'plantillas-prompts-ia',
        name: 'ai-prompt-templates',
        component: () => import('@/pages/AiPromptTemplatesPage.vue'),
        // SIN requiresAdmin: AiPromptTemplatesController admite @Roles(ADMIN, EDITOR).
        // Curar plantillas de prompt es operacion de flujos, no gestion de cuentas.
      },
      {
        path: 'informes',
        component: () => import('@/pages/ReportsPage.vue'),
        // SIN requiresAdmin: TelemetryController admite @Roles(ADMIN, EDITOR).
        // El coste de los flujos es parte de la auditoria que hace el editor.
      },
      {
        path: 'auditoria',
        component: () => import('@/pages/AuditTrailPage.vue'),
        // Espeja el @Roles(UserRole.ADMIN) del AuditController: incluye los
        // accesos fallidos y la gestion de cuentas, ambito exclusivo del ADMIN.
        meta: { requiresAdmin: true },
      },
      {
        path: 'flujos',
        component: () => import('@/pages/workflows/WorkflowsPage.vue'),
        // SIN requiresAdmin: WorkflowsController admite @Roles(ADMIN, EDITOR).
        // Operar flujos es operacion, no gestion de cuentas.
      },
      {
        // Vista de supervision: el "Canvas Read-Only" de `frontend-quasar.md`
        // §4. Va ANTES de `flujos/nuevo` y `flujos/:id/editar` por legibilidad
        // del grupo; el emparejador de vue-router prioriza el segmento literal
        // sobre el parametro, de modo que `/flujos/nuevo` sigue resolviendo al
        // asistente y no a un flujo llamado "nuevo".
        path: 'flujos/:id',
        component: () => import('@/pages/workflows/WorkflowCanvasPage.vue'),
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
        // Reservada a ADMIN por decision de producto: el catalogo maestro de
        // plantillas es administracion, no operacion. Un EDITOR instancia
        // pipelines derivados, nunca administra el catalogo.
        //
        // DIVERGENCIA DELIBERADA con el backend: WorkflowTemplatesController
        // sigue admitiendo @Roles(ADMIN, EDITOR) en LECTURA, de modo que la API
        // le serviria el listado a un EDITOR que la llamase a mano. El cierre es
        // solo de navegacion; las ESCRITURAS si las bloquea el RolesGuard.
        meta: { requiresAdmin: true },
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
