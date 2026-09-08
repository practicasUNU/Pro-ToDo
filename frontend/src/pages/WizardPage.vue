<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import PipelineSelector from '@components/wizard/PipelineSelector.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { WizardStep } from '@/types/pipeline';
import type { Component } from 'vue';

const $q = useQuasar();
const router = useRouter();
const draftStore = useFlujoDraftStore();

/**
 * Indice del paso de revision: uno mas que el ultimo nodo.
 *
 * Se deriva de la topologia en vez de ser una constante para que el paso final
 * siga siendo el ultimo por muchos nodos que traiga el pipeline elegido.
 */
const reviewStepIndex = computed<number>(() => draftStore.pipelineTopology.length);

const isReviewStep = computed<boolean>(
  () => draftStore.activeStep === reviewStepIndex.value,
);

/** Datos del flujo a crear; se piden al final, no al principio. */
const form = reactive<{ name: string; description: string }>({
  name: '',
  description: '',
});

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

/** Avanza al paso de revision desde el ultimo nodo configurado. */
const onGoToReview = (): void => {
  if (!draftStore.isActiveStepValid) return;

  draftStore.activeStep = reviewStepIndex.value;
};

const onSaveWorkflow = async (): Promise<void> => {
  try {
    const created = await draftStore.assembleAndSaveWorkflow(
      form.name.trim(),
      form.description,
    );

    $q.notify({
      type: 'positive',
      message: `Flujo "${created.name}" creado. Queda INACTIVO hasta que lo habilites.`,
    });

    // El borrador se limpia antes de navegar: si el operador vuelve al
    // asistente, debe empezar de cero y no sobre los restos del flujo anterior.
    draftStore.resetDraft();
    form.name = '';
    form.description = '';

    await router.push('/');
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo crear el flujo'),
    });
  }
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
            Paso {{ draftStore.activeStep + 1 }} de {{ reviewStepIndex + 1 }}
            <span v-if="isReviewStep"> · revision final</span>
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
            <!-- En el ultimo nodo el avance va al paso de revision, que no es un
                 nodo del pipeline y por eso no lo cubre `goToNextStep`. -->
            <q-btn
              v-else
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Revisar y guardar"
              icon-right="north_east"
              :disable="!draftStore.isActiveStepValid"
              @click="onGoToReview"
            />
          </q-stepper-navigation>
        </q-step>

        <!-- Paso terminal: no corresponde a ningun nodo del grafo. Los datos del
             flujo se piden AQUI y no al principio para que el operador no tenga
             que nombrar algo que todavia no ha configurado. -->
        <q-step
          :name="reviewStepIndex"
          title="Revision y guardado"
          caption="Nombre, descripcion y resumen"
          :prefix="reviewStepIndex + 1"
          icon="fact_check"
        >
          <div class="row q-col-gutter-md">
            <div class="col-12 col-md-6">
              <label class="pd-label" for="workflow-name">
                Nombre del flujo<span class="pd-required">*</span>
              </label>
              <q-input
                id="workflow-name"
                v-model="form.name"
                outlined
                dense
                class="q-mt-xs"
                maxlength="100"
                placeholder="Notiweb - publicacion automatica"
                :rules="[(val: string) => !!val?.trim() || 'El nombre es obligatorio']"
              />
            </div>

            <div class="col-12 col-md-6">
              <label class="pd-label" for="workflow-description">Descripcion</label>
              <q-input
                id="workflow-description"
                v-model="form.description"
                outlined
                dense
                class="q-mt-xs"
                maxlength="255"
                placeholder="Que hace este flujo y cuando se dispara"
              />
            </div>
          </div>

          <div class="pd-surface-muted pd-review-summary q-pa-md q-mt-md">
            <div class="pd-label q-mb-sm">Topologia configurada</div>
            <ol class="pd-review-summary__list">
              <li v-for="step in draftStore.pipelineTopology" :key="step.nodeId">
                <span class="pd-review-summary__name">{{ step.name }}</span>
                <span class="pd-mono pd-review-summary__ns">
                  {{ step.nodeId }} → {{ step.outputNamespace }}
                </span>
              </li>
            </ol>
          </div>

          <!-- Aviso, no sorpresa: el flujo nace inactivo por decision de
               seguridad y el operador debe saberlo antes de pulsar. -->
          <div class="pd-card pd-card--accent pd-accent-leve q-pa-md q-mt-md">
            <p class="pd-subtitle q-mb-none">
              El flujo se creara <strong>inactivo</strong>. No consumira el buzon hasta que lo
              habilites de forma explicita.
            </p>
          </div>

          <q-stepper-navigation class="row items-center q-gutter-sm">
            <q-btn
              flat
              no-caps
              class="pd-btn-secondary"
              label="Anterior"
              @click="draftStore.goToPreviousStep()"
            />
            <q-space />
            <span v-if="!draftStore.canSave" class="pd-subtitle pd-review-hint">
              Faltan pasos por configurar:
              {{ draftStore.invalidSteps.map((step) => step.name).join(', ') }}
            </span>
            <q-btn
              class="pd-btn-primary"
              unelevated
              no-caps
              label="Crear Flujo"
              icon-right="north_east"
              :disable="!draftStore.canSave || !form.name.trim()"
              :loading="draftStore.isLoading"
              @click="onSaveWorkflow"
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

.pd-review-summary {
  border: 1px solid var(--pd-border);
  border-radius: $generic-border-radius;

  &__list {
    margin: 0;
    padding-left: 20px;
    color: var(--pd-text-primary);

    li {
      margin-bottom: 6px;
    }
  }

  &__name {
    font-weight: 500;
  }

  &__ns {
    display: block;
    color: var(--pd-text-secondary);
  }
}

.pd-review-hint {
  max-width: 420px;
  text-align: right;
}
</style>
