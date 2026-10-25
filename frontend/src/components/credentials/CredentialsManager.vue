<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useCredentialsStore } from '@stores/credentials.store';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import CredentialDialog from './CredentialDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';

import { CREDENTIAL_AUTH_TYPE_LABELS } from '@/types/credential';

import type { Credential, CredentialAuthType } from '@/types/credential';

const $q = useQuasar();
const credentialsStore = useCredentialsStore();

const isDialogOpen = ref(false);
const selectedCredential = ref<Credential | null>(null);

const isDeleteDialogOpen = ref(false);
const credentialToDelete = ref<Credential | null>(null);

// `null` porque el boton `clearable` de QInput escribe eso, no cadena vacia.
const filter = ref<string | null>('');

const columns: QTableColumn<Credential>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  {
    name: 'authType',
    label: 'Tipo',
    field: (row: Credential) => CREDENTIAL_AUTH_TYPE_LABELS[row.authType],
    align: 'left',
    sortable: true,
  },
  {
    name: 'updatedAt',
    label: 'Ultima rotacion',
    field: 'updatedAt',
    format: (value: string) => formatDateTime(value),
    align: 'left',
    sortable: true,
  },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadCredentials = async (): Promise<void> => {
  try {
    await credentialsStore.fetchCredentials();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar la boveda de credenciales'),
    });
  }
};

const openCreateDialog = (): void => {
  selectedCredential.value = null;
  isDialogOpen.value = true;
};

const openEditDialog = (credential: Credential): void => {
  selectedCredential.value = credential;
  isDialogOpen.value = true;
};

const onCredentialSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Credencial guardada correctamente' });
};

const requestDeletion = (credential: Credential): void => {
  credentialToDelete.value = credential;
  isDeleteDialogOpen.value = true;
};

const confirmDeletion = async (): Promise<void> => {
  if (credentialToDelete.value === null) return;

  try {
    await credentialsStore.deleteCredential(credentialToDelete.value.id);
    $q.notify({ type: 'positive', message: 'Credencial eliminada' });
  } catch (error) {
    // El 409 explica que flujo la sigue usando: se muestra tal cual.
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo eliminar la credencial'),
    });
  } finally {
    credentialToDelete.value = null;
  }
};

onMounted(loadCredentials);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="credentials-header">
      <div>
        <h1 class="pd-h1">Boveda de Credenciales</h1>
        <p class="pd-subtitle">
          Secretos cifrados (AES-256-GCM) para los nodos de destino HTTP. Nunca se muestran una vez
          guardados.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nueva Credencial"
        icon-right="north_east"
        data-test="new-credential"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="credentialsStore.credentials"
      :columns="columns"
      row-key="id"
      :loading="credentialsStore.isLoading"
      :filter="filter"
      no-data-label="Aun no hay credenciales en la boveda"
      no-results-label="Ningun resultado para la busqueda"
    >
      <template #top-right>
        <q-input
          v-model="filter"
          dense
          outlined
          clearable
          debounce="300"
          placeholder="Buscar..."
          class="pd-search-input"
          aria-label="Filtrar la tabla"
        >
          <template #append>
            <q-icon name="search" />
          </template>
        </q-input>
      </template>

      <template #body-cell-name="cellProps">
        <q-td :props="cellProps">
          {{ cellProps.value }}
          <q-tooltip anchor="top middle" self="bottom middle">
            <span class="pd-mono">{{ cellProps.row.id }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-authType="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge pd-badge--role">
            {{ CREDENTIAL_AUTH_TYPE_LABELS[cellProps.row.authType as CredentialAuthType] }}
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
            :aria-label="`Editar ${cellProps.row.name}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Renombrar o rotar el secreto</q-tooltip>
          </q-btn>

          <q-btn
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="delete"
            :aria-label="`Eliminar ${cellProps.row.name}`"
            @click="requestDeletion(cellProps.row)"
          >
            <q-tooltip>Eliminar credencial</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <CredentialDialog
      v-model="isDialogOpen"
      :credential="selectedCredential"
      @saved="onCredentialSaved"
    />

    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Eliminar credencial"
      :message="`¿Seguro que deseas eliminar «${credentialToDelete?.name ?? ''}»? Su secreto se borrara de forma irreversible.`"
      confirm-label="Eliminar"
      @confirm="confirmDeletion"
    />
  </q-page>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.credentials-header {
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
