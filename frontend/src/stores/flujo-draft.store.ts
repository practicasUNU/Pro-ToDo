import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { resolveNodeStore } from '@components/nodes/node-store-registry';
import * as pipelinesService from '@services/pipelines.service';

import { toWizardStep } from '@/types/pipeline';

import type { PipelineSummary, WizardStep } from '@/types/pipeline';

/**
 * Borrador del asistente de creacion de flujos (regla frontend-quasar.md §3).
 *
 * Es un AGREGADOR y no un almacen: posee la topologia del flujo y el cursor del
 * stepper, pero NO los campos de cada nodo. De esos es dueno el store del propio
 * nodo (§3.1), y duplicarlos aqui crearia dos fuentes de verdad que se
 * desincronizan en cuanto el usuario retrocede un paso y vuelve a avanzar.
 *
 * Por el mismo motivo no reimplementa ninguna validacion: para saber si el paso
 * activo puede avanzar PREGUNTA al store del nodo por su `isConfigValid`,
 * resolviendolo por `nodeType` a traves de `node-store-registry`.
 */
export const useFlujoDraftStore = defineStore('flujoDraft', () => {
  const availablePipelines = ref<PipelineSummary[]>([]);
  const selectedPipelineId = ref<string | null>(null);
  const pipelineTopology = ref<WizardStep[]>([]);

  /** Cursor del stepper: indice dentro de `pipelineTopology`. */
  const activeStep = ref(0);

  const isLoading = ref(false);

  /** Paso en curso, o `null` si aun no se ha elegido pipeline. */
  const activeStepDefinition = computed<WizardStep | null>(
    () => pipelineTopology.value[activeStep.value] ?? null,
  );

  const selectedPipeline = computed<PipelineSummary | null>(
    () =>
      availablePipelines.value.find(
        (pipeline) => pipeline.id === selectedPipelineId.value,
      ) ?? null,
  );

  const isFirstStep = computed<boolean>(() => activeStep.value === 0);

  const isLastStep = computed<boolean>(
    () =>
      pipelineTopology.value.length > 0 &&
      activeStep.value === pipelineTopology.value.length - 1,
  );

  /**
   * Si el paso activo se declara valido.
   *
   * Delega en el store del nodo: el asistente no sabe —ni debe saber— que hace
   * valida la configuracion de un TRIGGER_IMAP frente a la de un
   * MAPEADOR_PLANTILLA.
   *
   * Un paso cuyo tipo aun no tiene store registrado devuelve `false`: sin
   * configurador no hay forma de declararlo valido, y dejar avanzar seria
   * ensamblar un `pipeline_schema` con un nodo sin configurar.
   */
  const isActiveStepValid = computed<boolean>(() => {
    const step = activeStepDefinition.value;

    if (step === null) return false;

    return resolveNodeStore(step.nodeType)?.isConfigValid ?? false;
  });

  /**
   * Namespaces que los pasos ANTERIORES al indicado dejan en el contexto.
   *
   * Es el contrato aguas arriba de un nodo: el mapeador de plantillas lo necesita
   * para saber si `{{scraped_web.headline}}` es resoluble en este flujo concreto
   * o si la plantilla exige algo que nadie produce. Hoy ese store usa una lista
   * fija marcada como PROVISIONAL; esta es la fuente real.
   *
   * Excluye el paso indicado a proposito: un nodo no puede leer su propia salida.
   */
  const upstreamNamespaces = (stepIndex: number): string[] =>
    pipelineTopology.value
      .slice(0, Math.max(stepIndex, 0))
      .map((step) => step.outputNamespace);

  const loadAvailablePipelines = async (): Promise<void> => {
    isLoading.value = true;

    try {
      availablePipelines.value = await pipelinesService.fetchSelectablePipelines();
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Fija el pipeline elegido y arranca el recorrido desde el primer paso.
   *
   * La topologia se toma del catalogo ya cargado en vez de pedirla otra vez: el
   * backend la devuelve completa y ordenada en el listado.
   */
  const selectPipeline = (pipelineId: string): void => {
    const pipeline = availablePipelines.value.find(
      (candidate) => candidate.id === pipelineId,
    );

    if (pipeline === undefined) return;

    selectedPipelineId.value = pipelineId;
    pipelineTopology.value = pipeline.topology.map(toWizardStep);
    activeStep.value = 0;
  };

  /**
   * Avanza el cursor si el paso activo lo permite.
   *
   * La guarda esta aqui y no solo en el `:disable` del boton: el estado del
   * borrador no debe depender de que la vista se acuerde de deshabilitar nada.
   */
  const goToNextStep = (): void => {
    if (!isActiveStepValid.value || isLastStep.value) return;

    activeStep.value += 1;
  };

  /** Retrocede sin validar: volver atras a corregir siempre debe ser posible. */
  const goToPreviousStep = (): void => {
    if (isFirstStep.value) return;

    activeStep.value -= 1;
  };

  const resetDraft = (): void => {
    selectedPipelineId.value = null;
    pipelineTopology.value = [];
    activeStep.value = 0;
  };

  return {
    availablePipelines,
    selectedPipelineId,
    pipelineTopology,
    activeStep,
    isLoading,
    activeStepDefinition,
    selectedPipeline,
    isFirstStep,
    isLastStep,
    isActiveStepValid,
    upstreamNamespaces,
    loadAvailablePipelines,
    selectPipeline,
    goToNextStep,
    goToPreviousStep,
    resetDraft,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFlujoDraftStore, import.meta.hot));
}
