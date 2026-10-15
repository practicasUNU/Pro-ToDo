<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';

import NodeInspectionPanel from '@components/canvas/NodeInspectionPanel.vue';
import TopologyCanvas from '@components/canvas/TopologyCanvas.vue';
import { useCanvasStore } from '@stores/canvas.store';
import { ExecutionState } from '@/types/execution';

const route = useRoute();
const router = useRouter();
const canvasStore = useCanvasStore();
const $q = useQuasar();

const flowId = computed<string>(() => String(route.params.id));

/**
 * Distintivo del estado GENERAL del flujo.
 *
 * `INACTIVO` no es un estado persistido aqui: es como se presenta la ausencia
 * de ejecucion viva, que para el operador significa lo mismo —no hay nada
 * ocurriendo— y evita una caja vacia sin explicacion.
 */
const stateBadge = computed<{ readonly color: string; readonly label: string }>(() => {
  switch (canvasStore.executionState) {
    case ExecutionState.EN_PROCESO:
      return { color: 'info', label: 'EN PROCESO' };
    case ExecutionState.PAUSADO:
      return { color: 'warning', label: 'PAUSADO' };
    default:
      return { color: 'grey-6', label: 'INACTIVO' };
  }
});

const loadCanvas = async (): Promise<void> => {
  try {
    await canvasStore.loadCanvas(flowId.value);
  } catch (error: unknown) {
    $q.notify({
      type: 'negative',
      icon: 'error',
      message: 'No se pudo cargar el flujo',
      caption: error instanceof Error ? error.message : 'Error desconocido',
    });
  }
};

onMounted(async () => {
  await loadCanvas();
  // La sala se ocupa DESPUES de la carga: unirse antes dejaria entrar eventos
  // que encenderian cajas sobre una topologia que aun no existe.
  await canvasStore.observeFlow(flowId.value);
});

onBeforeUnmount(() => {
  // Sin `await`: el desmontaje no puede esperar a un acuse del servidor, y el
  // store ya tolera que la baja de sala se resuelva despues.
  void canvasStore.stopObserving(flowId.value);
});
</script>

<template>
  <q-page class="pd-page">
    <div class="q-pa-md">
      <q-breadcrumbs class="q-mb-sm">
        <q-breadcrumbs-el label="Flujos" icon="account_tree" to="/flujos" />
        <q-breadcrumbs-el :label="canvasStore.workflow?.name ?? 'Cargando...'" />
      </q-breadcrumbs>

      <div class="row items-center no-wrap q-gutter-sm">
        <div class="col">
          <h1 class="pd-h1 q-my-none">
            {{ canvasStore.workflow?.name ?? 'Supervision de flujo' }}
          </h1>
          <div class="pd-text-secondary">
            {{ canvasStore.workflow?.description ?? 'Vista de topologia en solo lectura.' }}
          </div>
        </div>

        <q-badge :color="stateBadge.color" class="pd-badge">{{ stateBadge.label }}</q-badge>

        <q-btn
          flat
          round
          dense
          icon="refresh"
          class="pd-btn-icon"
          :loading="canvasStore.isLoading"
          @click="loadCanvas"
        >
          <q-tooltip>Refrescar</q-tooltip>
        </q-btn>

        <q-btn
          flat
          class="pd-btn-secondary"
          icon="arrow_back"
          label="Volver"
          @click="router.push('/flujos')"
        />
      </div>
    </div>

    <q-inner-loading :showing="canvasStore.isLoading">
      <q-spinner-dots size="48px" color="primary" />
    </q-inner-loading>

    <TopologyCanvas v-if="!canvasStore.isLoading" />

    <NodeInspectionPanel />
  </q-page>
</template>
