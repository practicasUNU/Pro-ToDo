<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';

import SafeDeleteModal from '@components/shared/SafeDeleteModal.vue';
import { useCanvasStore } from '@stores/canvas.store';
import { useExecutionStore } from '@stores/execution.store';
import { MAX_DISCARD_REASON_LENGTH } from '@/types/execution';
import { ERROR_CONTEXT_NAMESPACE, NODE_TYPE_LABELS } from '@/types/pipeline';

const canvasStore = useCanvasStore();
const executionStore = useExecutionStore();
const $q = useQuasar();

const isDiscardOpen = ref(false);
/** Motivo opcional del descarte; va al evento FLUJO_DESCARTADO de la auditoria. */
const discardReason = ref('');

const isOpen = computed<boolean>({
  get: () => canvasStore.selectedStep !== null,
  set: (value: boolean) => {
    if (!value) {
      canvasStore.clearSelection();
    }
  },
});

/**
 * El nodo seleccionado es el que tiene congelado el cursor de una PAUSADO.
 *
 * Es lo unico que habilita las acciones de CU-09: reanudar desde otro nodo no
 * existe como operacion, porque el motor retoma siempre por `activeCursor`.
 */
const isFrozenNode = computed<boolean>(
  () => canvasStore.isPaused && canvasStore.activeCursor === canvasStore.selectedNodeId,
);

/** Volcado que el nodo dejo en su namespace, o `null` si aun no escribio. */
const namespaceDump = computed<string | null>(() => {
  const step = canvasStore.selectedStep;

  if (step === null) {
    return null;
  }

  const payload = canvasStore.executionContext[step.outputNamespace];

  return payload === undefined ? null : JSON.stringify(payload, null, 2);
});

/**
 * Metadatos del fallo que provoco el desvio o la pausa.
 *
 * `error_context` NO es una columna: es el namespace reservado que el motor
 * siembra en el contexto justo antes de detenerse o desviar.
 */
const errorContextDump = computed<string | null>(() => {
  const payload = canvasStore.executionContext[ERROR_CONTEXT_NAMESPACE];

  return payload === undefined ? null : JSON.stringify(payload, null, 2);
});

const paramsDump = computed<string>(() =>
  JSON.stringify(canvasStore.selectedStep?.params ?? {}, null, 2),
);

const handleResume = async (): Promise<void> => {
  const execution = canvasStore.observedExecution;

  if (execution === null) {
    return;
  }

  try {
    await executionStore.resumeExecution(execution.executionId);
    $q.notify({ type: 'positive', icon: 'play_arrow', message: 'Flujo reanudado' });
    await canvasStore.loadCanvas(execution.flowId);
  } catch (error: unknown) {
    $q.notify({
      type: 'negative',
      icon: 'error',
      message: 'No se pudo reanudar',
      caption: error instanceof Error ? error.message : 'Error desconocido',
    });
  }
};

/**
 * La invoca `SafeDeleteModal` tras su cuenta atras de cinco segundos.
 *
 * Descartar no solo cierra la ejecucion: el backend retira ademas el flujo de
 * los disparadores automaticos, y por eso se recarga el canvas al terminar.
 */
const handleDiscard = async (): Promise<void> => {
  const execution = canvasStore.observedExecution;

  if (execution === null) {
    return;
  }

  try {
    await executionStore.discardExecution(execution.executionId, discardReason.value);
    discardReason.value = '';
    $q.notify({ type: 'positive', icon: 'delete_sweep', message: 'Ejecucion descartada' });
    await canvasStore.loadCanvas(execution.flowId);
  } catch (error: unknown) {
    $q.notify({
      type: 'negative',
      icon: 'error',
      message: 'No se pudo descartar',
      caption: error instanceof Error ? error.message : 'Error desconocido',
    });
  }
};
</script>

<template>
  <q-drawer v-model="isOpen" side="right" bordered :width="420" class="pd-drawer" overlay>
    <div v-if="canvasStore.selectedStep !== null" class="q-pa-md">
      <div class="row items-center no-wrap q-mb-md">
        <div class="col">
          <div class="pd-h2">{{ NODE_TYPE_LABELS[canvasStore.selectedStep.nodeType] }}</div>
          <div class="pd-mono pd-text-secondary">{{ canvasStore.selectedStep.nodeId }}</div>
        </div>
        <q-btn
          flat
          round
          dense
          icon="close"
          class="pd-btn-icon"
          @click="canvasStore.clearSelection()"
        >
          <q-tooltip>Cerrar</q-tooltip>
        </q-btn>
      </div>

      <!-- Tarjeta del fallo. Va ARRIBA del todo cuando aplica: si el operador
           abrio este panel es porque el canvas le senalo este nodo en rojo. -->
      <q-card v-if="isFrozenNode" flat class="pd-card pd-card--accent pd-accent-urgente q-mb-md">
        <q-card-section>
          <div class="row items-center q-gutter-sm q-mb-sm">
            <q-icon name="pause_circle" color="warning" size="20px" />
            <span class="pd-label">Ejecucion detenida en este paso</span>
          </div>
          <div class="pd-text-secondary">
            {{ canvasStore.observedExecution?.failureReason ?? 'Sin motivo registrado.' }}
          </div>
          <pre v-if="errorContextDump !== null" class="pd-mono pd-code-block q-mt-sm">{{
            errorContextDump
          }}</pre>
        </q-card-section>

        <q-card-actions align="right">
          <!-- Escape primero, accion despues: la secundaria nunca debe competir
               visualmente con la primaria (`frontend-quasar.md` §2). -->
          <q-btn
            flat
            class="pd-btn-secondary"
            label="Descartar"
            :loading="executionStore.isDiscarding"
            @click="isDiscardOpen = true"
          />
          <q-btn
            label="Reanudar desde este paso"
            icon="play_arrow"
            color="warning"
            :loading="executionStore.isResuming"
            @click="handleResume"
          />
        </q-card-actions>
      </q-card>

      <div class="pd-subtitle q-mb-xs">Configuracion persistida</div>
      <pre class="pd-mono pd-code-block q-mb-md">{{ paramsDump }}</pre>

      <div class="pd-subtitle q-mb-xs">
        Namespace <span class="pd-mono">{{ canvasStore.selectedStep.outputNamespace }}</span>
      </div>
      <pre v-if="namespaceDump !== null" class="pd-mono pd-code-block">{{ namespaceDump }}</pre>
      <!-- El contexto es inmutable y de SOLO LECTURA: lo que se ve aqui es el
           checkpoint persistido, no un formulario. -->
      <q-banner v-else dense class="pd-surface-muted">
        Este paso todavia no ha escrito nada en el contexto.
      </q-banner>
    </div>

    <SafeDeleteModal
      v-model="isDiscardOpen"
      title="Descartar ejecucion"
      message="Se cerrara la ejecucion detenida y el flujo quedara retirado de los disparadores automaticos. No se puede deshacer."
      confirm-label="Descartar"
      @confirm="handleDiscard"
    >
      <q-input
        v-model="discardReason"
        outlined
        dense
        type="textarea"
        autogrow
        counter
        label="Motivo del descarte (opcional)"
        :maxlength="MAX_DISCARD_REASON_LENGTH"
        hint="Queda registrado en la auditoria."
        data-test="discard-reason"
      />
    </SafeDeleteModal>
  </q-drawer>
</template>
