import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import * as pricingService from '@services/pricing.service';

import { toIsoRange } from '@/utils/date-range';
import { toSortQuery } from '@/utils/table-sort';

import type { CreatePricingPayload, ModelPricing, PricingQuery } from '@/types/pricing';
import type { PricingSortKey, TableSort } from '@/types/sort';
import type { DateRangeInput } from '@/utils/date-range';

/** Filas por pagina del listado de tarifas. */
export const DEFAULT_PRICING_PAGE_SIZE = 25;

/** Filtros que elige el usuario. */
export interface PricingFilters {
  readonly search: string;
  /** Rango sobre `vigente_desde`. Vacio: todo el historial. */
  readonly dateRange: DateRangeInput;
  readonly activeOnly: boolean;
}

const EMPTY_FILTERS: PricingFilters = {
  search: '',
  dateRange: { from: '', to: '' },
  activeOnly: false,
};

// Tarifas de modelos de IA (ADMIN). Esta capa no conoce Axios ni rutas
// (frontend-architecture.md §2.1): invoca al servicio y muta su estado con el
// resultado. Los errores NO se capturan aqui: el `finally` apaga los
// indicadores y la excepcion sube al componente, que decide el aviso.
//
// Sin accion de baja ni de edicion en sitio, como el backend: "modificar" una
// tarifa es `createTariff` sobre el mismo par.
export const usePricingStore = defineStore('pricing', () => {
  const filters = ref<PricingFilters>({ ...EMPTY_FILTERS });
  const sort = ref<TableSort<PricingSortKey>>({ sortBy: null, descending: false });

  const items = ref<ModelPricing[]>([]);
  const total = ref(0);
  const limit = ref(DEFAULT_PRICING_PAGE_SIZE);
  const offset = ref(0);

  const isLoading = ref(false);
  const isSaving = ref(false);

  /** Rango incompleto o invertido: no se envia y el listado sale sin filtro de fechas. */
  const isRangeValid = computed(() => {
    const { from, to } = filters.value.dateRange;

    return (from === '' && to === '') || toIsoRange(filters.value.dateRange) !== null;
  });

  /** Parametros que viajan a la API. Lo vacio no viaja. */
  const query = computed<PricingQuery>(() => {
    const { search, dateRange, activeOnly } = filters.value;
    const trimmed = search.trim();
    const range = dateRange.from !== '' && dateRange.to !== '' ? toIsoRange(dateRange) : null;

    return {
      ...(trimmed !== '' ? { search: trimmed } : {}),
      ...(range ?? {}),
      ...(activeOnly ? { activeOnly: true } : {}),
      ...toSortQuery(sort.value),
    };
  });

  /** Cambia los filtros y vuelve a la primera pagina. */
  const setFilters = (patch: Partial<PricingFilters>): void => {
    filters.value = { ...filters.value, ...patch };
    offset.value = 0;
  };

  /** Cambia el orden. La pagina la decide quien recarga (QTable vuelve a la 1). */
  const setSort = (next: TableSort<PricingSortKey>): void => {
    sort.value = { ...next };
  };

  const resetFilters = (): void => {
    filters.value = { ...EMPTY_FILTERS };
    offset.value = 0;
  };

  /** Una pagina del listado con los filtros y el orden actuales. */
  const loadPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
    isLoading.value = true;

    try {
      const loaded = await pricingService.fetchPricing({
        ...query.value,
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
   * Registra la tarifa vigente de un par y recarga la pagina actual: el relevo
   * cambia DOS filas (la nueva y la que pasa a historico), asi que parchear
   * solo la nueva dejaria la anterior marcada como activa en pantalla.
   */
  const createTariff = async (payload: CreatePricingPayload): Promise<ModelPricing> => {
    isSaving.value = true;

    try {
      const created = await pricingService.createPricing(payload);
      await loadPage();

      return created;
    } finally {
      isSaving.value = false;
    }
  };

  return {
    filters,
    sort,
    items,
    total,
    limit,
    offset,
    isLoading,
    isSaving,
    isRangeValid,
    query,
    setFilters,
    setSort,
    resetFilters,
    loadPage,
    createTariff,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePricingStore, import.meta.hot));
}
