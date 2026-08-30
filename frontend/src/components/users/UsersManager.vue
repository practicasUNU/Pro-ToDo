<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useUsersStore } from '@stores/users.store';

import UserDialog from './UserDialog.vue';
import SafeDeleteModal from './SafeDeleteModal.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { deriveDisplayName, roleDisplayLabel, roleIconName } from '@/utils/user-display';

import type { User, UserRole } from '@/types/user';

const $q = useQuasar();
const usersStore = useUsersStore();

const isDialogOpen = ref(false);
const selectedUser = ref<User | null>(null);

const isDeleteDialogOpen = ref(false);
const userToDeactivate = ref<User | null>(null);

// El id tecnico (UUID) no ocupa columna propia: se expone en el tooltip del
// nombre para no romper la legibilidad de la tabla.
const columns: QTableColumn<User>[] = [
  {
    name: 'name',
    label: 'Nombre',
    field: (row: User) => deriveDisplayName(row.email),
    align: 'left',
    sortable: true,
  },
  { name: 'email', label: 'Correo Corporativo', field: 'email', align: 'left', sortable: true },
  { name: 'role', label: 'Rol', field: 'role', align: 'left', sortable: true },
  { name: 'status', label: 'Estado', field: 'isActive', align: 'center', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadUsers = async (): Promise<void> => {
  try {
    await usersStore.fetchUsers();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar la lista de usuarios'),
    });
  }
};

const openCreateDialog = (): void => {
  selectedUser.value = null;
  isDialogOpen.value = true;
};

const openEditDialog = (user: User): void => {
  selectedUser.value = user;
  isDialogOpen.value = true;
};

const onUserSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Usuario guardado correctamente' });
};

const requestDeactivation = (user: User): void => {
  userToDeactivate.value = user;
  isDeleteDialogOpen.value = true;
};

const confirmDeactivation = async (): Promise<void> => {
  if (!userToDeactivate.value) return;

  try {
    await usersStore.deactivateUser(userToDeactivate.value.id);
    $q.notify({ type: 'positive', message: 'Usuario desactivado correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo desactivar al usuario'),
    });
  } finally {
    userToDeactivate.value = null;
  }
};

const activateUser = async (user: User): Promise<void> => {
  try {
    await usersStore.updateUser(user.id, { isActive: true });
    $q.notify({ type: 'positive', message: 'Usuario activado correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo activar al usuario'),
    });
  }
};

onMounted(loadUsers);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="users-header">
      <div>
        <h1 class="pd-h1">Gestion de Usuarios</h1>
        <p class="pd-subtitle">
          Alta, edicion y baja logica de cuentas con acceso a Proto-Do.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nuevo Usuario"
        icon-right="north_east"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="usersStore.users"
      :columns="columns"
      row-key="id"
      :loading="usersStore.isLoading"
    >
      <template #body-cell-name="cellProps">
        <q-td :props="cellProps">
          {{ cellProps.value }}
          <q-tooltip anchor="top middle" self="bottom middle">
            <span class="pd-mono">{{ cellProps.row.id }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-email="cellProps">
        <q-td :props="cellProps">
          <span class="pd-mono">{{ cellProps.value }}</span>
        </q-td>
      </template>

      <template #body-cell-role="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge pd-badge--role">
            <q-icon
              :name="roleIconName(cellProps.row.role as UserRole)"
              size="14px"
              class="q-mr-xs"
            />
            {{ roleDisplayLabel(cellProps.row.role as UserRole) }}
          </q-badge>
        </q-td>
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-badge
            class="pd-badge"
            :class="cellProps.row.isActive ? 'pd-badge--active' : 'pd-badge--inactive'"
          >
            {{ cellProps.row.isActive ? 'Activo' : 'Inactivo' }}
          </q-badge>
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
            :aria-label="`Editar ${cellProps.row.email}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Editar usuario</q-tooltip>
          </q-btn>

          <q-btn
            v-if="cellProps.row.isActive"
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Desactivar ${cellProps.row.email}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Desactivar usuario</q-tooltip>
          </q-btn>

          <q-btn
            v-else
            class="pd-btn-icon pd-btn-icon--positive"
            outline
            dense
            size="sm"
            icon="check_circle"
            :aria-label="`Activar ${cellProps.row.email}`"
            @click="activateUser(cellProps.row)"
          >
            <q-tooltip>Reactivar usuario</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <UserDialog v-model="isDialogOpen" :user="selectedUser" @saved="onUserSaved" />

    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Desactivar usuario"
      :message="`¿Seguro que deseas desactivar a ${userToDeactivate?.email ?? ''}?`"
      confirm-label="Desactivar"
      @confirm="confirmDeactivation"
    />
  </q-page>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.users-header {
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
