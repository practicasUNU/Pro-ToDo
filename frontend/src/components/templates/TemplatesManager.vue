<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import { useTemplatesStore } from '@stores/templates.store';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import TemplateEditorDialog from './TemplateEditorDialog.vue';
import TemplatePreviewDialog from './TemplatePreviewDialog.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { HtmlTemplate } from '@/types/html-template';

const $q = useQuasar();
const templatesStore = useTemplatesStore();

const isEditorOpen = ref(false);
const isPreviewOpen = ref(false);
const isDeleteDialogOpen = ref(false);

const editedTemplate = ref<HtmlTemplate | null>(null);
const previewedTemplate = ref<HtmlTemplate | null>(null);
const templateToDeactivate = ref<HtmlTemplate | null>(null);

// El UUID no ocupa columna propia: se expone en el tooltip del nombre para no
// romper la legibilidad de la tabla, igual que en UsersManager.
// Termino de busqueda. Lo consume el `filterMethod` por defecto de QTable, que
// recorre los `field` de las columnas visibles.
//
// El tipo admite `null` porque el boton `clearable` de QInput escribe eso, no
// una cadena vacia. QTable declara su prop `filter` como `any`, asi que el
// compilador no delataria la mentira: mas vale que el ref diga la verdad.
const filter = ref<string | null>('');

const columns: QTableColumn<HtmlTemplate>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  {
    name: 'description',
    label: 'Descripcion',
    field: (row: HtmlTemplate) => row.description ?? '—',
    align: 'left',
  },
  {
    name: 'variables',
    label: 'Variables',
    field: (row: HtmlTemplate) => row.requiredVariables.length,
    align: 'center',
    sortable: true,
  },
  { name: 'status', label: 'Estado', field: 'active', align: 'center', sortable: true },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

const loadTemplates = async (): Promise<void> => {
  try {
    await templatesStore.fetchTemplates();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el catalogo de plantillas'),
    });
  }
};

const openCreateDialog = (): void => {
  editedTemplate.value = null;
  isEditorOpen.value = true;
};

const openEditDialog = (template: HtmlTemplate): void => {
  editedTemplate.value = template;
  isEditorOpen.value = true;
};

const openPreviewDialog = (template: HtmlTemplate): void => {
  previewedTemplate.value = template;
  isPreviewOpen.value = true;
};

const onTemplateSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Plantilla guardada correctamente' });
};

const requestDeactivation = (template: HtmlTemplate): void => {
  templateToDeactivate.value = template;
  isDeleteDialogOpen.value = true;
};

const confirmDeactivation = async (): Promise<void> => {
  if (!templateToDeactivate.value) return;

  try {
    await templatesStore.deactivateTemplate(templateToDeactivate.value.id);
    $q.notify({ type: 'positive', message: 'Plantilla desactivada correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo desactivar la plantilla'),
    });
  } finally {
    templateToDeactivate.value = null;
  }
};

onMounted(loadTemplates);
</script>

<template>
  <q-page padding class="pd-page">
    <header class="templates-header">
      <div>
        <h1 class="pd-h1">Catalogo de Plantillas</h1>
        <p class="pd-subtitle">
          Plantillas HTML reutilizables entre flujos. Sus variables se validan al guardar.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nueva Plantilla"
        icon-right="north_east"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="templatesStore.templates"
      :columns="columns"
      row-key="id"
      :loading="templatesStore.isLoading"
      :filter="filter"
      no-results-label="Ningun resultado para la busqueda"
      no-data-label="Aun no hay plantillas registradas"
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

      <template #body-cell-variables="cellProps">
        <q-td :props="cellProps">
          <q-badge class="pd-badge pd-badge--role">
            {{ cellProps.value }}
          </q-badge>
          <q-tooltip v-if="cellProps.row.requiredVariables.length > 0">
            <span class="pd-mono">{{ cellProps.row.requiredVariables.join(', ') }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-badge
            class="pd-badge"
            :class="cellProps.row.active ? 'pd-badge--active' : 'pd-badge--inactive'"
          >
            {{ cellProps.row.active ? 'Activa' : 'Inactiva' }}
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
            icon="visibility"
            :aria-label="`Previsualizar ${cellProps.row.name}`"
            @click="openPreviewDialog(cellProps.row)"
          >
            <q-tooltip>Previsualizar</q-tooltip>
          </q-btn>

          <q-btn
            class="pd-btn-icon"
            outline
            dense
            size="sm"
            icon="edit"
            :aria-label="`Editar ${cellProps.row.name}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Editar plantilla</q-tooltip>
          </q-btn>

          <q-btn
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Desactivar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Desactivar plantilla</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <TemplateEditorDialog
      v-model="isEditorOpen"
      :template="editedTemplate"
      @saved="onTemplateSaved"
    />

    <TemplatePreviewDialog v-model="isPreviewOpen" :template="previewedTemplate" />

    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Desactivar plantilla"
      :message="`¿Seguro que deseas desactivar la plantilla ${templateToDeactivate?.name ?? ''}? Los flujos que la usen quedaran PAUSADOS al ejecutarse.`"
      confirm-label="Desactivar"
      @confirm="confirmDeactivation"
    />
  </q-page>
</template>

<style scoped lang="scss">
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.templates-header {
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
