import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as reportsService from '@services/reports.service';
import * as telemetryService from '@services/telemetry.service';

import { defaultDateRange, toIsoRange } from '@/utils/date-range';

import type {
  ModelBreakdownRow,
  ReportFormat,
  TelemetryHistoryItem,
  TelemetryQuery,
  TelemetrySummary,
} from '@/types/telemetry';
import type { DateRangeInput } from '@/utils/date-range';

/** Filas por pagina del historial de consumos. */
export const DEFAULT_HISTORY_PAGE_SIZE = 25;

// Estado del dashboard y de los informes de consumo de IA. Esta capa no conoce
// Axios ni rutas (frontend-architecture.md §2.1): invoca a los servicios y muta
// su estado con el resultado. Los errores NO se capturan aqui: el `finally`
// apaga los indicadores y la excepcion sube al componente, que decide el aviso.
export const useTelemetryStore = defineStore('telemetry', () => {
  /** Rango que edita el usuario, en fechas locales `YYYY-MM-DD`. */
  const dateRange = ref<DateRangeInput>(defaultDateRange());

  const summary = ref<TelemetrySummary | null>(null);
  const breakdown = ref<ModelBreakdownRow[]>([]);

  const historyItems = ref<TelemetryHistoryItem[]>([]);
  const historyTotal = ref(0);
  const historyLimit = ref(DEFAULT_HISTORY_PAGE_SIZE);
  const historyOffset = ref(0);

  const isLoading = ref(false);
  const isLoadingHistory = ref(false);
  /** Un indicador por formato: exportar CSV no debe bloquear el boton del PDF. */
  const exporting = ref<Record<ReportFormat, boolean>>({ csv: false, pdf: false });

  /** `false` si las fechas no forman un rango valido; la vista lo senala. */
  const isRangeValid = computed(() => toIsoRange(dateRange.value) !== null);

  /** Filtros que viajan a la API. Sin rango valido, el backend usa su defecto. */
  const query = computed<TelemetryQuery>(() => toIsoRange(dateRange.value) ?? {});

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

  /** Una pagina del historial de consumos. */
  const loadHistory = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
    isLoadingHistory.value = true;

    const limit = page.limit ?? historyLimit.value;
    const offset = page.offset ?? historyOffset.value;

    try {
      const loaded = await telemetryService.fetchHistory({ ...query.value, limit, offset });

      historyItems.value = loaded.items;
      historyTotal.value = loaded.total;
      historyLimit.value = loaded.limit;
      historyOffset.value = loaded.offset;
    } finally {
      isLoadingHistory.value = false;
    }
  };

  /**
   * Bytes del informe del rango actual. El store no los guarda en disco: eso
   * toca el DOM y lo hace el componente con `saveBlob`.
   */
  const exportReport = async (format: ReportFormat): Promise<Blob> => {
    exporting.value = { ...exporting.value, [format]: true };

    try {
      return format === 'csv'
        ? await reportsService.downloadCsv(query.value)
        : await reportsService.downloadPdf(query.value);
    } finally {
      exporting.value = { ...exporting.value, [format]: false };
    }
  };

  return {
    dateRange,
    summary,
    breakdown,
    historyItems,
    historyTotal,
    historyLimit,
    historyOffset,
    isLoading,
    isLoadingHistory,
    exporting,
    isRangeValid,
    query,
    averageCostUsd,
    setDateRange,
    loadDashboard,
    loadHistory,
    exportReport,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTelemetryStore, import.meta.hot));
}
