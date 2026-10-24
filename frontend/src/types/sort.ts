/**
 * Contrato del orden en servidor. Replica `SortOrder` y los decoradores
 * `@SortByField` / `@SortOrderField` del backend
 * (`backend/src/common/utils/sort-whitelist.util.ts`).
 */

/** Sentido del orden tal como lo espera la API. */
export type SortOrder = 'ASC' | 'DESC';

/** Parametros de orden que viajan en la query string. */
export interface SortQuery<K extends string> {
  readonly sortBy?: K;
  readonly sortOrder?: SortOrder;
}

/**
 * Orden que la tabla tiene seleccionado. `sortBy = null` es "sin criterio": el
 * backend aplica su orden por defecto (lo mas reciente primero).
 */
export interface TableSort<K extends string> {
  readonly sortBy: K | null;
  readonly descending: boolean;
}

/** Claves de orden de `GET /api/executions` (`EXECUTION_SORT_COLUMNS`). */
export const EXECUTION_SORT_KEYS = ['state', 'startedAt', 'updatedAt'] as const;
export type ExecutionSortKey = (typeof EXECUTION_SORT_KEYS)[number];

/** Claves de orden de `GET /api/telemetry/history` (`TELEMETRY_HISTORY_SORT_COLUMNS`). */
export const TELEMETRY_HISTORY_SORT_KEYS = [
  'createdAt',
  'flow',
  'nodeId',
  'aiProvider',
  'aiModel',
  'totalTokens',
  'estimatedCostUsd',
] as const;
export type TelemetryHistorySortKey = (typeof TELEMETRY_HISTORY_SORT_KEYS)[number];

/** Claves de orden de `GET /api/audit/events` (`AUDIT_SORT_COLUMNS`). */
export const AUDIT_SORT_KEYS = [
  'createdAt',
  'user',
  'action',
  'affectedTable',
  'sourceIp',
] as const;
export type AuditSortKey = (typeof AUDIT_SORT_KEYS)[number];

/** Claves de orden de `GET /api/pricing` (`PRICING_SORT_COLUMNS`). */
export const PRICING_SORT_KEYS = [
  'aiProvider',
  'aiModel',
  'promptRateUsdPerMTok',
  'completionRateUsdPerMTok',
  'reasoningRateUsdPerMTok',
  'validFrom',
  'active',
] as const;
export type PricingSortKey = (typeof PRICING_SORT_KEYS)[number];
