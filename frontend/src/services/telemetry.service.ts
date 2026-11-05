import { api } from '@boot/axios';

import type {
  ModelBreakdownRow,
  TelemetryFilterOptions,
  TelemetryHistoryPage,
  TelemetryHistoryQuery,
  TelemetryQuery,
  TelemetrySummary,
} from '@/types/telemetry';

// Unica capa que conoce las rutas de lectura de `TelemetryController`. Devuelve
// la data ya desestructurada; los errores HTTP se propagan al store y de ahi al
// componente, que decide el mensaje.

/** Sin `/api`: ya esta en el `baseURL` de la instancia. */
const TELEMETRY_PATH = '/telemetry';

/** KPIs globales de coste, tokens y exito del rango. */
export const fetchSummary = async (query: TelemetryQuery = {}): Promise<TelemetrySummary> => {
  const { data } = await api.get<TelemetrySummary>(`${TELEMETRY_PATH}/summary`, {
    params: query,
  });

  return data;
};

/** Consumo y tasa de exito por proveedor y modelo, en el orden pedido. */
export const fetchBreakdownByModel = async (
  query: TelemetryQuery = {},
): Promise<ModelBreakdownRow[]> => {
  const { data } = await api.get<ModelBreakdownRow[]>(`${TELEMETRY_PATH}/breakdown-by-model`, {
    params: query,
  });

  return data;
};

/** Proveedores, modelos, flujos y nodos con telemetria en el rango. */
export const fetchFilterOptions = async (
  query: Pick<TelemetryQuery, 'from' | 'to'> = {},
): Promise<TelemetryFilterOptions> => {
  const { data } = await api.get<TelemetryFilterOptions>(`${TELEMETRY_PATH}/filter-options`, {
    params: query,
  });

  return data;
};

/** Inferencias registradas, mas recientes primero, paginadas. */
export const fetchHistory = async (
  query: TelemetryHistoryQuery = {},
): Promise<TelemetryHistoryPage> => {
  const { data } = await api.get<TelemetryHistoryPage>(`${TELEMETRY_PATH}/history`, {
    params: query,
  });

  return data;
};
