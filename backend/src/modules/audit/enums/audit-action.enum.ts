/**
 * Acciones humanas que registra `audit_eventos` (migracion 048).
 *
 * Los valores son los literales del CHECK de la columna `accion`: cambiarlos
 * aqui exige una migracion.
 */
export enum AuditActionType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  /** UPDATE de `usuarios` que cambio el rol: se separa para poder filtrarlo. */
  ROLE_CHANGE = 'ROLE_CHANGE',
  LOGIN = 'LOGIN',
  LOGIN_FAILED = 'LOGIN_FAILED',
}
