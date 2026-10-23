/**
 * Contrato de cable de las mutaciones sobre entidades maestras.
 *
 * Replica exacta de `backend/src/common/types/crud-events.types.ts`. La
 * duplicacion es la misma que ya existe para los eventos de ejecucion: no hay
 * paquete compartido entre cliente y servidor, y lo que importa es que ambos
 * lados nombren igual el evento y sus campos.
 */

/** Nombre del evento en el cable. */
export const CRUD_EVENT = { MUTATION: 'crud:mutation' } as const;

/**
 * Tablas cuya edicion se difunde. Replica de `CrudEntity` del backend.
 *
 * Casi todas son MAESTRAS. `audit_eventos` es la excepcion: registro de solo
 * insercion que se difunde para que el panel de auditoria vea tambien las
 * filas que no nacen de una mutacion maestra, como un inicio o un cierre de
 * sesion. `useCrudSocket` la ignora a proposito —no hay coleccion maestra que
 * parchear— y quien la escucha es el propio panel.
 */
export type CrudEntity =
  | 'users'
  | 'allowed_ips'
  | 'templates'
  | 'workflow_templates'
  | 'ai_prompts'
  | 'workflows'
  | 'audit_eventos';

/**
 * Naturaleza de la escritura, tal y como la entiende la BASE DE DATOS.
 *
 * `DELETED` significa que la fila ya no existe, y hoy solo lo produce
 * `allowed_ips`. Una baja logica llega como `UPDATED` con la fila actualizada,
 * de modo que el cliente no necesita saber, entidad por entidad, si toca
 * quitarla o reemplazarla.
 */
export type CrudAction = 'CREATED' | 'UPDATED' | 'DELETED';

/** Mutacion difundida a los paneles abiertos. */
export interface CrudMutationPayload<T = unknown> {
  readonly entity: CrudEntity;
  readonly action: CrudAction;
  readonly id: string;
  /** Fila resultante. Ausente en `DELETED`: no queda fila que describir. */
  readonly data?: T;
  readonly emittedAt: string;
}
