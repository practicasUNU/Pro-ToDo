/**
 * Resultado de una llamada a un proveedor de IA (migracion 060).
 *
 * Valores en ingles porque son el contrato de la columna `estado` de
 * `telemetria_tokens_ia` tal y como lo leen los informes y el frontend.
 */
export enum AiCallStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

/** Longitud de `mensaje_error`: lo que sobra se recorta antes de insertar. */
export const AI_CALL_ERROR_MESSAGE_MAX_LENGTH = 500;

/** Etiqueta en castellano del estado, para informes. */
export const AI_CALL_STATUS_LABELS: Readonly<Record<AiCallStatus, string>> = {
  [AiCallStatus.SUCCESS]: 'Exitosa',
  [AiCallStatus.FAILED]: 'Fallida',
};
