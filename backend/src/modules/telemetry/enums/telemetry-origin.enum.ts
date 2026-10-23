/**
 * Que provoco una inferencia registrada en `telemetria_tokens_ia`
 * (`origen_operacion`, migracion 049).
 *
 * Los valores son los literales del CHECK de la columna: cambiarlos exige una
 * migracion.
 */
export enum TelemetryOperationOrigin {
  /** Un nodo de IA dentro de una ejecucion del FSM: lleva ejecucion, flujo y nodo. */
  FLOW_EXECUTION = 'EJECUCION_FLUJO',
  /** El asistente "Mejorar Prompt con IA": lleva el usuario que lo pidio. */
  PROMPT_OPTIMIZATION = 'PROMPT_OPTIMIZATION',
}

/** Etiqueta en castellano del origen, para informes y tablas. */
export const TELEMETRY_ORIGIN_LABELS: Readonly<
  Record<TelemetryOperationOrigin, string>
> = {
  [TelemetryOperationOrigin.FLOW_EXECUTION]: 'Ejecución de flujo',
  [TelemetryOperationOrigin.PROMPT_OPTIMIZATION]: 'Optimización de prompt',
};
