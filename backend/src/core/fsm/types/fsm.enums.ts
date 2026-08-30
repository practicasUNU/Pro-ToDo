/**
 * Estados del ciclo de vida de una ejecucion (`ejecuciones_flujo.estado`).
 *
 * Replican los valores del tipo `enum_estado` de PostgreSQL. `INACTIVO` se
 * incorpora al tipo en `db/migrations/006-fsm-execution-mutex.sql`: el seed
 * original solo contemplaba los cuatro estados posteriores al arranque.
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
  /** Abandonada definitivamente tras agotar los reintentos. */
  FALLIDO = 'FALLIDO',
}
