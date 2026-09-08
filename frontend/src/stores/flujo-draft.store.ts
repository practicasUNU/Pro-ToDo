import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { resolveNodeStore } from '@components/nodes/node-store-registry';
import * as pipelinesService from '@services/pipelines.service';
import * as workflowsService from '@services/workflows.service';

import { toWizardStep } from '@/types/pipeline';

import type {
  AssembledPipelineNode,
  AssembledPipelineSchema,
  PipelineSummary,
  WizardStep,
} from '@/types/pipeline';

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
/** SemVer inicial de todo esquema que el asistente genera. */
const INITIAL_SCHEMA_VERSION = '1.0.0';

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

    // En cuanto hay topologia, cada nodo debe conocer su contrato aguas arriba:
    // el mapeador necesita saber que namespaces existen ANTES de que el usuario
    // llegue a su paso, o su primera validacion se haria contra una lista vacia.
    syncUpstreamNamespaces();
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

  /**
   * Pasos cuyo store aun no se declara valido.
   *
   * Se pregunta a TODOS y no solo al activo: el asistente permite retroceder, y
   * sin esta comprobacion se podria guardar un flujo tras haber vaciado un paso
   * anterior ya visitado.
   */
  const invalidSteps = computed<WizardStep[]>(() =>
    pipelineTopology.value.filter(
      (step) => resolveNodeStore(step.nodeType)?.isConfigValid !== true,
    ),
  );

  const canSave = computed<boolean>(
    () => pipelineTopology.value.length > 0 && invalidSteps.value.length === 0,
  );

  /**
   * Propaga a cada nodo los namespaces que aportan los pasos anteriores.
   *
   * Es la conexion que faltaba: `template-mapper.store.ts` usaba hasta ahora una
   * lista fija marcada PROVISIONAL, asi que su deteccion de variables ausentes
   * se hacia contra namespaces inventados. Con esto, un flujo que arranca en
   * TRIGGER_IMAP expone `raw_email` de verdad a los nodos siguientes, y el
   * mapeador puede avisar de que `{{raw_email.subject}}` SI es resoluble y de
   * que `{{scraped_web.headline}}` no lo es en este flujo concreto.
   *
   * Se llama sobre todos los pasos y no solo el activo para que retroceder no
   * deje a un nodo con el contrato de otra posicion.
   */
  const syncUpstreamNamespaces = (): void => {
    pipelineTopology.value.forEach((step, index) => {
      // El metodo es opcional en el contrato: un disparador es el primero del
      // grafo y no tiene nada aguas arriba que declarar.
      resolveNodeStore(step.nodeType)?.setAvailableUpstreamNamespaces?.(
        upstreamNamespaces(index),
      );
    });
  };

  /**
   * Ensambla el `pipeline_schema` a partir de la topologia y los stores de nodo.
   *
   * Los `params` los aporta cada nodo con `toNodeParams()`: el agregador no
   * inspecciona ninguna `config` interna (§3.1). Los punteros del grafo salen de
   * la topologia, que ya viene ordenada del backend, asi que `nextStep` es
   * simplemente el nodo siguiente del arreglo.
   *
   * `onErrorStep` queda en `null` en todos los nodos: el asistente todavia no
   * ofrece configurar caminos de recuperacion, y un puntero inventado seria peor
   * que su ausencia —el motor detendria la ejecucion en el nodo que falla, que es
   * el comportamiento correcto por defecto.
   */
  const assemblePipelineSchema = (name: string): AssembledPipelineSchema => {
    const nodes: Record<string, AssembledPipelineNode> = {};

    pipelineTopology.value.forEach((step, index) => {
      const store = resolveNodeStore(step.nodeType);

      nodes[step.nodeId] = {
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        outputNamespace: step.outputNamespace,
        nextStep: pipelineTopology.value[index + 1]?.nodeId ?? null,
        onErrorStep: null,
        params: store?.toNodeParams() ?? {},
      };
    });

    return {
      // El backend ignora este `flowId` y asigna el de la fila que crea; viaja
      // porque `PipelineSchemaDto` lo exige y el pipeline de origen es la
      // referencia mas honesta hasta que exista la fila nueva.
      flowId: selectedPipelineId.value ?? '',
      name,
      version: INITIAL_SCHEMA_VERSION,
      entrypoint: pipelineTopology.value[0]?.nodeId ?? '',
      nodes,
    };
  };

  /**
   * Ensambla el esquema y lo persiste.
   *
   * La guarda de validez vive aqui y no solo en el `:disable` del boton: el
   * estado del borrador no debe depender de que la vista se acuerde de
   * deshabilitar nada, y guardar un flujo a medio configurar dejaria en la BD un
   * esquema que reventaria en su primera ejecucion.
   *
   * No captura el error del servicio: el componente decide el mensaje
   * (`frontend-architecture.md` §2.1).
   *
   * @throws Error Si algun paso no se declara valido.
   */
  const assembleAndSaveWorkflow = async (
    name: string,
    description?: string,
  ): Promise<PipelineSummary> => {
    if (!canSave.value) {
      throw new Error(
        `Hay ${invalidSteps.value.length} paso(s) sin configurar: ${invalidSteps.value
          .map((step) => step.name)
          .join(', ')}.`,
      );
    }

    isLoading.value = true;

    try {
      const created = await workflowsService.createWorkflow({
        name,
        // `exactOptionalPropertyTypes`: la clave se omite en vez de enviarse
        // como `undefined`, que el DTO backend rechazaria.
        ...(description !== undefined && description.trim() !== ''
          ? { description: description.trim() }
          : {}),
        pipelineSchema: assemblePipelineSchema(name),
      });

      // El catalogo queda obsoleto en cuanto se crea un flujo: refrescarlo aqui
      // evita que volver al selector muestre una lista sin el recien creado.
      availablePipelines.value = [created, ...availablePipelines.value];

      return created;
    } finally {
      isLoading.value = false;
    }
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
    invalidSteps,
    canSave,
    upstreamNamespaces,
    syncUpstreamNamespaces,
    assemblePipelineSchema,
    assembleAndSaveWorkflow,
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
