/**
 * Contrato de cable de las mutaciones sobre entidades maestras.
 *
 * Familia aparte de `execution-events.types.ts` a proposito: aquella describe
 * el ciclo de vida de una EJECUCION y se dirige a la sala del flujo; esta
 * describe escrituras en tablas administrativas y se dirige a salas de ROL. No
 * comparten payload, destinatario ni motivo, solo el transporte.
 */

/**
 * Nombre del evento en el cable.
 *
 * `as const` y no `enum`, igual que `EXECUTION_EVENT`: la cadena literal es lo
 * que el frontend escribe en su `socket.on`, de modo que el valor importa mas
 * que el tipo que lo envuelve.
 */
export const CRUD_EVENT = { MUTATION: 'crud:mutation' } as const;

/**
 * Tablas cuya edicion se difunde.
 *
 * Casi todas son MAESTRAS. `audit_eventos` es la excepcion y entra por la
 * puerta de delante: es un registro de solo insercion, nunca `UPDATED` ni
 * `DELETED`, y se difunde para que el panel de auditoria —que es una vista en
 * vivo de esa tabla— se entere de las filas que no nacen de una mutacion
 * maestra, como un inicio o un cierre de sesion. Las que SI nacen de una
 * mutacion ya provocan su propio `crud:mutation`, asi que el panel recibira
 * dos eventos por esa accion; refrescar dos veces es barato y mucho mas
 * simple que ensenarle a cada emisor si alguien esta mirando la auditoria.
 *
 * Va en `ADMIN_ONLY_ENTITIES`: la tabla registra quien hizo que y desde que
 * IP, y `audit.controller.ts` la sirve bajo `@Roles(ADMIN)`.
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
 * `allowed_ips`. Una baja LOGICA —el usuario desactivado, la plantilla
 * retirada— viaja como `UPDATED` con la fila ya actualizada, porque eso es
 * exactamente lo que ocurrio: la fila sigue ahi con una columna distinta.
 * Traducirlas todas a `DELETED` obligaria a cada cliente a saber, entidad por
 * entidad, si debe quitar la fila o reemplazarla.
 */
export type CrudAction = 'CREATED' | 'UPDATED' | 'DELETED';

/** Mutacion difundida a los paneles abiertos. */
export interface CrudMutationPayload<T = unknown> {
  readonly entity: CrudEntity;
  readonly action: CrudAction;
  readonly id: string;
  /**
   * Fila resultante, con la MISMA proyeccion que devuelve REST.
   *
   * Jamas la entidad de TypeORM en crudo: `UserResponseDto` es una lista
   * blanca (`@Exclude()` de clase mas `@Expose()` por campo) para que una
   * columna nueva no se filtre por olvido, y emitir la entidad esquivaria esa
   * politica por la puerta de atras.
   *
   * Ausente en `DELETED`: no queda fila que describir.
   */
  readonly data?: T;
  /** ISO, no `Date`: cruza un socket y se serializa. */
  readonly emittedAt: string;
}
