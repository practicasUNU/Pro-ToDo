import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as fsmExecutionsService from '@services/fsm-executions.service';

import { toSortQuery } from '@/utils/table-sort';

import { ExecutionState } from '@/types/execution';

import type { ExecutionSummary, ExecutionUpdatedEvent } from '@/types/execution';
import type { ExecutionSortKey, TableSort } from '@/types/sort';

/** Filas por pagina del historial de ejecuciones. */
export const DEFAULT_EXECUTIONS_PAGE_SIZE = 10;

/**
 * Espera antes de recargar la pagina tras un evento de socket. Agrupa la rafaga
 * de una ejecucion que arranca y termina en milisegundos en una sola peticion.
 */
export const EXECUTIONS_REFRESH_DEBOUNCE_MS = 500;

/**
 * Estados que traen datos que el evento no lleva (`hasAlerts`, `failureReason`,
 * `logFilePath`): la fila se parchea al instante y despues se relee.
 */
const STATES_NEEDING_RELOAD: ReadonlySet<ExecutionState> = new Set([
  ExecutionState.PAUSADO,
  ExecutionState.FALLIDO,
  ExecutionState.EXITOSO,
  ExecutionState.OMITIDO,
  ExecutionState.DESCARTADO,
]);

/** Filtros del historial. Ausente = sin filtrar. */
export interface ExecutionHistoryFilters {
  readonly state?: ExecutionState;
  readonly flowId?: string;
  /** Rango de fecha de inicio, en fechas locales `YYYY-MM-DD`. */
  readonly from?: string;
  readonly to?: string;
}

// Historial paginado de ejecuciones para el dashboard. Distinto de
// `useExecutionStore`, que sigue UNA ejecucion en vivo por socket para el
// canvas: aqui solo se lee el listado, pagina a pagina.
//
// Reutiliza `fsm-executions.service.ts`, que ya es la unica capa que conoce
// `/executions`: un segundo servicio para la misma ruta serian dos sitios que
// actualizar cuando cambie.
export const useExecutionsStore = defineStore('executions', () => {
  const items = ref<ExecutionSummary[]>([]);
  const total = ref(0);
  const limit = ref(DEFAULT_EXECUTIONS_PAGE_SIZE);
  const offset = ref(0);
  const filters = ref<ExecutionHistoryFilters>({});
  /** Orden del historial ENTERO, resuelto en el servidor. */
  const sort = ref<TableSort<ExecutionSortKey>>({ sortBy: null, descending: false });
  const isLoading = ref(false);
  /** Descarga del CSV en curso: deshabilita el boton para no pedirla dos veces. */
  const isExporting = ref(false);
  /** El historial se ha cargado alguna vez: sin el, un evento no pide nada. */
  const hasLoaded = ref(false);
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const setFilters = (next: ExecutionHistoryFilters): void => {
    filters.value = { ...next };
    // Cambiar de filtro con la pagina 7 abierta mostraria una pagina vacia.
    offset.value = 0;
  };

  /** Cambia el orden. La pagina la decide quien recarga (QTable vuelve a la 1). */
  const setSort = (next: TableSort<ExecutionSortKey>): void => {
    sort.value = { ...next };
  };

  /** Pagina pedida (o la actual) con los filtros y el orden vigentes. */
  const fetchPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
    isLoading.value = true;

    try {
      const loaded = await fsmExecutionsService.fetchExecutions({
        ...filters.value,
        ...toSortQuery(sort.value),
        limit: page.limit ?? limit.value,
        offset: page.offset ?? offset.value,
      });

      items.value = loaded.items;
      total.value = loaded.total;
      limit.value = loaded.limit;
      offset.value = loaded.offset;
      hasLoaded.value = true;
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Bytes del historial en CSV con los filtros APLICADOS y el orden vigente,
   * para que el fichero diga lo mismo que la tabla. Nunca la pagina: el informe
   * trae todas las filas que cumplen el filtro (hasta el techo del backend).
   *
   * Lee `filters` y no el borrador del formulario: un filtro tecleado pero sin
   * "Aplicar" no esta en pantalla y tampoco debe estar en el fichero. El store
   * no guarda los bytes en disco: eso toca el DOM y lo hace el componente.
   */
  const exportHistory = async (): Promise<Blob> => {
    isExporting.value = true;

    try {
      return await fsmExecutionsService.downloadExecutionsCsv({
        ...filters.value,
        ...toSortQuery(sort.value),
      });
    } finally {
      isExporting.value = false;
    }
  };

  /** Relee la pagina vigente una sola vez por rafaga de eventos. */
  const scheduleRefresh = (): void => {
    if (refreshTimer !== null) clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      // Un fallo de red aqui no tiene a quien avisar: la tabla conserva la fila
      // ya parcheada y la siguiente carga manual la corrige.
      fetchPage().catch(() => undefined);
    }, EXECUTIONS_REFRESH_DEBOUNCE_MS);
  };

  /**
   * Aplica un `execution:updated` del socket sin esperar a un F5.
   *
   * - Fila visible: se parchea estado y cursor al instante (inmutable), y si el
   *   estado trae datos que el evento no lleva o la saca del filtro, se relee.
   * - Fila no visible en la primera pagina: es una ejecucion nueva o reanudada
   *   que deberia aparecer arriba; se relee la pagina.
   * - En otra pagina, o con un filtro de flujo distinto, no se hace nada: el
   *   operador esta mirando otra cosa y recolocar las filas le moveria la vista.
   */
  const applyExecutionUpdate = (event: ExecutionUpdatedEvent): void => {
    if (!hasLoaded.value) return;
    if (filters.value.flowId !== undefined && filters.value.flowId !== event.flowId) return;

    const index = items.value.findIndex((item) => item.executionId === event.executionId);

    if (index === -1) {
      if (offset.value === 0) scheduleRefresh();
      return;
    }

    items.value = items.value.map((item, position) =>
      position === index
        ? {
            ...item,
            state: event.state,
            activeCursor: event.activeCursor,
            updatedAt: event.emittedAt,
          }
        : item,
    );

    const leavesFilter = filters.value.state !== undefined && filters.value.state !== event.state;

    if (leavesFilter || STATES_NEEDING_RELOAD.has(event.state)) scheduleRefresh();
  };

  return {
    items,
    total,
    limit,
    offset,
    filters,
    sort,
    isLoading,
    isExporting,
    setFilters,
    setSort,
    fetchPage,
    exportHistory,
    applyExecutionUpdate,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useExecutionsStore, import.meta.hot));
}
