<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { usePricingStore } from '@stores/pricing.store';

import { usePanelRefresh } from '@/composables/usePanelRefresh';

import AuditDetailsMenu from '@components/shared/AuditDetailsMenu.vue';
import StatusBadge from '@components/shared/StatusBadge.vue';
import WarningModal from '@components/shared/WarningModal.vue';

import PricingDialog from './PricingDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';
import { datePickerBounds, isFutureDate, toIsoRange } from '@/utils/date-range';
import { formatUsd } from '@/utils/number-format';
import { toTableSort } from '@/utils/table-sort';
import { describeEnabled } from '@/utils/status-display';
import { MAX_PRICING_SEARCH_LENGTH } from '@/types/pricing';
import { PRICING_SORT_KEYS } from '@/types/sort';

import type { QTableColumn, QTableProps } from 'quasar';
import type { CreatePricingPayload, ModelPricing } from '@/types/pricing';

/**
 * Tarifas de modelos de IA (ADMIN).
 *
 * Todo se resuelve en el SERVIDOR: busqueda, rango de vigencia, paginacion y
 * orden. La tabla es un historial y crece con cada relevo; filtrar en cliente
 * solo veria la pagina cargada.
 *
 * No hay boton de desactivar ni de borrar, a proposito: una tarifa solo deja
 * de estar vigente cuando otra la releva (`PricingService.create`). Un par sin
 * tarifa haria que todo su coste pasara a "estimado".
 */
const $q = useQuasar();
const pricingStore = usePricingStore();

const isDialogOpen = ref(false);
const dialogBase = ref<ModelPricing | null>(null);

const isWarningOpen = ref(false);
const pendingPayload = ref<CreatePricingPayload | null>(null);

const search = ref<string | null>(pricingStore.filters.search);
const from = ref(pricingStore.filters.dateRange.from);
const to = ref(pricingStore.filters.dateRange.to);

/** Tope del calendario: hoy. Una tarifa no puede haber entrado en vigor manana. */
const { max: MAX_DATE } = datePickerBounds();

const isSelectableDate = (date: string): boolean => date <= MAX_DATE;

/**
 * Validacion del rango: vacio es valido (todo el historial); a medias o
 * invertido no. El futuro se comprueba aparte porque `q-date` lo bloquea con
 * el raton, pero el campo se puede teclear y pegar.
 */
const rangeRule = (): true | string => {
  if (isFutureDate(from.value) || isFutureDate(to.value)) {
    return 'No se pueden consultar fechas futuras.';
  }

  if (from.value === '' && to.value === '') return true;

  if (from.value === '' || to.value === '') return 'Indica las dos fechas o ninguna.';

  return (
    toIsoRange({ from: from.value, to: to.value }) !== null ||
    'La fecha de inicio debe ser anterior o igual a la de fin.'
  );
};

const columns: QTableColumn<ModelPricing>[] = [
  { name: 'aiProvider', label: 'Proveedor', field: 'aiProvider', align: 'left', sortable: true },
  { name: 'aiModel', label: 'Modelo', field: 'aiModel', align: 'left', sortable: true },
  {
    name: 'promptRateUsdPerMTok',
    label: 'Entrada (USD/M)',
    field: 'promptRateUsdPerMTok',
    align: 'right',
    sortable: true,
    format: (value: number) => formatUsd(value),
  },
  {
    name: 'completionRateUsdPerMTok',
    label: 'Salida (USD/M)',
    field: 'completionRateUsdPerMTok',
    align: 'right',
    sortable: true,
    format: (value: number) => formatUsd(value),
  },
  {
    name: 'reasoningRateUsdPerMTok',
    label: 'Razonamiento (USD/M)',
    field: 'reasoningRateUsdPerMTok',
    align: 'right',
    sortable: true,
    format: (value: number) => formatUsd(value),
  },
  {
    name: 'validFrom',
    label: 'Vigente desde',
    field: 'validFrom',
    align: 'left',
    sortable: true,
    format: (value: string) => formatDateTime(value),
  },
  { name: 'active', label: 'Estado', field: 'active', align: 'left', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

/**
 * Paginacion de la tabla, con el STORE como unica fuente de verdad.
 *
 * Escribible y ligada con `v-model:pagination` y no con `:pagination` a secas:
 * Quasar solo fusiona esta prop en su estado interno cuando existe un listener
 * `onUpdate:pagination`. Sin el, la prop valia como valor INICIAL y nada mas, de
 * modo que a partir del primer repintado la cabecera llevaba su propio
 * `sortBy`/`descending` y el store llevaba el de la consulta: dos estados que
 * divergian, y la flecha acababa senalando un orden que los datos no tenian.
 *
 * El `set` solo recoge el criterio de orden. La pagina la sigue pidiendo
 * `onRequest`, y el `get` la refleja cuando el store ya tiene la respuesta.
 */
const pagination = computed<NonNullable<QTableProps['pagination']>>({
  get: () => ({
    page: Math.floor(pricingStore.offset / pricingStore.limit) + 1,
    rowsPerPage: pricingStore.limit,
    rowsNumber: pricingStore.total,
    sortBy: pricingStore.sort.sortBy,
    descending: pricingStore.sort.descending,
  }),
  set: (next) => {
    pricingStore.setSort(toTableSort(PRICING_SORT_KEYS, next.sortBy, next.descending ?? false));
  },
});

/** Tarifa vigente del par pendiente, para el resumen del aviso. */
const supersededTariff = computed(() => {
  const payload = pendingPayload.value;

  if (payload === null) return null;

  // La fila trae el proveedor como texto plano y el formulario como enum.
  const provider: string = payload.aiProvider;

  return (
    pricingStore.items.find(
      (row) => row.active && row.aiProvider === provider && row.aiModel === payload.aiModel,
    ) ?? null
  );
});

const loadPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
  try {
    await pricingStore.loadPage(page);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las tarifas.'),
    });
  }
};

/** Paginacion y orden en servidor: QTable pide la pagina y el store la trae. */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || pricingStore.limit;

  pricingStore.setSort(toTableSort(PRICING_SORT_KEYS, requested.sortBy, requested.descending));

  void loadPage({ limit: rowsPerPage, offset: (requested.page - 1) * rowsPerPage });
};

/** Buscador en tiempo real: el `debounce` del campo evita una consulta por tecla. */
const onSearch = (value: string | number | null): void => {
  pricingStore.setFilters({ search: String(value ?? '').slice(0, MAX_PRICING_SEARCH_LENGTH) });
  void loadPage({ offset: 0 });
};

const onActiveOnlyChange = (value: boolean): void => {
  pricingStore.setFilters({ activeOnly: value });
  void loadPage({ offset: 0 });
};

const applyDateRange = (): void => {
  if (rangeRule() !== true) return;

  pricingStore.setFilters({ dateRange: { from: from.value, to: to.value } });
  void loadPage({ offset: 0 });
};

const clearFilters = (): void => {
  search.value = '';
  from.value = '';
  to.value = '';
  pricingStore.resetFilters();
  void loadPage({ offset: 0 });
};

const openCreateDialog = (): void => {
  dialogBase.value = null;
  isDialogOpen.value = true;
};

const openUpdateDialog = (row: ModelPricing): void => {
  dialogBase.value = row;
  isDialogOpen.value = true;
};

/** El formulario NO guarda: pasa por el aviso de 5 s antes de llegar al store. */
const onRequestSave = (payload: CreatePricingPayload): void => {
  pendingPayload.value = payload;
  isWarningOpen.value = true;
};

const confirmSave = async (): Promise<void> => {
  const payload = pendingPayload.value;
  if (payload === null) return;

  try {
    await pricingStore.createTariff(payload);
    $q.notify({
      type: 'positive',
      message: `Tarifa de ${payload.aiProvider} / ${payload.aiModel} registrada como vigente.`,
    });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo registrar la tarifa.'),
    });
  } finally {
    pendingPayload.value = null;
  }
};

const onWarningCancel = (): void => {
  pendingPayload.value = null;
};

// Otro ADMIN registro una tarifa: se recarga la pagina con los filtros
// actuales para que nadie decida sobre una vigente que ya no lo es.
usePanelRefresh(() => pricingStore.loadPage(), { onPricingUpdated: true });

onMounted(() => {
  void loadPage({ offset: 0 });
});
</script>

<template>
  <q-page padding class="pd-page">
    <header class="pd-pricing__header">
      <div>
        <h1 class="pd-h1">Tarifas de modelos IA</h1>
        <p class="pd-subtitle pd-text-secondary">
          Precio en USD por millón de tokens. Cada tarifa nueva releva a la vigente del mismo
          modelo, que pasa a histórico.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nueva tarifa"
        icon-right="north_east"
        data-test="pricing-create"
        @click="openCreateDialog"
      />
    </header>

    <section class="pd-card pd-pricing__filters" aria-label="Filtros de tarifas">
      <q-form class="pd-pricing__form" @submit.prevent="applyDateRange">
        <q-input
          v-model="from"
          dense
          outlined
          label="Vigente desde"
          stack-label
          mask="####-##-##"
          :rules="[rangeRule]"
          data-test="pricing-filter-from"
        >
          <template #append>
            <q-icon name="event" class="cursor-pointer">
              <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                <q-date
                  v-model="from"
                  mask="YYYY-MM-DD"
                  class="pd-date-popup"
                  :options="isSelectableDate"
                >
                  <div class="row items-center justify-end">
                    <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
                  </div>
                </q-date>
              </q-popup-proxy>
            </q-icon>
          </template>
        </q-input>
        <q-input
          v-model="to"
          dense
          outlined
          label="Hasta"
          stack-label
          mask="####-##-##"
          :rules="[rangeRule]"
          data-test="pricing-filter-to"
        >
          <template #append>
            <q-icon name="event" class="cursor-pointer">
              <q-popup-proxy cover transition-show="scale" transition-hide="scale">
                <q-date
                  v-model="to"
                  mask="YYYY-MM-DD"
                  class="pd-date-popup"
                  :options="isSelectableDate"
                >
                  <div class="row items-center justify-end">
                    <q-btn v-close-popup flat no-caps label="Cerrar" class="pd-btn-secondary" />
                  </div>
                </q-date>
              </q-popup-proxy>
            </q-icon>
          </template>
        </q-input>

        <q-toggle
          :model-value="pricingStore.filters.activeOnly"
          label="Solo vigentes"
          data-test="pricing-filter-active"
          @update:model-value="onActiveOnlyChange"
        />

        <div class="pd-pricing__actions">
          <q-btn
            flat
            no-caps
            label="Limpiar filtros"
            class="pd-btn-secondary"
            data-test="pricing-filter-clear"
            @click="clearFilters"
          />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            type="submit"
            label="Aplicar fechas"
            data-test="pricing-filter-apply"
          />
        </div>
      </q-form>
    </section>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="pricingStore.items"
      :columns="columns"
      row-key="id"
      :loading="pricingStore.isLoading"
      v-model:pagination="pagination"
      :rows-per-page-options="[10, 25, 50, 100]"
      rows-per-page-label="Filas por página"
      no-data-label="No hay tarifas que cumplan el filtro."
      @request="onRequest"
    >
      <template #top-right>
        <q-input
          v-model="search"
          dense
          outlined
          clearable
          debounce="300"
          :maxlength="MAX_PRICING_SEARCH_LENGTH"
          placeholder="Buscar proveedor o modelo..."
          class="pd-search-input"
          aria-label="Buscar tarifas por proveedor o modelo"
          data-test="pricing-search"
          @update:model-value="onSearch"
        >
          <template #append>
            <q-icon name="search" />
          </template>
        </q-input>
      </template>

      <template #body-cell-aiModel="cellProps">
        <q-td :props="cellProps">
          <span class="pd-mono">{{ cellProps.value }}</span>
        </q-td>
      </template>

      <template #body-cell-active="cellProps">
        <q-td :props="cellProps">
          <status-badge
            :display="describeEnabled(cellProps.row.active, { on: 'Vigente', off: 'Histórico' })"
          />
        </q-td>
      </template>

      <template #body-cell-actions="cellProps">
        <q-td :props="cellProps" class="q-gutter-x-xs">
          <!-- Solo sobre la vigente: el historico no se edita, y no existe
               accion de desactivar. -->
          <q-btn
            v-if="cellProps.row.active"
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="mdi-cash-sync"
            :aria-label="`Actualizar tarifa de ${cellProps.row.aiModel}`"
            :data-test="`pricing-update-${cellProps.row.id}`"
            @click="openUpdateDialog(cellProps.row)"
          >
            <q-tooltip>Registrar nueva tarifa para este modelo</q-tooltip>
          </q-btn>

          <AuditDetailsMenu
            :audit="cellProps.row"
            :subject="`${cellProps.row.aiProvider} / ${cellProps.row.aiModel}`"
          />
        </q-td>
      </template>
    </q-table>

    <PricingDialog v-model="isDialogOpen" :base="dialogBase" @request-save="onRequestSave" />

    <WarningModal
      v-model="isWarningOpen"
      title="Confirmar nueva tarifa"
      message="La tarifa se aplicará a todas las inferencias a partir de ahora. Si el modelo ya tiene una vigente, pasará a histórico."
      confirm-label="Registrar tarifa"
      @confirm="confirmSave"
      @cancel="onWarningCancel"
    >
      <dl v-if="pendingPayload" class="pd-pricing__summary" data-test="pricing-summary">
        <dt class="pd-label">Modelo</dt>
        <dd class="pd-mono">{{ pendingPayload.aiProvider }} / {{ pendingPayload.aiModel }}</dd>
        <dt class="pd-label">Entrada / Salida / Razonamiento</dt>
        <dd>
          {{ formatUsd(pendingPayload.promptRateUsdPerMTok) }} ·
          {{ formatUsd(pendingPayload.completionRateUsdPerMTok) }} ·
          {{ formatUsd(pendingPayload.reasoningRateUsdPerMTok) }}
        </dd>
        <template v-if="supersededTariff">
          <dt class="pd-label">Vigente que pasa a histórico</dt>
          <dd>
            {{ formatUsd(supersededTariff.promptRateUsdPerMTok) }} ·
            {{ formatUsd(supersededTariff.completionRateUsdPerMTok) }} ·
            {{ formatUsd(supersededTariff.reasoningRateUsdPerMTok) }}
          </dd>
        </template>
      </dl>
    </WarningModal>
  </q-page>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.pd-pricing__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.pd-subtitle {
  margin: 4px 0 0;
}

.pd-pricing__filters {
  padding: 16px;
  margin-bottom: 16px;
}

.pd-pricing__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  align-items: start;
}

.pd-pricing__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.pd-pricing__summary {
  margin: 0;

  dd {
    margin: 2px 0 10px;
  }
}
</style>
