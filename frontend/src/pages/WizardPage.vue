<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useQuasar } from 'quasar';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import PipelineSelector from '@components/wizard/PipelineSelector.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { WizardStep } from '@/types/pipeline';
import type { Component } from 'vue';

const $q = useQuasar();
const draftStore = useFlujoDraftStore();

/** Fase 0 mientras no haya pipeline elegido; Fase 1..N en cuanto lo hay. */
const isSelectingPipeline = computed<boolean>(
  () => draftStore.selectedPipelineId === null,
);

/**
 * Configurador del paso indicado, o `null` si su tipo aun no tiene uno.
 *
 * Resolucion polimorfica por `nodeType` (regla §3.1): esta funcion es la UNICA
 * via por la que el anfitrion decide que montar, y no hay ni un `v-if` por tipo
 * de nodo en la plantilla. Anadir un tipo es anadir una entrada al registro.
 */
const resolveStepComponent = (step: WizardStep): Component | null =>
  nodeConfigRegistry[step.nodeType] ?? null;

const loadPipelines = async (): Promise<void> => {
  try {
    await draftStore.loadAvailablePipelines();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar los pipelines'),
    });
  }
};

const onSelectPipeline = (pipelineId: string): void => {
  draftStore.selectPipeline(pipelineId);
};

const onBackToSelector = (): void => {
  draftStore.resetDraft();
};

onMounted(loadPipelines);
</script>

<template>
  <q-page class="pd-page q-pa-md">
    <PipelineSelector
      v-if="isSelectingPipeline"
      :pipelines="draftStore.availablePipelines"
      :is-loading="draftStore.isLoading"
      @select="onSelectPipeline"
    />

    <section v-else>
      <div class="row items-center no-wrap q-gutter-sm q-mb-md">
        <div>
          <h1 class="pd-h1 q-mb-none">{{ draftStore.selectedPipeline?.name }}</h1>
          <p class="pd-subtitle q-mb-none">
            Paso {{ draftStore.activeStep + 1 }} de {{ draftStore.pipelineTopology.length }}
          </p>
        </div>
        <q-space />
        <q-btn
          flat
          no-caps
          class="pd-btn-secondary"
          label="Cambiar pipeline"
          icon="arrow_back"
          @click="onBackToSelector"
        />
      </div>

      <q-stepper
        v-model="draftStore.activeStep"
        class="pd-card"
        vertical
        animated
        flat
        keep-alive
      >
        <q-step
          v-for="(step, index) in draftStore.pipelineTopology"
          :key="step.nodeId"
          :name="index"
          :title="step.name"
          :caption="step.outputNamespace"
          :prefix="index + 1"
          :done="index < draftStore.activeStep"
        >
          <!-- Resolucion polimorfica: cero condicionales por tipo de nodo. -->
          <component
            :is="resolveStepComponent(step)"
            v-if="resolveStepComponent(step)"
            :node-id="step.nodeId"
          />

          <!-- El registro es `Partial` a proposito: un tipo sin configurador
               avisa en vez de romper la vista. -->
          <div v-else class="pd-card pd-card--accent pd-accent-grave q-pa-md" role="alert">
            <div class="pd-h2">Configurador no disponible</div>
            <p class="pd-subtitle q-mt-xs q-mb-none">
              El nodo <span class="pd-mono">{{ step.nodeId }}</span> es de tipo
              <span class="pd-mono">{{ step.nodeType }}</span>, que todavia no tiene interfaz
              de configuracion. No se puede continuar mas alla de este paso.
            </p>
          </div>

          <q-stepper-navigation class="row items-center q-gutter-sm">
            <q-btn
              v-if="!draftStore.isFirstStep"
              flat
              no-caps
              class="pd-btn-secondary"
              label="Anterior"
              @click="draftStore.goToPreviousStep()"
            />
            <q-space />
            <q-btn
              v-if="!draftStore.isLastStep"
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Siguiente"
              icon-right="north_east"
              :disable="!draftStore.isActiveStepValid"
              @click="draftStore.goToNextStep()"
            />
          </q-stepper-navigation>
        </q-step>
      </q-stepper>
    </section>
  </q-page>
</template>

<style scoped lang="scss">
// El stepper consume el token de superficie elevada (regla §2).
:deep(.q-stepper) {
  background: var(--pd-card-bg);
  color: var(--pd-text-primary);
}

:deep(.q-stepper__title) {
  color: var(--pd-text-primary);
}

:deep(.q-stepper__caption) {
  color: var(--pd-text-secondary);
  font-family: $mono-font-family;
}

:deep(.q-stepper__tab--disabled) {
  color: var(--pd-disabled-text);
}
</style>
