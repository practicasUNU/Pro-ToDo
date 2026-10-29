import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as reportsService from '@services/reports.service';
import * as telemetryService from '@services/telemetry.service';

import { defaultDateRange, toIsoRange } from '@/utils/date-range';
import { toSortQuery } from '@/utils/table-sort';

import type {
  ModelBreakdownRow,
  ReportFormat,
  TelemetryExportQuery,
  TelemetryFilterOptions,
  TelemetryFilters,
  TelemetryHistoryItem,
  TelemetryQuery,
  TelemetrySummary,
} from '@/types/telemetry';
import type { TableSort, TelemetryBreakdownSortKey, TelemetryHistorySortKey } from '@/types/sort';
import type { DateRangeInput } from '@/utils/date-range';

/** Filas por pagina del historial de consumos. */
export const DEFAULT_HISTORY_PAGE_SIZE = 25;

/** Opciones vacias: el estado antes de la primera carga. */
const EMPTY_FILTER_OPTIONS: TelemetryFilterOptions = {
  providers: [],
  models: [],
  flows: [],
  nodes: [],
};

// Estado del dashboard y de los informes de consumo de IA. Esta capa no conoce
// Axios ni rutas (frontend-architecture.md §2.1): invoca a los servicios y muta
// su estado con el resultado. Los errores NO se capturan aqui: el `finally`
// apaga los indicadores y la excepcion sube al componente, que decide el aviso.
export const useTelemetryStore = defineStore('telemetry', () => {
  /** Rango que edita el usuario, en fechas locales `YYYY-MM-DD`. */
  const dateRange = ref<DateRangeInput>(defaultDateRange());
  /** Proveedor, modelo, flujo y nodo elegidos; vacio es "sin filtrar". */
  const filters = ref<TelemetryFilters>({});
  /** Orden del desglose por modelo; `sortBy = null` es el del servidor (coste). */
  const breakdownSort = ref<TableSort<TelemetryBreakdownSortKey>>({
    sortBy: null,
    descending: true,
  });
  /** Valores que existen en la telemetria del rango, para los selectores. */
  const filterOptions = ref<TelemetryFilterOptions>(EMPTY_FILTER_OPTIONS);

  const summary = ref<TelemetrySummary | null>(null);
  const breakdown = ref<ModelBreakdownRow[]>([]);

  const historyItems = ref<TelemetryHistoryItem[]>([]);
  const historyTotal = ref(0);
  const historyLimit = ref(DEFAULT_HISTORY_PAGE_SIZE);
  const historyOffset = ref(0);
  /** Orden del historial ENTERO, resuelto en el servidor. */
  const historySort = ref<TableSort<TelemetryHistorySortKey>>({ sortBy: null, descending: false });

  const isLoading = ref(false);
  const isLoadingHistory = ref(false);
  /** Un indicador por formato: exportar CSV no debe bloquear el boton del PDF. */
  const exporting = ref<Record<ReportFormat, boolean>>({ csv: false, pdf: false });

  /** `false` si las fechas no forman un rango valido; la vista lo senala. */
  const isRangeValid = computed(() => toIsoRange(dateRange.value) !== null);

  /**
   * Filtros que viajan a la API: rango, selectores y orden del desglose. Sin
   * rango valido, el backend usa su defecto. Las claves vacias no se envian.
   */
  const query = computed<TelemetryQuery>(() => {
    const { sortBy, sortOrder } = toSortQuery(breakdownSort.value);

    return {
      ...(toIsoRange(dateRange.value) ?? {}),
      ...Object.fromEntries(
        Object.entries(filters.value).filter(([, value]) => value !== undefined && value !== ''),
      ),
      ...(sortBy !== undefined ? { breakdownSortBy: sortBy, breakdownSortOrder: sortOrder } : {}),
    };
  });

  /** Filtros de la exportacion: los del informe mas el orden del historial. */
  const exportQuery = computed<TelemetryExportQuery>(() => ({
    ...query.value,
    ...toSortQuery(historySort.value),
  }));

  /** Coste medio por invocacion, para la tarjeta del dashboard. */
  const averageCostUsd = computed<number | null>(() => {
    const current = summary.value;

    return current === null || current.aiInvocations === 0
      ? null
      : current.totalCostUsd / current.aiInvocations;
  });

  const setDateRange = (range: DateRangeInput): void => {
    dateRange.value = { ...range };
  };

  const setFilters = (next: TelemetryFilters): void => {
    filters.value = { ...next };
  };

  const setBreakdownSort = (next: TableSort<TelemetryBreakdownSortKey>): void => {
    breakdownSort.value = { ...next };
  };

  /** Opciones de los selectores para el rango vigente. */
  const loadFilterOptions = async (): Promise<void> => {
    filterOptions.value = await telemetryService.fetchFilterOptions(
      toIsoRange(dateRange.value) ?? {},
    );
  };

  /** KPIs y desglose por modelo del rango, en paralelo. */
  const loadDashboard = async (): Promise<void> => {
    isLoading.value = true;

    try {
      const [loadedSummary, loadedBreakdown] = await Promise.all([
        telemetryService.fetchSummary(query.value),
        telemetryService.fetchBreakdownByModel(query.value),
      ]);

      summary.value = loadedSummary;
      breakdown.value = loadedBreakdown;
    } finally {
      isLoading.value = false;
    }
  };

  /** Cambia el orden del historial. La pagina la decide quien recarga. */
  const setHistorySort = (next: TableSort<TelemetryHistorySortKey>): void => {
    historySort.value = { ...next };
  };

  /** Una pagina del historial de consumos. */
  const loadHistory = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
    isLoadingHistory.value = true;

    const limit = page.limit ?? historyLimit.value;
    const offset = page.offset ?? historyOffset.value;

    try {
      const loaded = await telemetryService.fetchHistory({
        ...query.value,
        ...toSortQuery(historySort.value),
        limit,
        offset,
      });

      historyItems.value = loaded.items;
      historyTotal.value = loaded.total;
      historyLimit.value = loaded.limit;
      historyOffset.value = loaded.offset;
    } finally {
      isLoadingHistory.value = false;
    }
  };

  /**
   * Bytes del informe con los filtros y el orden vigentes, para que el fichero
   * diga lo mismo que la pantalla. El store no los guarda en disco: eso toca
   * el DOM y lo hace el componente con `saveBlob`.
   */
  const exportReport = async (format: ReportFormat): Promise<Blob> => {
    exporting.value = { ...exporting.value, [format]: true };

    try {
      return format === 'csv'
        ? await reportsService.downloadCsv(exportQuery.value)
        : await reportsService.downloadPdf(exportQuery.value);
    } finally {
      exporting.value = { ...exporting.value, [format]: false };
    }
  };

  return {
    dateRange,
    filters,
    breakdownSort,
    filterOptions,
    summary,
    breakdown,
    historyItems,
    historyTotal,
    historyLimit,
    historyOffset,
    historySort,
    isLoading,
    isLoadingHistory,
    exporting,
    isRangeValid,
    query,
    exportQuery,
    averageCostUsd,
    setDateRange,
    setFilters,
    setBreakdownSort,
    loadFilterOptions,
    loadDashboard,
    setHistorySort,
    loadHistory,
    exportReport,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTelemetryStore, import.meta.hot));
}
