/**
 * Estado de un FLUJO frente a los disparadores automaticos.
 *
 * No confundir con `ExecutionState` (`@core/fsm/types/fsm.enums`), que describe
 * el ciclo de vida de una EJECUCION concreta y tiene siete valores, cinco de
 * ellos terminales. Un flujo no es EXITOSO ni DESCARTADO: es una plantilla de
 * trabajo que acumula ejecuciones. Esta responde a una sola pregunta -"se puede
 * disparar este flujo"- solo que con tres respuestas en vez de dos.
 *
 * Sustituye al booleano `activo` (migracion 040). El tercer valor existe porque
 * desde CU-09 hay un caso que un booleano no puede expresar: el flujo tiene una
 * ejecucion detenida esperando un reintento manual, que no es lo mismo que
 * estar retirado por decision de un operador.
 *
 * Los valores van en espanol porque son los literales del tipo
 * `workflow_status_enum` de PostgreSQL, igual que `ExecutionState`.
 */
export enum WorkflowStatus {
  /** Habilitado: el sondeo IMAP y los cron lo inscriben y lo disparan. */
  ACTIVO = 'ACTIVO',
  /** Retirado por un operador, o recien creado. No se dispara. */
  INACTIVO = 'INACTIVO',
  /**
   * Detenido por el motor con una ejecucion reanudable (CU-09).
   *
   * Lo escribe EXCLUSIVAMENTE `FsmEngineService.pauseAt`, a traves de
   * `WorkflowStatusCoordinator`. La API de edicion lo rechaza: puesto a mano
   * describiria una ejecucion detenida que no existe, y nada podria sacarlo de
   * ahi, porque las dos salidas de PAUSADO -reanudar y descartar- parten
   * precisamente de esa ejecucion.
   */
  PAUSADO = 'PAUSADO',
}

/**
 * Estados que un cliente HTTP puede pedir en un `PATCH`.
 *
 * Se declara aqui y no en el DTO para que el `@IsIn` del DTO y la guarda del
 * servicio lean la MISMA lista: tenerla por duplicado es como una de las dos se
 * queda corta el dia que aparezca un cuarto estado.
 */
export const EDITABLE_WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  WorkflowStatus.ACTIVO,
  WorkflowStatus.INACTIVO,
];
