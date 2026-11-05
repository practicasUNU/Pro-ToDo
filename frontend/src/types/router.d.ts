import 'vue-router';

/**
 * Contrato de `meta` de las rutas.
 *
 * Sin esta ampliacion `RouteMeta` es una interfaz vacia y `record.meta.requiresAdmin`
 * compila solo porque el tipo admite indexacion libre: una errata —`requireAdmin`—
 * no seria un error de compilacion, sino una ruta que silenciosamente deja pasar a
 * todo el mundo. Declarar las claves convierte ese fallo en un error de tipos.
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** La rama exige sesion iniciada. Se declara en el padre y cubre a los hijos. */
    requiresAuth?: boolean;
    /** Espejo de `@Roles(UserRole.ADMIN)` del backend. */
    requiresAdmin?: boolean;
  }
}
