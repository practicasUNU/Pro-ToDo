/**
 * Avisos dirigidos a UNA persona. Replica de
 * `backend/src/common/types/session-events.types.ts`.
 *
 * Cualquier cambio alla hay que traerlo aqui: es contrato de cable, y una
 * divergencia no da error de compilacion, solo un evento que nunca llega.
 */

/** Nombre del evento en el cable. */
export const SESSION_EVENT = { USER_MODIFIED: 'user:modified' } as const;

/**
 * Campos cuya modificacion obliga a rehacer la sesion.
 *
 * EN CASTELLANO porque el modal se los lee al usuario tal cual; no son
 * identificadores de codigo.
 */
export type ModifiedUserField = 'rol' | 'estado' | 'correo';

/** Aviso de que la cuenta de alguien dejo de ser la que era. */
export interface UserModifiedPayload {
  readonly userId: string;
  readonly actorEmail: string;
  readonly updatedFields: readonly ModifiedUserField[];
  readonly emittedAt: string;
}
