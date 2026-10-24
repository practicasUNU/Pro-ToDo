/**
 * Replica de los DTOs de `TelemetryController` del backend
 * (`backend/src/modules/telemetry/dto/telemetry-report-response.dto.ts` y
 * `telemetry-query.dto.ts`). Cualquier cambio alla hay que traerlo aqui.
 *
 * Fechas como `string` ISO: es lo que llega por JSON.
 */

import type { SortQuery, TelemetryHistorySortKey } from '@/types/sort';

/** Filtros comunes de `/telemetry/*`. Replica `TelemetryQueryDto`. */
export interface TelemetryQuery {
  /** Inicio del rango (incluido), ISO 8601. */
  readonly from?: string;
  /** Fin del rango (excluido), ISO 8601. */
  readonly to?: string;
  readonly flowId?: string;
  readonly aiProvider?: string;
}

/** Filtros del historial paginado. Replica `TelemetryHistoryQueryDto`. */
export interface TelemetryHistoryQuery
  extends TelemetryQuery,
    SortQuery<TelemetryHistorySortKey> {
  readonly limit?: number;
  readonly offset?: number;
}

/** Rango que el backend aplico de verdad, ya resuelto. */
export interface TelemetryRange {
  readonly from: string;
  readonly to: string;
}

/** KPIs globales. Replica `TelemetrySummaryResponseDto`. */
export interface TelemetrySummary {
  readonly range: TelemetryRange;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly aiInvocations: number;
  readonly estimatedInvocations: number;
  /** Ejecuciones concluidas: EXITOSO + FALLIDO + DESCARTADO. */
  readonly executionsTotal: number;
  readonly executionsSucceeded: number;
  /** Entre 0 y 1; `null` si no hubo ejecuciones concluidas en el rango. */
  readonly successRate: number | null;
}

/** Consumo agregado de un modelo. Replica `ModelBreakdownResponseDto`. */
export interface ModelBreakdownRow {
  readonly aiProvider: string;
  readonly aiModel: string;
  readonly invocations: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** Valores de `TelemetryOperationOrigin` del backend (migracion 049). */
export enum TelemetryOperationOrigin {
  FLOW_EXECUTION = 'EJECUCION_FLUJO',
  PROMPT_OPTIMIZATION = 'PROMPT_OPTIMIZATION',
}

/** Una inferencia registrada. Replica `TelemetryHistoryItemResponseDto`. */
export interface TelemetryHistoryItem {
  readonly id: string;
  readonly createdAt: string;
  /** Que provoco la inferencia: un nodo de un flujo o el asistente de prompts. */
  readonly operationOrigin: TelemetryOperationOrigin;
  /** `null` fuera de una ejecucion (asistente de prompts). */
  readonly executionId: string | null;
  readonly flowId: string | null;
  readonly flowName: string | null;
  readonly nodeId: string | null;
  readonly aiProvider: string;
  readonly aiModel: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  /** Tarifas aplicadas, en USD por millon de tokens. */
  readonly promptRateUsd: number;
  readonly completionRateUsd: number;
  readonly reasoningRateUsd: number;
  readonly estimatedCostUsd: number;
  /** `true` si el coste es aproximado (sin uso informado o tarifa generica). */
  readonly isEstimated: boolean;
}

/** Pagina del historial. Replica `TelemetryHistoryPageResponseDto`. */
export interface TelemetryHistoryPage {
  readonly items: TelemetryHistoryItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** Formatos de informe descargable. */
export type ReportFormat = 'csv' | 'pdf';
