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
