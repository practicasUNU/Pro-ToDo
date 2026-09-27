<script setup lang="ts">
import { computed } from 'vue';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

interface Props {
  /** Nodo que se desvia. */
  sourceNodeId: string;
  /** Nodo que recibe el desvio. */
  targetNodeId: string;
  /** Codigo de error que dispara la ruta. */
  errorCode: string;
}

const props = defineProps<Props>();

const draftStore = useFlujoDraftStore();

const CARD_TITLE = 'Ruta de Recuperacion Automatica (onErrorStep)';

const EXPLANATION =
  'Este paso no se detiene ante ese fallo: el motor salta al nodo indicado y le entrega el contexto del error, que es lo que activa su modo de vision. El nodo sigue formando parte del camino normal del flujo, asi que se configura en su propio paso.';

/** Paso del asistente que recibe el desvio, con su posicion. */
const targetStep = computed(() => {
  const index = draftStore.pipelineTopology.findIndex((step) => step.nodeId === props.targetNodeId);

  return index === -1 ? null : { step: draftStore.pipelineTopology[index], index };
});

const onGoToTarget = (): void => {
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
      <q-badge class="pd-badge pd-mono pd-branch-card__code" data-test="branch-error-code">
        {{ errorCode }}
      </q-badge>
    </header>

    <p class="pd-subtitle q-mt-sm q-mb-md">{{ EXPLANATION }}</p>

    <div v-if="targetStep" class="row items-center no-wrap q-gutter-sm" data-test="branch-target">
      <div>
        <div class="pd-label">Recibe el desvio</div>
        <div class="pd-subtitle">
          Paso {{ targetStep.index + 1 }} ·
          <span class="pd-mono">{{ targetStep.step?.nodeId }}</span>
        </div>
      </div>
      <q-space />
      <q-btn
        class="pd-btn-icon"
        outline
        no-caps
        dense
        icon-right="north_east"
        :label="`Ir a ${targetStep.step?.name}`"
        data-test="branch-jump"
        @click="onGoToTarget"
      />
    </div>

    <!-- Un destino fuera de la topologia seria un esquema roto, y lo rechaza el
         backend con su regla 3. Aqui se avisa en vez de pintar un boton muerto. -->
    <p v-else class="pd-subtitle q-mb-none" data-test="branch-target-missing">
      El nodo <span class="pd-mono">{{ targetNodeId }}</span> ya no forma parte de este flujo.
      Revisa la ruta de contingencia de este paso.
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
