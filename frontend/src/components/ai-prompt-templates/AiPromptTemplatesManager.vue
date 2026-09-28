<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useQuasar } from 'quasar';

import { useAiPromptTemplatesStore } from '@stores/ai-prompt-templates.store';
import AiPromptTemplateDialog from '@components/ai-prompt-templates/AiPromptTemplateDialog.vue';
import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';

import { extractApiErrorMessage } from '@/utils/api-error';
import { formatDateTime } from '@/utils/date-format';

import type { AiPromptTemplate, AiPromptTemplateDetail } from '@/types/ai-prompt-template';
import type { QTableColumn } from 'quasar';

const $q = useQuasar();
const aiPromptTemplatesStore = useAiPromptTemplatesStore();

const columns: QTableColumn<AiPromptTemplate>[] = [
  { name: 'name', label: 'Nombre', field: 'name', align: 'left', sortable: true },
  { name: 'description', label: 'Descripcion', field: 'description', align: 'left' },
  { name: 'status', label: 'Estado', field: 'active', align: 'center', sortable: true },
  {
    name: 'createdAt',
    label: 'Fecha de Creacion',
    field: 'createdAt',
    align: 'left',
    sortable: true,
  },
  { name: 'actions', label: 'Acciones', field: 'id', align: 'center' },
];

// Termino de busqueda. Lo consume el `filterMethod` por defecto de QTable, que
// recorre los `field` de las columnas visibles.
//
// El tipo admite `null` porque el boton `clearable` de QInput escribe eso, no
// una cadena vacia (mismo criterio que en las demas tablas administrativas).
const filter = ref<string | null>('');

const isDialogOpen = ref(false);
const selectedPrompt = ref<AiPromptTemplateDetail | null>(null);

const isDeleteDialogOpen = ref(false);
const promptToDeactivate = ref<AiPromptTemplate | null>(null);

/**
 * Carga la tabla INCLUYENDO los retirados.
 *
 * El selector del nodo IA usara el defecto (solo activos); aqui hacen falta los
 * inactivos, porque reactivarlos es la unica via de vuelta tras un borrado
 * logico.
 */
const loadPrompts = async (): Promise<void> => {
  try {
    await aiPromptTemplatesStore.loadPrompts(false);
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar los prompts'),
    });
  }
};

const openCreateDialog = (): void => {
  selectedPrompt.value = null;
  isDialogOpen.value = true;
};

/**
 * Abre la edicion pidiendo antes el DETALLE.
 *
 * La fila de la tabla no trae `promptText` —el listado del backend lo omite—,
 * asi que abrir el dialogo con ella dejaria el textarea vacio y guardar borraria
 * la instruccion.
 */
const openEditDialog = async (prompt: AiPromptTemplate): Promise<void> => {
  try {
    selectedPrompt.value = await aiPromptTemplatesStore.loadPromptById(prompt.id);
    isDialogOpen.value = true;
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el prompt'),
    });
  }
};

// El argumento del evento se ignora a proposito: aqui el gestor ya tiene el
// listado a la vista y no necesita seleccionar nada.
const onPromptSaved = (): void => {
  $q.notify({ type: 'positive', message: 'Prompt guardado correctamente' });
};

const requestDeactivation = (prompt: AiPromptTemplate): void => {
  promptToDeactivate.value = prompt;
  isDeleteDialogOpen.value = true;
};

const confirmDeactivation = async (): Promise<void> => {
  if (!promptToDeactivate.value) return;

  try {
    await aiPromptTemplatesStore.deletePrompt(promptToDeactivate.value.id);
    $q.notify({ type: 'positive', message: 'Prompt retirado correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo retirar el prompt'),
    });
  } finally {
    promptToDeactivate.value = null;
  }
};

// Reactivar NO pasa por SafeDeleteModal: es reversible con un clic, y exigir
// cinco segundos para algo inofensivo entrena al operador a ignorar la espera
// justo donde si importa.
const activatePrompt = async (prompt: AiPromptTemplate): Promise<void> => {
  try {
    await aiPromptTemplatesStore.updatePrompt(prompt.id, { active: true });
    $q.notify({ type: 'positive', message: 'Prompt reactivado correctamente' });
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo reactivar el prompt'),
    });
  }
};

onMounted(loadPrompts);
</script>

<template>
  <q-page class="pd-page">
    <header class="prompts-header">
      <div>
        <h1 class="pd-h1">Prompts de IA</h1>
        <p class="pd-subtitle">
          Instrucciones reutilizables para el nodo Procesador de IA. El modelo que las ejecuta lo
          decide cada nodo, no el prompt.
        </p>
      </div>

      <q-btn
        class="pd-btn-primary"
        unelevated
        no-caps
        label="Nuevo Prompt"
        icon="add"
        icon-right="north_east"
        @click="openCreateDialog"
      />
    </header>

    <q-table
      class="pd-card pd-table"
      flat
      :rows="aiPromptTemplatesStore.prompts"
      :columns="columns"
      row-key="id"
      :loading="aiPromptTemplatesStore.isLoading"
      :filter="filter"
      no-data-label="Aun no hay prompts registrados"
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
          <span class="pd-mono">{{ cellProps.value }}</span>
          <q-tooltip anchor="top middle" self="bottom middle">
            <span class="pd-mono">{{ cellProps.row.id }}</span>
          </q-tooltip>
        </q-td>
      </template>

      <!-- La descripcion es nullable en la base de datos; sin este guion la
           celda quedaria vacia y pareceria un fallo de carga. -->
      <template #body-cell-description="cellProps">
        <q-td :props="cellProps">
          {{ cellProps.value ?? '—' }}
        </q-td>
      </template>

      <template #body-cell-status="cellProps">
        <q-td :props="cellProps">
          <q-badge
            class="pd-badge"
            :class="cellProps.row.active ? 'pd-badge--active' : 'pd-badge--inactive'"
          >
            {{ cellProps.row.active ? 'Activo' : 'Inactivo' }}
          </q-badge>
          <q-tooltip>
            {{
              cellProps.row.active
                ? 'Disponible en el selector del nodo de IA'
                : 'Retirado: no se puede seleccionar'
            }}
          </q-tooltip>
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
            :aria-label="`Editar ${cellProps.row.name}`"
            @click="openEditDialog(cellProps.row)"
          >
            <q-tooltip>Editar prompt</q-tooltip>
          </q-btn>

          <q-btn
            v-if="cellProps.row.active"
            class="pd-btn-icon pd-btn-icon--danger"
            outline
            dense
            size="sm"
            icon="block"
            :aria-label="`Retirar ${cellProps.row.name}`"
            @click="requestDeactivation(cellProps.row)"
          >
            <q-tooltip>Retirar prompt</q-tooltip>
          </q-btn>

          <q-btn
            v-else
            class="pd-btn-icon pd-btn-icon--positive"
            outline
            dense
            size="sm"
            icon="check_circle"
            :aria-label="`Reactivar ${cellProps.row.name}`"
            @click="activatePrompt(cellProps.row)"
          >
            <q-tooltip>Reactivar prompt</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <AiPromptTemplateDialog
      v-model="isDialogOpen"
      :prompt="selectedPrompt"
      @saved="onPromptSaved"
    />

    <!-- Cuenta regresiva de 5 segundos (CU-10). El modal se cierra solo; el
         anfitrion solo ejecuta la accion. -->
    <SafeDeleteModal
      v-model="isDeleteDialogOpen"
      title="Retirar prompt"
      :message="`¿Seguro que deseas retirar el prompt ${promptToDeactivate?.name ?? ''}? Los flujos que lo usen dejaran de poder seleccionarlo.`"
      confirm-label="Retirar"
      @confirm="confirmDeactivation"
    />
  </q-page>
</template>

<style scoped lang="scss">
.pd-page {
  margin: 1.75%;
}
// Solo maquetacion: el color proviene de las clases .pd-* globales.
.prompts-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}
</style>
