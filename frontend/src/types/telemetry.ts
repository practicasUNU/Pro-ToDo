/**
 * Replica de los DTOs de `TelemetryController` del backend
 * (`backend/src/modules/telemetry/dto/telemetry-report-response.dto.ts` y
 * `telemetry-query.dto.ts`). Cualquier cambio alla hay que traerlo aqui.
 *
 * Fechas como `string` ISO: es lo que llega por JSON.
 */

import type {
  SortOrder,
  SortQuery,
  TelemetryBreakdownSortKey,
  TelemetryHistorySortKey,
} from '@/types/sort';

/** Filtros comunes de `/telemetry/*`. Replica `TelemetryQueryDto`. */
export interface TelemetryQuery {
  /** Inicio del rango (incluido), ISO 8601. */
  readonly from?: string;
  /** Fin del rango (excluido), ISO 8601. */
  readonly to?: string;
  readonly flowId?: string;
  readonly aiProvider?: string;
  readonly aiModel?: string;
  readonly nodeId?: string;
  /** Orden del desglose por modelo; sin el, del mas caro al mas barato. */
  readonly breakdownSortBy?: TelemetryBreakdownSortKey;
  readonly breakdownSortOrder?: SortOrder;
}

/** Filtros de las exportaciones. Replica `TelemetryExportQueryDto`. */
export interface TelemetryExportQuery extends TelemetryQuery, SortQuery<TelemetryHistorySortKey> {}

/** Filtros del historial paginado. Replica `TelemetryHistoryQueryDto`. */
export interface TelemetryHistoryQuery extends TelemetryExportQuery {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Filtros que el usuario elige en el informe, ademas del rango. Todos
 * opcionales: `undefined` es "sin filtrar".
 */
export interface TelemetryFilters {
  readonly aiProvider?: string;
  readonly aiModel?: string;
  readonly flowId?: string;
  readonly nodeId?: string;
}

/** Opciones de los selectores. Replica `TelemetryFilterOptionsResponseDto`. */
export interface TelemetryFilterOptions {
  readonly providers: string[];
  readonly models: { readonly aiProvider: string; readonly aiModel: string }[];
  readonly flows: { readonly id: string; readonly name: string }[];
  readonly nodes: { readonly flowId: string; readonly nodeId: string }[];
}

/** Resultado de una llamada de IA. Replica `AiCallStatus` (migracion 060). */
export enum AiCallStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
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
  /**
   * Ejecuciones concluidas (EXITOSO + FALLIDO + DESCARTADO) que invocaron al
   * menos un modelo de IA.
   */
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
  /** Llamadas SUCCESS / FAILED del modelo. */
  readonly succeeded: number;
  readonly failed: number;
  /** `succeeded / invocations`, entre 0 y 1; `null` sin llamadas. */
  readonly successRate: number | null;
}

/** Valores de `TelemetryOperationOrigin` del backend (migraciones 049 y 057). */
export enum TelemetryOperationOrigin {
  FLOW_EXECUTION = 'EJECUCION_FLUJO',
  PROMPT_OPTIMIZATION = 'PROMPT_OPTIMIZATION',
  /** Prueba individual de un nodo en el banco de pruebas: sin flujo. */
  NODE_SANDBOX = 'BANCO_PRUEBAS',
}

/** Etiqueta del origen, replica de `TELEMETRY_ORIGIN_LABELS` del backend. */
export const TELEMETRY_ORIGIN_LABELS: Readonly<Record<TelemetryOperationOrigin, string>> = {
  [TelemetryOperationOrigin.FLOW_EXECUTION]: 'Ejecución de flujo',
  [TelemetryOperationOrigin.PROMPT_OPTIMIZATION]: 'Optimización de prompt',
  [TelemetryOperationOrigin.NODE_SANDBOX]: 'Banco de pruebas',
};

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
  readonly status: AiCallStatus;
  /** Motivo del fallo; `null` en las llamadas exitosas. */
  readonly errorMessage: string | null;
  readonly userId: string | null;
  /** Correo del usuario al que se imputa la llamada. */
  readonly userEmail: string | null;
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
