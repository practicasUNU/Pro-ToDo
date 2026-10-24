/**
 * Contrato de cable de los avisos dirigidos a UNA persona.
 *
 * Familia aparte de `execution-events.types.ts` y `crud-events.types.ts` a
 * proposito: aquella describe el ciclo de vida de una ejecucion y va a la sala
 * del flujo, aquella otra describe escrituras en tablas y va a salas de rol, y
 * esta se dirige a la sala `user_${userId}` de una cuenta concreta. No
 * comparten payload ni destinatario, solo el transporte.
 */

/**
 * Nombre del evento en el cable.
 *
 * `as const` y no `enum`, igual que las otras dos familias: la cadena literal
 * es lo que el frontend escribe en su `socket.on`, de modo que el valor importa
 * mas que el tipo que lo envuelve.
 */
export const SESSION_EVENT = { USER_MODIFIED: 'user:modified' } as const;

/**
 * Campos cuya modificacion obliga a rehacer la sesion.
 *
 * EN CASTELLANO porque son texto que el modal le lee al usuario tal cual
 * («tu cuenta ha sido modificada en los campos: rol»). No son identificadores
 * de codigo, asi que no les aplica la regla de ingles estricto.
 */
export type ModifiedUserField = 'rol' | 'estado' | 'correo';

/**
 * Aviso de que la cuenta de alguien dejo de ser la que era.
 *
 * Lleva el autor porque un cierre de sesion sin explicacion es indistinguible
 * de un fallo del sistema: quien se ve expulsado tiene derecho a saber quien lo
 * decidio y que cambio.
 */
export interface UserModifiedPayload {
  readonly userId: string;
  readonly actorEmail: string;
  readonly updatedFields: readonly ModifiedUserField[];
  /** ISO, no `Date`: cruza un socket y se serializa. */
  readonly emittedAt: string;
}
