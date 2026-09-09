<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';

import { useFlujoDraftStore } from '@stores/flujo-draft.store';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import PipelineSelector from '@components/wizard/PipelineSelector.vue';

import { extractApiErrorMessage } from '@/utils/api-error';

import type { WizardStep } from '@/types/pipeline';
import type { Component } from 'vue';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const draftStore = useFlujoDraftStore();

/**
 * Flujo que se esta editando, o `null` en un alta.
 *
 * El modo lo decide la RUTA y no una prop: `flujos/:id/editar` monta esta misma
 * pagina, y derivarlo del parametro evita una segunda fuente de verdad que
 * pudiera contradecir a la barra de direcciones.
 */
const editedWorkflowId = computed<string | null>(() => {
  const { id } = route.params;

  return typeof id === 'string' && id !== '' ? id : null;
});

const isEditMode = computed<boolean>(() => editedWorkflowId.value !== null);

/**
 * Indice del paso de revision: uno mas que el ultimo nodo.
 *
 * Se deriva de la topologia en vez de ser una constante para que el paso final
 * siga siendo el ultimo por muchos nodos que traiga el pipeline elegido.
 */
const reviewStepIndex = computed<number>(() => draftStore.pipelineTopology.length);

const isReviewStep = computed<boolean>(() => draftStore.activeStep === reviewStepIndex.value);

/** Datos del flujo a crear; se piden al final, no al principio. */
const form = reactive<{ name: string; description: string }>({
  name: '',
  description: '',
});

/**
 * Fase 0 mientras no haya plantilla elegida; Fase 1..N en cuanto la hay.
 *
 * En EDICION no se muestra nunca: el flujo ya existe y su topologia es la que
 * es. Ofrecer ahi el selector permitiria cambiarle la plantilla de origen a un
 * flujo ya instanciado, que es justo lo que `UpdateWorkflowDto` impide al no
 * declarar `templateId`.
 */
const isSelectingTemplate = computed<boolean>(
  () => !isEditMode.value && draftStore.selectedTemplateId === null,
);

/** Rotulo de la accion final, distinto en cada modo. */
const submitLabel = computed<string>(() =>
  isEditMode.value ? 'Guardar cambios' : 'Crear Flujo',
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

const loadTemplates = async (): Promise<void> => {
  try {
    await draftStore.loadAvailableTemplates();
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudieron cargar las plantillas'),
    });
  }
};

const onSelectTemplate = (templateId: string): void => {
  draftStore.selectTemplate(templateId);
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
  const editing = isEditMode.value;

  try {
    const saved = await draftStore.assembleAndSaveWorkflow(form.name.trim(), form.description);

    $q.notify({
      type: 'positive',
      // Guardar una edicion NO cambia el estado del flujo: `active` no viaja en
      // el cuerpo, asi que prometer que "queda inactivo" seria falso para un
      // flujo que ya estaba habilitado.
      message: editing
        ? `Flujo "${saved.name}" actualizado.`
        : `Flujo "${saved.name}" creado. Queda INACTIVO hasta que lo habilites.`,
    });

    // El borrador se limpia antes de navegar: si el operador vuelve al
    // asistente, debe empezar de cero y no sobre los restos del flujo anterior.
    draftStore.resetDraft();
    form.name = '';
    form.description = '';

    // A `/flujos` y no a la portada: ahi aparece el flujo recien creado y ahi
    // esta el toggle con el que se habilita.
    await router.push('/flujos');
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(
        error,
        editing ? 'No se pudo guardar el flujo' : 'No se pudo crear el flujo',
      ),
    });
  }
};

/**
 * Trae el flujo a editar y reparte su configuracion a los stores de nodo.
 *
 * Rellena tambien el formulario final: en edicion el nombre y la descripcion no
 * se piden en blanco, se corrigen sobre los que el flujo ya tiene.
 */
const loadWorkflowForEdit = async (workflowId: string): Promise<void> => {
  try {
    const workflow = await draftStore.loadWorkflowForEdit(workflowId);

    form.name = workflow.name;
    form.description = workflow.description ?? '';
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: extractApiErrorMessage(error, 'No se pudo cargar el flujo'),
    });
    await router.push('/flujos');
  }
};

onMounted(async () => {
  const workflowId = editedWorkflowId.value;

  // El catalogo de plantillas solo hace falta para la Fase 0 del alta.
  await (workflowId === null ? loadTemplates() : loadWorkflowForEdit(workflowId));
});
</script>

<template>
  <q-page class="pd-page q-pa-md">
    <PipelineSelector
      v-if="isSelectingTemplate"
      :templates="draftStore.availableTemplates"
      :is-loading="draftStore.isLoading"
      @select="onSelectTemplate"
    />

    <section v-else>
      <div class="row items-center no-wrap q-gutter-sm q-mb-md">
        <div>
          <h1 class="pd-h1 q-mb-none">
            {{ isEditMode ? form.name : draftStore.selectedTemplate?.name }}
          </h1>
          <p class="pd-subtitle q-mb-none">
            Paso {{ draftStore.activeStep + 1 }} de {{ reviewStepIndex + 1 }}
            <span v-if="isReviewStep"> · revision final</span>
          </p>
        </div>
        <q-space />
        <!-- Solo en alta: en edicion `resetDraft()` vaciaria el borrador recien
             hidratado, y ademas cambiar la plantilla de un flujo ya instanciado
             no es una operacion que el backend admita. -->
        <q-btn
          v-if="!isEditMode"
          flat
          no-caps
          class="pd-btn-secondary"
          label="Cambiar plantilla"
          icon="arrow_back"
          @click="onBackToSelector"
        />
        <q-btn
          v-else
          flat
          no-caps
          class="pd-btn-secondary"
          label="Volver al catalogo"
          icon="arrow_back"
          to="/flujos"
        />
      </div>

      <q-stepper v-model="draftStore.activeStep" class="pd-card" vertical animated flat keep-alive>
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
              <span class="pd-mono">{{ step.nodeType }}</span
              >, que todavia no tiene interfaz de configuracion. No se puede continuar mas alla de
              este paso.
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
              <template v-if="isEditMode">
                Guardar no cambia el estado del flujo: se conserva tal y como esta en el catalogo.
              </template>
              <template v-else>
                El flujo se creara <strong>inactivo</strong>. No consumira el buzon hasta que lo
                habilites de forma explicita.
              </template>
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
              :label="submitLabel"
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
