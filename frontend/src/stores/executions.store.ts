import { defineStore, acceptHMRUpdate } from 'pinia';
import { ref } from 'vue';

import * as fsmExecutionsService from '@services/fsm-executions.service';

import { toSortQuery } from '@/utils/table-sort';

import type { ExecutionState, ExecutionSummary } from '@/types/execution';
import type { ExecutionSortKey, TableSort } from '@/types/sort';

/** Filas por pagina del historial de ejecuciones. */
export const DEFAULT_EXECUTIONS_PAGE_SIZE = 10;

/** Filtros del historial. Ausente = sin filtrar. */
export interface ExecutionHistoryFilters {
  readonly state?: ExecutionState;
  readonly flowId?: string;
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
    } finally {
      isLoading.value = false;
    }
  };

  return {
    items,
    total,
    limit,
    offset,
    filters,
    sort,
    isLoading,
    setFilters,
    setSort,
    fetchPage,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useExecutionsStore, import.meta.hot));
}
