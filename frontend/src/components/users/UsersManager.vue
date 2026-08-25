<template>
  <q-page padding class="pd-page">
    <q-table
      class="pd-card pd-table"
      flat
      title="Gestion de Usuarios"
      :rows="usersStore.users"
      :columns="columns"
      row-key="id"
      :loading="usersStore.isLoading"
    >
      <template #top-right>
        <q-btn color="primary" icon="add" label="Nuevo usuario" no-caps @click="openCreateDialog" />
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge" :color="cellProps.row.isActive ? 'positive' : 'negative'">
            {{ cellProps.row.isActive ? 'Activo' : 'Inactivo' }}
          </q-badge>
        </q-td>
      </template>

      <template #body-cell-actions="cellProps">
        <q-td :props="cellProps" class="q-gutter-x-sm">
          <q-btn
            dense
            flat
            round
            icon="edit"
            color="primary"
            @click="openEditDialog(cellProps.row)"
          />
          <q-btn
            v-if="cellProps.row.isActive"
            dense
            flat
            round
            icon="block"
            color="negative"
            @click="requestDeactivation(cellProps.row)"
          />
          <q-btn
            v-else
            dense
            flat
            round
            icon="check_circle"
            color="positive"
            @click="activateUser(cellProps.row)"
          />
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

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useUsersStore } from '@stores/users.store';

import type { User } from '@/types/user';

import UserDialog from './UserDialog.vue';
import SafeDeleteModal from './SafeDeleteModal.vue';

const $q = useQuasar();
const usersStore = useUsersStore();

const isDialogOpen = ref(false);
const selectedUser = ref<User | null>(null);

const isDeleteDialogOpen = ref(false);
const userToDeactivate = ref<User | null>(null);

const columns: QTableColumn[] = [
  { name: 'id', label: 'ID', field: 'id', align: 'left' },
  { name: 'email', label: 'Correo', field: 'email', align: 'left', sortable: true },
  { name: 'role', label: 'Rol', field: 'role', align: 'left', sortable: true },
  { name: 'status', label: 'Estado', field: 'isActive', align: 'center' },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadUsers = async (): Promise<void> => {
  try {
    await usersStore.fetchUsers();
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo cargar la lista de usuarios' });
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
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo desactivar al usuario' });
  } finally {
    userToDeactivate.value = null;
  }
};

const activateUser = async (user: User): Promise<void> => {
  try {
    await usersStore.updateUser(user.id, { isActive: true });
    $q.notify({ type: 'positive', message: 'Usuario activado correctamente' });
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo activar al usuario' });
  }
};

onMounted(loadUsers);
</script>
