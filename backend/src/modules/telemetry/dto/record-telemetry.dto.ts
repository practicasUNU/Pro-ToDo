import type { AiCallStatus } from '@modules/telemetry/enums/ai-call-status.enum';
import type { TelemetryOperationOrigin } from '@modules/telemetry/enums/telemetry-origin.enum';

/**
 * Consumo de una inferencia que una estrategia de IA entrega a
 * `TelemetryService.recordTokenUsage`.
 *
 * Contrato INTERNO entre servicios, sin decoradores de `class-validator`: no
 * llega por HTTP, lo construye el propio backend a partir de la respuesta del
 * proveedor. Validarlo aqui seria validar nuestro propio codigo en cada llamada.
 */
export interface RecordTelemetryDto {
  /** `id_ejecucion` de `ejecuciones_flujo`; de ella se deriva el `flujo_id`. */
  readonly executionId: string;
  /** `nodeId` del pipeline que hizo la inferencia (el cursor del contexto). */
  readonly nodeId: string;
  /** Proveedor que RESPONDIO, que tras un fallback no es el configurado. */
  readonly aiProvider: string;
  /** Modelo que respondio, tal y como lo informa el proveedor. */
  readonly aiModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Solo el razonamiento facturado aparte de la completacion. */
  readonly reasoningTokens: number;
  /** `false` si el proveedor no informo de uso: el coste sera estimado. */
  readonly usageReported: boolean;
  /** Resultado de la llamada; las fallidas sin `usage` llegan con ceros. */
  readonly status: AiCallStatus;
  /** Motivo del fallo; se ignora en las exitosas. */
  readonly errorMessage?: string | null;
  /**
   * Usuario al que se imputa: el iniciador de la ejecucion que lleva el
   * contexto. Si falta, se toma el de la fila de `ejecuciones_flujo`.
   */
  readonly userId?: string | null;
}

/**
 * Consumo de una inferencia hecha FUERA de una ejecucion del FSM (asistente de
 * prompts, banco de pruebas o prueba de conexion), para `TelemetryService.recordAssistUsage`. No tiene ejecucion ni
 * nodo: en su lugar lleva el usuario que la pidio y el origen.
 */
export interface RecordAssistUsageDto extends Omit<
  RecordTelemetryDto,
  'executionId' | 'nodeId' | 'userId'
> {
  /** `id_usuario` de quien pidio la inferencia. */
  readonly userId: string;
  readonly origin:
    | TelemetryOperationOrigin.PROMPT_OPTIMIZATION
    | TelemetryOperationOrigin.NODE_SANDBOX
    | TelemetryOperationOrigin.CONNECTION_TEST;
}

/** Contadores y coste ya calculados, con las tarifas que se aplicaron. */
export interface TokenUsageMetrics {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Tarifas en USD por millon de tokens. */
  readonly promptRateUsd: number;
  readonly completionRateUsd: number;
  readonly reasoningRateUsd: number;
  readonly estimatedCostUsd: number;
  readonly isEstimated: boolean;
}
