/**
 * Estados del ciclo de vida de una ejecucion (`ejecuciones_flujo.estado`).
 *
 * Replican los valores del tipo `enum_estado` de PostgreSQL. `INACTIVO` se
 * incorpora al tipo en `db/migrations/006-fsm-execution-mutex.sql` (el seed
 * original solo contemplaba los cuatro estados posteriores al arranque) y
 * `OMITIDO` en `db/migrations/030-estado-ejecucion-omitido.sql`.
 */
export enum ExecutionState {
  /** Fila creada, el motor todavia no ha tomado el primer paso. */
  INACTIVO = 'INACTIVO',
  /** Ejecucion viva. Solo puede haber una por flujo (ver `idx_flujo_activo`). */
  EN_PROCESO = 'EN_PROCESO',
  /** Detenida tras un fallo o un reinicio; conserva el `activeCursor` para reintentar. */
  PAUSADO = 'PAUSADO',
  /** Alcanzo el nodo terminal sin errores. */
  EXITOSO = 'EXITOSO',
  /**
   * Termino sin trabajo que hacer, porque un nodo pidio parada ordenada.
   *
   * Es el desenlace de un `NodeResult.halt`: el buzon no traia correos nuevos,
   * o el asunto no casaba con el filtro. NO es un fallo —nada reventó, no hay
   * `.log` que leer ni cursor que reintentar— pero tampoco un exito: contarlo
   * como tal hacia que, con un sondeo por minuto, cualquier recuento midiese
   * sobre todo buzones vacios.
   *
   * Incorporado al tipo `enum_estado` en
   * `db/migrations/030-estado-ejecucion-omitido.sql`.
   */
  OMITIDO = 'OMITIDO',
  /** Abandonada definitivamente tras agotar los reintentos. */
  FALLIDO = 'FALLIDO',
}
