<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useAllowedIpsStore } from '@stores/allowed-ips.store';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import AllowedIpDialog from './AllowedIpDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';

import type { AllowedIp, UpdateAllowedIpPayload } from '@/types/allowed-ip';

const $q = useQuasar();
const allowedIpsStore = useAllowedIpsStore();

const isDialogOpen = ref(false);
const selectedEntry = ref<AllowedIp | null>(null);

// Cubre tanto la eliminacion como la confirmacion critica de una edicion:
// ambas son la misma pregunta ("¿aplicar este cambio de perimetro?") con
// distinto efecto al confirmar (ver `pendingAction`).
const isConfirmDialogOpen = ref(false);
const pendingAction = ref<
  | { type: 'delete'; entry: AllowedIp }
  | { type: 'update'; id: string; payload: UpdateAllowedIpPayload; ipOrCidr: string }
  | null
>(null);

const columns: QTableColumn<AllowedIp>[] = [
  { name: 'ipOrCidr', label: 'IP / Rango CIDR', field: 'ipOrCidr', align: 'left', sortable: true },
  {
    name: 'description',
    label: 'Descripcion',
    field: 'description',
    align: 'left',
    sortable: true,
  },
  {
    name: 'createdAt',
    label: 'Fecha de Registro',
    field: 'createdAt',
    align: 'left',
    sortable: true,
  },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadAllowedIps = async (): Promise<void> => {
  try {
    await allowedIpsStore.fetchAllowedIps();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar la lista blanca de IPs'),
    });
  }
};

const openCreateDialog = (): void => {
  selectedEntry.value = null;
  isDialogOpen.value = true;
};

const openEditDialog = (entry: AllowedIp): void => {
  selectedEntry.value = entry;
  isDialogOpen.value = true;
};

const onEntrySaved = (): void => {
  $q.notify({ type: 'positive', message: 'IP autorizada registrada correctamente' });
};

const onRequestUpdate = (request: { id: string; payload: UpdateAllowedIpPayload }): void => {
  pendingAction.value = {
    type: 'update',
    id: request.id,
    payload: request.payload,
    ipOrCidr: request.payload.ipOrCidr ?? '',
  };
  isConfirmDialogOpen.value = true;
};

const requestDelete = (entry: AllowedIp): void => {
  pendingAction.value = { type: 'delete', entry };
  isConfirmDialogOpen.value = true;
};

const confirmPendingAction = async (): Promise<void> => {
  const action = pendingAction.value;
  if (!action) return;

  try {
    if (action.type === 'delete') {
      await allowedIpsStore.deleteAllowedIp(action.entry.id);
      $q.notify({ type: 'positive', message: 'IP autorizada eliminada correctamente' });
    } else {
      await allowedIpsStore.updateAllowedIp(action.id, action.payload);
      $q.notify({ type: 'positive', message: 'IP autorizada actualizada correctamente' });
    }
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo aplicar el cambio sobre la IP autorizada'),
    });
  } finally {
    pendingAction.value = null;
  }
};

onMounted(loadAllowedIps);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="allowed-ips-header">
      <div>
        <h1 class="pd-h1">Lista Blanca de IPs</h1>
        <p class="pd-subtitle">
          Rangos CIDR e IPs autorizadas para acceder al perimetro corporativo (PROT-05).
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Agregar IP Autorizada"
        icon-right="north_east"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="allowedIpsStore.entries"
      :columns="columns"
      row-key="id"
      :loading="allowedIpsStore.isLoading"
    >
      <template #body-cell-ipOrCidr="cellProps">
        <q-td :props="cellProps">
          <span class="pd-mono">{{ cellProps.value }}</span>
        </q-td>
      </template>

      <template #body-cell-createdAt="cellProps">
        <q-td :props="cellProps">
          {{ formatDateTime(cellProps.value) }}
        </q-td>
      </template>

      <template #body-cell-actions="cellProps">
        <q-td :props="cellProps" class="q-gutter-x-xs">
          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="edit"
            :aria-label="`Editar ${cellProps.row.ipOrCidr}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Editar IP autorizada</q-tooltip>
          </q-btn>

          <q-btn
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="delete"
            :aria-label="`Eliminar ${cellProps.row.ipOrCidr}`"
            @click="requestDelete(cellProps.row)"
          >
            <q-tooltip>Eliminar IP autorizada</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <AllowedIpDialog
      v-model="isDialogOpen"
      :entry="selectedEntry"
      @saved="onEntrySaved"
      @request-update="onRequestUpdate"
    />

    <SafeDeleteModal
      v-model="isConfirmDialogOpen"
      :title="
        pendingAction?.type === 'delete' ? 'Eliminar IP autorizada' : 'Confirmar modificacion de IP'
      "
      :message="
        pendingAction?.type === 'delete'
          ? `¿Seguro que deseas eliminar ${pendingAction.entry.ipOrCidr}? Esta accion no se puede deshacer.`
          : `¿Seguro que deseas aplicar este cambio sobre ${pendingAction?.ipOrCidr ?? ''}? Puede abrir o cerrar el perimetro de acceso.`
      "
      :confirm-label="pendingAction?.type === 'delete' ? 'Eliminar' : 'Guardar cambios'"
      @confirm="confirmPendingAction"
    />
  </q-page>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.allowed-ips-header {
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
</style>
