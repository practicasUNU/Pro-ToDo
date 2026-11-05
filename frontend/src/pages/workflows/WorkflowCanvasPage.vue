<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';

import NodeInspectionPanel from '@components/canvas/NodeInspectionPanel.vue';
import TopologyCanvas from '@components/canvas/TopologyCanvas.vue';
import StatusBadge from '@components/shared/StatusBadge.vue';
import { useCanvasStore } from '@stores/canvas.store';
import { describeExecutionState } from '@/utils/execution-state-display';
import { describeWorkflowStatus } from '@/utils/status-display';
import { ExecutionState } from '@/types/execution';
import { WorkflowStatus } from '@/types/pipeline';

import type { StatusDisplay } from '@/utils/status-display';

const route = useRoute();
const router = useRouter();
const canvasStore = useCanvasStore();
const $q = useQuasar();

const flowId = computed<string>(() => String(route.params.id));

/**
 * Se llego aqui desde "Elegir paso en el Canvas" (CU-09 extendido).
 *
 * Solo gobierna un AVISO. Los botones de cada tarjeta dependen del estado real
 * de la ejecucion y no de esta bandera: condicionarlos a la query esconderia la
 * accion a quien abriera el canvas por su cuenta teniendo delante una ejecucion
 * detenida, que es el mismo caso con otra forma de llegar.
 */
const isResumeMode = computed<boolean>(() => route.query.resume === 'true' && canvasStore.isPaused);

/**
 * Distintivo del estado GENERAL del flujo.
 *
 * CRUZA DOS FUENTES, y hacerlo es el arreglo. Antes se derivaba solo de
 * `executionState`, que sale de una ejecucion VIVA: un flujo ACTIVO a la espera
 * de su disparador no tiene ninguna, caia en el `default` y se pintaba
 * "INACTIVO" —es decir, la vista decia que estaba apagado un flujo que estaba
 * armado y escuchando—. El estado del flujo ya viaja en `WorkflowDetail`, que
 * extiende `PipelineSummary`, asi que no hizo falta tocar el backend.
 *
 * EL ORDEN DE LAS RAMAS ES LA REGLA, no una casualidad. Lo que ocurre AHORA
 * manda sobre lo que el flujo es en general: una ejecucion en curso se anuncia
 * aunque la fila diga ACTIVO, y una detenida aunque el flujo ya se haya
 * reactivado. Solo cuando no hay nada en vuelo se describe el flujo en si.
 *
 * `spinner` acompana al texto en vez de sustituirlo: el badge dice QUE pasa y
 * el spinner que sigue pasando ahora mismo. Mismo criterio que las tarjetas del
 * canvas, y la razon es la misma —el color nunca viaja solo—.
 */
const stateBadge = computed<{
  readonly display: StatusDisplay;
  readonly spinner: boolean;
}>(() => {
  if (canvasStore.executionState === ExecutionState.EN_PROCESO) {
    return { display: describeExecutionState(ExecutionState.EN_PROCESO), spinner: true };
  }

  if (
    canvasStore.executionState === ExecutionState.PAUSADO ||
    canvasStore.workflow?.status === WorkflowStatus.PAUSADO
  ) {
    return { display: describeWorkflowStatus(WorkflowStatus.PAUSADO), spinner: false };
  }

  // Desenlace de la ejecucion que se acaba de ver correr. Va ANTES del estado
  // del flujo porque es la respuesta a lo que el operador estaba mirando: sin
  // esta rama, un flujo que terminaba bien y se autodesactivaba saltaba de "En
  // ejecucion" a "Inactivo" sin decir nunca que habia salido bien.
  if (canvasStore.executionState === ExecutionState.EXITOSO) {
    return { display: describeExecutionState(ExecutionState.EXITOSO), spinner: false };
  }

  if (canvasStore.workflow?.status === WorkflowStatus.ACTIVO) {
    return {
      display: {
        ...describeWorkflowStatus(WorkflowStatus.ACTIVO),
        label: 'Activo (En espera de trigger)',
      },
      spinner: false,
    };
  }

  return { display: describeWorkflowStatus(WorkflowStatus.INACTIVO), spinner: false };
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

        <status-badge :display="stateBadge.display" data-test="flow-state-badge">
          {{ stateBadge.display.label }}
          <q-spinner-dots v-if="stateBadge.spinner" class="q-ml-xs" size="14px" />
        </status-badge>

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

    <!-- Guia de la reanudacion selectiva. Sin esto, el operador llega desde la
         tabla a una vista que no explica que se espera de el. -->
    <q-banner v-if="isResumeMode" dense class="pd-resume-banner q-mt-md" data-test="resume-banner">
      <template #avatar>
        <q-icon name="play_circle" size="22px" class="pd-resume-icon" />
      </template>
      Elige el paso desde el que reanudar. Solo los pasos que llegaron a ejecutarse ofrecen el
      boton: retroceder repite trabajo, pero saltar hacia adelante dejaria sin datos a los pasos
      intermedios.
    </q-banner>

    <q-inner-loading :showing="canvasStore.isLoading">
      <q-spinner-dots size="48px" color="primary" />
    </q-inner-loading>

    <TopologyCanvas v-if="!canvasStore.isLoading" />

    <NodeInspectionPanel />
  </q-page>
</template>

<style scoped lang="scss">
// Ambar como el trazo de contingencia del canvas, y por el mismo motivo: no es
// un error, es una via alternativa. El TEXTO nunca va en `--pd-warning`, que no
// alcanza el contraste AA; el ambar queda en el borde y en el icono.
.pd-resume-banner {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-warning);
  border-radius: $generic-border-radius;
  color: var(--pd-text-primary);
}

.pd-resume-icon {
  color: var(--pd-warning);
}
</style>
