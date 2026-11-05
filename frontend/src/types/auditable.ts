/**
 * Campos de auditoria comunes a las tablas maestras (migracion 045).
 *
 * Replica de `AuditFieldsResponseDto` / `AuditUserResponseDto` del backend
 * (`common/dto/audit-response.dto.ts`). Los extienden las filas de usuarios,
 * plantillas HTML, flujos, plantillas de flujo y prompts de IA.
 *
 * Fechas como `string` y no `Date`: por JSON llega una cadena ISO-8601, y
 * tiparla como `Date` seria una mentira que solo se descubriria al llamar a un
 * metodo que no existe.
 */

/** Autor de un cambio: solo su id y su correo. */
export interface AuditUser {
  readonly id: string;
  readonly email: string;
}

export interface AuditableData {
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * `null` en las filas anteriores a la migracion 045 y en los cambios que hizo
   * el sistema (por ejemplo, el motor al pausar un flujo).
   */
  readonly createdBy: AuditUser | null;
  readonly updatedBy: AuditUser | null;
}
