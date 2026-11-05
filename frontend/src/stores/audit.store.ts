import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as auditService from '@services/audit.service';

import { defaultDateRange, toIsoRange } from '@/utils/date-range';
import { toSortQuery } from '@/utils/table-sort';

import type {
  AuditActionValue,
  AuditEvent,
  AuditEventsFilter,
  AuditReportFormat,
  AuditTableValue,
} from '@/types/audit';
import type { AuditSortKey, TableSort } from '@/types/sort';
import type { DateRangeInput } from '@/utils/date-range';

/** Filas por pagina del historial de auditoria. */
export const DEFAULT_AUDIT_PAGE_SIZE = 25;

/** Filtros que elige el usuario, ademas del rango de fechas. */
export interface AuditFilters {
  readonly userId: string | null;
  readonly action: AuditActionValue | null;
  readonly affectedTable: AuditTableValue | null;
}

const EMPTY_FILTERS: AuditFilters = { userId: null, action: null, affectedTable: null };

// Estado de la pagina de auditoria. Esta capa no conoce Axios ni rutas
// (frontend-architecture.md §2.1): invoca al servicio y muta su estado con el
// resultado. Los errores NO se capturan aqui: el `finally` apaga los
// indicadores y la excepcion sube al componente, que decide el aviso.
export const useAuditStore = defineStore('audit', () => {
  const dateRange = ref<DateRangeInput>(defaultDateRange());
  const filters = ref<AuditFilters>({ ...EMPTY_FILTERS });

  const items = ref<AuditEvent[]>([]);
  const total = ref(0);
  const limit = ref(DEFAULT_AUDIT_PAGE_SIZE);
  const offset = ref(0);
  /** Orden del historial ENTERO, resuelto en el servidor. */
  const sort = ref<TableSort<AuditSortKey>>({ sortBy: null, descending: false });

  const isLoading = ref(false);
  /** Un indicador por formato: exportar CSV no debe bloquear el boton del PDF. */
  const exporting = ref<Record<AuditReportFormat, boolean>>({ csv: false, pdf: false });

  const isRangeValid = computed(() => toIsoRange(dateRange.value) !== null);

  /**
   * Filtros que viajan a la API. Los `null` no viajan (el backend los
   * rechazaria como valor), y sin rango valido manda el defecto del backend.
   */
  const query = computed<AuditEventsFilter>(() => {
    const { userId, action, affectedTable } = filters.value;

    return {
      ...(toIsoRange(dateRange.value) ?? {}),
      ...(userId !== null ? { userId } : {}),
      ...(action !== null ? { action } : {}),
      ...(affectedTable !== null ? { affectedTable } : {}),
    };
  });

  const setDateRange = (range: DateRangeInput): void => {
    dateRange.value = { ...range };
  };

  /** Cambia los filtros y vuelve a la primera pagina. */
  const setFilters = (patch: Partial<AuditFilters>): void => {
    filters.value = { ...filters.value, ...patch };
    offset.value = 0;
  };

  /** Cambia el orden. La pagina la decide quien recarga (QTable vuelve a la 1). */
  const setSort = (next: TableSort<AuditSortKey>): void => {
    sort.value = { ...next };
  };

  const resetFilters = (): void => {
    filters.value = { ...EMPTY_FILTERS };
    offset.value = 0;
  };

  /** Una pagina del historial con los filtros actuales. */
  const loadPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
    isLoading.value = true;

    try {
      const loaded = await auditService.fetchAuditEvents({
        ...query.value,
        ...toSortQuery(sort.value),
        limit: page.limit ?? limit.value,
        offset: page.offset ?? offset.value,
      });

      items.value = loaded.items;
      total.value = loaded.total;
      limit.value = loaded.limit;
      offset.value = loaded.offset;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Bytes del informe con los filtros actuales. El store no los guarda en
   * disco: eso toca el DOM y lo hace el componente con `saveBlob`.
   */
  const exportReport = async (format: AuditReportFormat): Promise<Blob> => {
    exporting.value = { ...exporting.value, [format]: true };

    try {
      return await auditService.downloadAuditReport(format, query.value);
    } finally {
      exporting.value = { ...exporting.value, [format]: false };
    }
  };

  return {
    dateRange,
    filters,
    items,
    total,
    limit,
    offset,
    sort,
    isLoading,
    exporting,
    isRangeValid,
    query,
    setDateRange,
    setFilters,
    setSort,
    resetFilters,
    loadPage,
    exportReport,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAuditStore, import.meta.hot));
}
