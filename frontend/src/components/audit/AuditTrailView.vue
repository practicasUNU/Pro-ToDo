<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useAuditStore } from '@stores/audit.store';
import { useUsersStore } from '@stores/users.store';

import { usePanelRefresh } from '@/composables/usePanelRefresh';

import AuditEventDetailsModal from '@components/audit/AuditEventDetailsModal.vue';
import AuditExportBar from '@components/audit/AuditExportBar.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import {
  AUDIT_ACTION_BADGES,
  AUDIT_ACTION_LABELS,
  AUDIT_TABLE_LABELS,
  changedKeys,
  labelAuditAction,
  labelAuditTable,
  toSelectOptions,
} from '@/utils/audit-display';
import { formatDateTime } from '@/utils/date-format';
import { sortRows } from '@/utils/table-sort';
import {
  datePickerBounds,
  defaultDateRange,
  isFutureDate,
  toIsoRange,
} from '@/utils/date-range';

import type { QTableColumn, QTableProps } from 'quasar';
import type { AuditActionValue, AuditEvent, AuditTableValue } from '@/types/audit';

/**
 * Historial de acciones humanas: filtros, tabla paginada en el servidor,
 * detalle JSON de cada evento y exportacion CSV/PDF de lo filtrado.
 *
 * Todos los filtros son `q-select` cerrados (Poka-Yoke): no hay texto libre
 * que pueda pedir una accion o una tabla que no existe. Se editan en una copia
 * local y se aplican con un boton, para no lanzar una consulta por cada cambio.
 */
const $q = useQuasar();
const auditStore = useAuditStore();
const usersStore = useUsersStore();

const ACTION_OPTIONS = toSelectOptions(AUDIT_ACTION_LABELS);
const TABLE_OPTIONS = toSelectOptions(AUDIT_TABLE_LABELS);

const userOptions = computed(() =>
  usersStore.users.map((user) => ({ label: user.email, value: user.id })),
);

// Copia local de los filtros: se vuelca al store al aplicar.
const userId = ref<string | null>(auditStore.filters.userId);
const action = ref<AuditActionValue | null>(auditStore.filters.action);
const affectedTable = ref<AuditTableValue | null>(auditStore.filters.affectedTable);
const from = ref(auditStore.dateRange.from);
const to = ref(auditStore.dateRange.to);

/**
 * Dias elegibles en el calendario: ni futuros ni mas antiguos que el historial.
 *
 * `q-date` entrega la fecha en su formato de barras, que es justo el que
 * devuelve `datePickerBounds`, asi que la comparacion es textual y no necesita
 * construir ningun `Date`.
 */
const { min: MIN_DATE, max: MAX_DATE } = datePickerBounds();

const isSelectableDate = (date: string): boolean => date >= MIN_DATE && date <= MAX_DATE;

/**
 * Mensaje de validacion compartido por los dos campos.
 *
 * Comprueba el futuro APARTE del rango invertido porque son dos errores
 * distintos y el operador necesita saber cual cometio. `q-date` ya impide
 * elegir manana con el raton, pero el campo se puede teclear y pegar.
 */
const rangeRule = (): true | string => {
  if (isFutureDate(from.value) || isFutureDate(to.value)) {
    return 'No se pueden consultar fechas futuras.';
  }

  return (
    toIsoRange({ from: from.value, to: to.value }) !== null ||
    'La fecha de inicio debe ser anterior o igual a la de fin.'
  );
};

const columns: QTableColumn<AuditEvent>[] = [
  {
    name: 'createdAt',
    label: 'Fecha',
    field: 'createdAt',
    align: 'left',
    sortable: true,
    format: (value: string) => formatDateTime(value),
  },
  {
    name: 'user',
    label: 'Usuario',
    field: (row) => row.userEmail ?? row.userId ?? '—',
    align: 'left',
    sortable: true,
  },
  { name: 'action', label: 'Acción', field: 'action', align: 'left', sortable: true },
  {
    name: 'affectedTable',
    label: 'Tabla',
    field: 'affectedTable',
    align: 'left',
    sortable: true,
    format: (value: string) => labelAuditTable(value),
  },
  {
    name: 'changes',
    label: 'Campos modificados',
    field: (row) => changedKeys(row.previousData, row.newData).join(', '),
    align: 'left',
    classes: 'pd-cell--long',
  },
  {
    name: 'sourceIp',
    label: 'IP',
    field: (row) => row.sourceIp ?? '—',
    align: 'left',
    sortable: true,
  },
  { name: 'details', label: 'Detalle', field: 'id', align: 'center' },
];

// Orden de la PAGINA CARGADA. La paginacion es del servidor, asi que en
// memoria solo estan estas filas: la cabecera reordena lo visible, no el
// historial entero.
const sortBy = ref<string | null>(null);
const descending = ref(false);

/**
 * Como leer el valor de las columnas cuyo `field` no es una clave de la fila.
 *
 * `user` e `sourceIp` pintan un guion cuando faltan, y ordenar por ese guion
 * mezclaria los huecos entre los valores reales en vez de mandarlos al final.
 */
const SORT_RESOLVERS = {
  user: (row: AuditEvent) => row.userEmail ?? row.userId,
  sourceIp: (row: AuditEvent) => row.sourceIp,
};

const sortedRows = computed(() =>
  sortRows(auditStore.items, sortBy.value, descending.value, SORT_RESOLVERS),
);

const pagination = computed(() => ({
  page: Math.floor(auditStore.offset / auditStore.limit) + 1,
  rowsPerPage: auditStore.limit,
  rowsNumber: auditStore.total,
  // Sin estos dos, QTable no pinta la flecha de la cabecera aunque la columna
  // sea `sortable` y el orden si se este aplicando. `null` y no `undefined`:
  // con `exactOptionalPropertyTypes` activo, el tipo de QTable admite el nulo
  // pero no la ausencia explicita.
  sortBy: sortBy.value,
  descending: descending.value,
}));

const isDetailsOpen = ref(false);
const selectedEvent = ref<AuditEvent | null>(null);

const openDetails = (event: AuditEvent): void => {
  selectedEvent.value = event;
  isDetailsOpen.value = true;
};

const loadPage = async (page: { limit?: number; offset?: number } = {}): Promise<void> => {
  try {
    await auditStore.loadPage(page);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el historial de auditoría.'),
    });
  }
};

/**
 * Paginacion server-side: QTable pide la pagina y el store la trae.
 *
 * El criterio de orden llega en el mismo evento y se guarda para el `computed`;
 * NO se manda al backend, que no admite `sortBy` (ver `utils/table-sort.ts`).
 * Tampoco se recarga por el: reordenar lo que ya esta en memoria no necesita
 * otro viaje.
 */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || auditStore.limit;

  sortBy.value = requested.sortBy ?? null;
  descending.value = requested.descending;

  void loadPage({ limit: rowsPerPage, offset: (requested.page - 1) * rowsPerPage });
};

const applyFilters = (): void => {
  if (rangeRule() !== true) return;

  auditStore.setDateRange({ from: from.value, to: to.value });
  auditStore.setFilters({
    userId: userId.value,
    action: action.value,
    affectedTable: affectedTable.value,
  });
  void loadPage({ offset: 0 });
};

const clearFilters = (): void => {
  userId.value = null;
  action.value = null;
  affectedTable.value = null;

  // El periodo tambien es un filtro, y el rotulo del boton lo promete. Se
  // devuelve al de partida en vez de vaciarlo porque la consulta exige las dos
  // fechas: en blanco daria un formulario invalido, no una vista limpia.
  const range = defaultDateRange();

  from.value = range.from;
  to.value = range.to;
  auditStore.setDateRange(range);

  auditStore.resetFilters();
  void loadPage({ offset: 0 });
};

onMounted(async () => {
  // La lista de usuarios alimenta el filtro. Si falla, la vista sigue siendo
  // util: solo se pierde ese filtro.
  if (usersStore.users.length === 0) {
    try {
      await usersStore.fetchUsers();
    } catch {
      // Sin usuarios, el selector queda vacio.
    }
  }

  await loadPage({ offset: 0 });
});

// El historial crece por su cuenta: cada mutacion auditada y cada inicio o
// cierre de sesion anaden una fila que el panel abierto no veria hasta que
// alguien recargase. Se recarga la pagina VIGENTE, con sus filtros, en vez de
// insertar la fila recibida: el orden y el total los decide el servidor, y
// anadirla a mano descuadraria la paginacion.
usePanelRefresh(() => loadPage(), { entities: ['audit_eventos'] });
</script>

<template>
  <div class="pd-audit-trail">
    <header class="pd-audit-trail__header">
      <div>
        <h1 class="pd-h1">Auditoría de acciones</h1>
        <p class="pd-subtitle pd-text-secondary">
          Inicios de sesión, cambios de rol y altas, modificaciones y bajas realizadas por personas.
        </p>
      </div>
      <AuditExportBar />
    </header>

    <section class="pd-card pd-audit-trail__filters" aria-label="Filtros de auditoría">
      <q-form class="pd-audit-trail__form" @submit.prevent="applyFilters">
        <q-select
          v-model="userId"
          dense
          outlined
          clearable
          emit-value
          map-options
          :options="userOptions"
          label="Usuario"
          data-test="audit-filter-user"
        />
        <q-select
          v-model="action"
          dense
          outlined
          clearable
          emit-value
          map-options
          :options="ACTION_OPTIONS"
          label="Acción"
          data-test="audit-filter-action"
        />
        <q-select
          v-model="affectedTable"
          dense
          outlined
          clearable
          emit-value
          map-options
          :options="TABLE_OPTIONS"
          label="Tabla"
          data-test="audit-filter-table"
        />
        <q-input
          v-model="from"
          dense
          outlined
          label="Desde"
          stack-label
          mask="####-##-##"
          :rules="[rangeRule]"
          data-test="audit-filter-from"
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
          data-test="audit-filter-to"
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
        <div class="pd-audit-trail__form-actions">
          <q-btn
            type="button"
            class="pd-btn-secondary"
            flat
            no-caps
            icon="filter_alt_off"
            label="Limpiar filtros"
            data-test="audit-filter-clear"
            @click="clearFilters"
          />
          <q-btn
            type="submit"
            class="pd-btn-primary"
            unelevated
            no-caps
            icon="filter_alt"
            label="Aplicar"
            data-test="audit-filter-apply"
          />
        </div>
      </q-form>
    </section>

    <q-table
      class="pd-card pd-table"
      flat
      title="Eventos registrados"
      :rows="sortedRows"
      :columns="columns"
      row-key="id"
      :loading="auditStore.isLoading"
      :pagination="pagination"
      :rows-per-page-options="[10, 25, 50, 100]"
      rows-per-page-label="Filas por página"
      no-data-label="No hay eventos de auditoría con estos filtros."
      @request="onRequest"
    >
      <template #body-cell-action="cellProps">
        <q-td :props="cellProps">
          <q-badge
            class="pd-badge"
            :class="AUDIT_ACTION_BADGES[cellProps.row.action as AuditActionValue]"
            :data-test="`audit-action-${cellProps.row.id}`"
          >
            {{ labelAuditAction(cellProps.row.action) }}
          </q-badge>
        </q-td>
      </template>

      <template #body-cell-sourceIp="cellProps">
        <q-td :props="cellProps">
          <span class="pd-mono">{{ cellProps.value }}</span>
        </q-td>
      </template>

      <template #body-cell-details="cellProps">
        <q-td :props="cellProps">
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="data_object"
            :aria-label="`Ver detalle del evento de ${formatDateTime(cellProps.row.createdAt)}`"
            :data-test="`audit-details-${cellProps.row.id}`"
            @click="openDetails(cellProps.row)"
          >
            <q-tooltip>Ver detalles</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <AuditEventDetailsModal v-model="isDetailsOpen" :event="selectedEvent" />
  </div>
</template>

<style scoped lang="scss">
.pd-audit-trail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pd-audit-trail__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.pd-audit-trail__filters {
  padding: 16px;
}

.pd-audit-trail__form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  align-items: start;
}

.pd-audit-trail__form-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  min-height: 40px;
}
</style>
