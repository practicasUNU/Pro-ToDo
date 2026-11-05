<script setup lang="ts">
import { computed } from 'vue';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { ALERT_STEP_NAME } from '@stores/flujo-draft.store';
import { SHARED_ALERT_NODE_ID } from '@/types/nodes/error-branch.types';

interface Props {
  /** Nodo que se desvia. */
  sourceNodeId: string;
  /** Nodo que recibe el desvio. */
  targetNodeId: string;
  /**
   * Codigo que dispara la ruta, o `null` si atrapa cualquier fallo.
   *
   * `null` NO es "sin codigo declarado": es la forma de CADENA de `onErrorStep`,
   * la unica que el motor trata como respaldo incondicional. Pintar ahi una
   * insignia con un codigo inventado prometeria un desvio selectivo que el
   * esquema no declara.
   */
  errorCode: string | null;
}

const props = defineProps<Props>();

const draftStore = useFlujoDraftStore();

const CARD_TITLE = 'Ruta de Contingencia (onErrorStep)';

const READ_ONLY_HINT =
  'La declara la plantilla de flujo y aqui no se puede cambiar: la topologia es propiedad de la plantilla, no de cada flujo que parte de ella. Este paso no se detiene ante el fallo; el motor salta al nodo indicado y le entrega el contexto del error.';

/** Si el desvio va al nodo de alerta compartido, que no esta en la topologia. */
const isAlertTarget = computed<boolean>(() => props.targetNodeId === SHARED_ALERT_NODE_ID);

/** Paso del asistente que recibe el desvio, con su posicion. */
const targetStep = computed(() => {
  const index = draftStore.pipelineTopology.findIndex((step) => step.nodeId === props.targetNodeId);

  return index === -1 ? null : { step: draftStore.pipelineTopology[index], index };
});

/**
 * Como se nombra el destino en el aviso.
 *
 * El satelite de alerta no aparece en `pipelineTopology` —solo se llega a el por
 * la ruta—, asi que se nombra por su paso del asistente. Sin esta rama el aviso
 * decia que el nodo "ya no forma parte de este flujo", que era falso y ademas
 * alarmante.
 */
const targetLabel = computed<string>(() => {
  if (isAlertTarget.value) return ALERT_STEP_NAME;

  return targetStep.value?.step?.name ?? props.targetNodeId;
});

/** Si hay un paso del asistente al que saltar para configurar el destino. */
const canJumpToTarget = computed<boolean>(() =>
  isAlertTarget.value ? draftStore.alertStepIndex !== -1 : targetStep.value !== null,
);

const onGoToTarget = (): void => {
  if (isAlertTarget.value) {
    draftStore.activeStep = draftStore.alertStepIndex;
    return;
  }

  draftStore.goToNodeStep(props.targetNodeId);
};
</script>

<template>
  <section
    class="pd-branch-card q-mt-md q-pa-md"
    :data-node-id="sourceNodeId"
    data-test="node-branch-card"
  >
    <header class="row items-center no-wrap q-gutter-sm">
      <q-icon name="alt_route" size="22px" class="pd-branch-card__icon" />
      <div class="pd-label">{{ CARD_TITLE }}</div>
      <q-space />
      <!-- Solo la forma selectiva nombra un codigo; la cadena atrapa cualquier
           fallo y una insignia ahi prometeria una selectividad inexistente. -->
      <q-badge
        v-if="errorCode"
        class="pd-badge pd-mono pd-branch-card__code"
        data-test="branch-error-code"
      >
        {{ errorCode }}
      </q-badge>
    </header>

    <p class="pd-label q-mt-sm q-mb-xs" data-test="branch-notice">
      Ruta de contingencia configurada hacia: {{ targetLabel }}
    </p>

    <p class="pd-subtitle q-mb-md">{{ READ_ONLY_HINT }}</p>

    <div
      v-if="canJumpToTarget"
      class="row items-center no-wrap q-gutter-sm"
      data-test="branch-target"
    >
      <div>
        <div class="pd-label">Recibe el desvio</div>
        <div class="pd-subtitle">
          <template v-if="targetStep">Paso {{ targetStep.index + 1 }} · </template>
          <span class="pd-mono">{{ targetNodeId }}</span>
        </div>
      </div>
      <q-space />
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon-right="north_east"
        :label="`Ir a ${targetLabel}`"
        data-test="branch-jump"
        @click="onGoToTarget"
      />
    </div>

    <!-- Un destino fuera de la topologia seria un esquema roto, y lo rechaza el
         backend con su regla 3. Aqui se avisa en vez de pintar un boton muerto. -->
    <p v-else class="pd-subtitle q-mb-none" data-test="branch-target-missing">
      El nodo <span class="pd-mono">{{ targetNodeId }}</span> ya no forma parte de este flujo.
      Revisa la ruta de contingencia en la plantilla de origen.
    </p>
  </section>
</template>

<style scoped lang="scss">
// Borde izquierdo de acento y fondo atenuado: se lee como una derivacion del
// paso, no como otro paso. Por eso NO usa `.pd-card`, que es la superficie de
// un bloque de primer nivel.
.pd-branch-card {
  background: var(--pd-surface-muted);
  border: 1px solid var(--pd-border);
  border-left: 3px solid var(--pd-warning);
  border-radius: $generic-border-radius;
}

.pd-branch-card__icon {
  color: var(--pd-warning);
}

.pd-branch-card__code {
  background: var(--pd-accent-soft);
  color: var(--pd-accent-text);
}
</style>
