<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useAuditStore } from '@stores/audit.store';
import { useUsersStore } from '@stores/users.store';

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
import { toIsoRange } from '@/utils/date-range';

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

const rangeRule = (): true | string =>
  toIsoRange({ from: from.value, to: to.value }) !== null ||
  'La fecha de inicio debe ser anterior o igual a la de fin.';

const columns: QTableColumn<AuditEvent>[] = [
  {
    name: 'createdAt',
    label: 'Fecha',
    field: 'createdAt',
    align: 'left',
    format: (value: string) => formatDateTime(value),
  },
  {
    name: 'user',
    label: 'Usuario',
    field: (row) => row.userEmail ?? row.userId ?? '—',
    align: 'left',
  },
  { name: 'action', label: 'Acción', field: 'action', align: 'left' },
  {
    name: 'affectedTable',
    label: 'Tabla',
    field: 'affectedTable',
    align: 'left',
    format: (value: string) => labelAuditTable(value),
  },
  {
    name: 'changes',
    label: 'Campos modificados',
    field: (row) => changedKeys(row.previousData, row.newData).join(', '),
    align: 'left',
    classes: 'pd-cell--long',
  },
  { name: 'sourceIp', label: 'IP', field: (row) => row.sourceIp ?? '—', align: 'left' },
  { name: 'details', label: 'Detalle', field: 'id', align: 'center' },
];

const pagination = computed(() => ({
  page: Math.floor(auditStore.offset / auditStore.limit) + 1,
  rowsPerPage: auditStore.limit,
  rowsNumber: auditStore.total,
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

/** Paginacion server-side: QTable pide la pagina y el store la trae. */
const onRequest: QTableProps['onRequest'] = ({ pagination: requested }) => {
  const rowsPerPage = requested.rowsPerPage || auditStore.limit;

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
          type="date"
          dense
          outlined
          label="Desde"
          stack-label
          :rules="[rangeRule]"
          data-test="audit-filter-from"
        />
        <q-input
          v-model="to"
          type="date"
          dense
          outlined
          label="Hasta"
          stack-label
          :rules="[rangeRule]"
          data-test="audit-filter-to"
        />
        <div class="pd-audit-trail__form-actions">
          <q-btn
            type="button"
            class="pd-btn-secondary"
            flat
            no-caps
            label="Limpiar"
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
      :rows="auditStore.items"
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
