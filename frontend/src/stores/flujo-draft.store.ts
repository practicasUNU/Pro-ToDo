import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { resolveNodeStore } from '@stores/nodes/node-store-registry';
import * as workflowTemplatesService from '@services/workflow-templates.service';
import * as workflowsService from '@services/workflows.service';

import { toWizardStep } from '@/types/pipeline';

import type {
  AssembledPipelineNode,
  AssembledPipelineSchema,
  PipelineSummary,
  WizardStep,
  WorkflowDetail,
  WorkflowTemplateSummary,
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
  /**
   * Catalogo de blueprints del que parte el asistente.
   *
   * Antes de la migracion 010 esto eran FLUJOS ya instanciados: la Fase 0
   * listaba los que tenian esquema y clonaba su topologia, asi que editar el
   * flujo del que otros habian partido cambiaba la plantilla de facto. Ahora son
   * plantillas maestras, que no se ejecutan nunca.
   */
  const availableTemplates = ref<WorkflowTemplateSummary[]>([]);
  const selectedTemplateId = ref<string | null>(null);

  /**
   * Flujo que se esta editando, o `null` en un alta.
   *
   * Es lo unico que distingue los dos modos del asistente. Vive aqui y no en la
   * pagina para que `assembleAndSaveWorkflow` pueda decidir entre crear y
   * actualizar sin que la vista le pase una bandera: si la decision viviera en
   * la vista, un segundo anfitrion (el banco de pruebas) podria olvidarla y
   * duplicar el flujo en vez de editarlo.
   */
  const editingWorkflowId = ref<string | null>(null);
  const pipelineTopology = ref<WizardStep[]>([]);

  /** Cursor del stepper: indice dentro de `pipelineTopology`. */
  const activeStep = ref(0);

  const isLoading = ref(false);

  /** Paso en curso, o `null` si aun no se ha elegido pipeline. */
  const activeStepDefinition = computed<WizardStep | null>(
    () => pipelineTopology.value[activeStep.value] ?? null,
  );

  const selectedTemplate = computed<WorkflowTemplateSummary | null>(
    () =>
      availableTemplates.value.find((template) => template.id === selectedTemplateId.value) ?? null,
  );

  const isFirstStep = computed<boolean>(() => activeStep.value === 0);

  const isLastStep = computed<boolean>(
    () =>
      pipelineTopology.value.length > 0 && activeStep.value === pipelineTopology.value.length - 1,
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

    return resolveNodeStore(step.nodeType, step.nodeId)?.isConfigValid ?? false;
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
    pipelineTopology.value.slice(0, Math.max(stepIndex, 0)).map((step) => step.outputNamespace);

  /** Solo las plantillas disponibles: una retirada no se puede instanciar. */
  const loadAvailableTemplates = async (): Promise<void> => {
    isLoading.value = true;

    try {
      availableTemplates.value = await workflowTemplatesService.fetchWorkflowTemplates();
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Fija la plantilla elegida y arranca el recorrido desde el primer paso.
   *
   * CLONADO INMUTABLE: cada paso del borrador se construye campo a campo, no
   * por referencia. Sin esa copia, `pipelineTopology` compartiria objetos con
   * `availableTemplates`, y cualquier retoque del borrador mutaria el catalogo
   * en memoria: volver al selector mostraria una plantilla que ya no coincide
   * con la fila de la base de datos, y elegirla de nuevo arrancaria desde el
   * estado contaminado del intento anterior.
   *
   * Se copia campo a campo y NO con `structuredClone`, por dos razones: los
   * elementos vienen envueltos en el Proxy reactivo de Vue y `structuredClone`
   * lanza `DataCloneError` sobre un Proxy; y el literal explicito obliga al
   * compilador a exigir aqui cualquier campo que `PipelineStep` gane en el
   * futuro, en vez de copiarlo por referencia sin avisar.
   *
   * La topologia se toma del catalogo ya cargado en vez de pedirla otra vez: el
   * backend la devuelve completa y ordenada en el listado.
   */
  const selectTemplate = (templateId: string): void => {
    const template = availableTemplates.value.find((candidate) => candidate.id === templateId);

    if (template === undefined) return;

    // La topologia anterior deja de existir, y sus stores no deben sobrevivirle:
    // sin esto, cambiar de plantilla arrastraria la configuracion de un nodo que
    // el flujo nuevo ni siquiera contiene.
    resetNodeStores();

    selectedTemplateId.value = templateId;
    pipelineTopology.value = template.topology.map((step) =>
      toWizardStep({
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        outputNamespace: step.outputNamespace,
      }),
    );
    activeStep.value = 0;

    // En cuanto hay topologia, cada nodo debe conocer su contrato aguas arriba:
    // el mapeador necesita saber que namespaces existen ANTES de que el usuario
    // llegue a su paso, o su primera validacion se haria contra una lista vacia.
    syncUpstreamNamespaces();
  };

  /**
   * Carga un flujo YA GUARDADO en el borrador del asistente.
   *
   * Hermano de `selectTemplate` y con su misma disciplina: resetea los stores de
   * nodo antes de nada, clona campo a campo (nunca `structuredClone`, que
   * revienta con el Proxy reactivo de Vue), deja el cursor en el primer paso y
   * sincroniza los namespaces aguas arriba al final.
   *
   * La diferencia esta en el origen de los datos. `selectTemplate` toma una
   * topologia VACIA de una plantilla del catalogo; esto toma una topologia CON
   * VALORES y los reparte a cada store con `hydrateFromNode`. El orden sale de
   * `topology`, que el backend ya devuelve recorrido desde `entrypoint`: aqui no
   * se vuelve a caminar el grafo, porque una segunda implementacion del recorrido
   * es una segunda implementacion de la que divergir.
   *
   * Un flujo sin `pipelineSchema` (borrador a medio crear) se hidrata igual: la
   * topologia viene vacia y el asistente no muestra pasos, que es lo correcto.
   */
  const hydrateForEdit = (workflow: WorkflowDetail): void => {
    resetNodeStores();

    editingWorkflowId.value = workflow.id;
    selectedTemplateId.value = workflow.templateId;
    pipelineTopology.value = workflow.topology.map((step) =>
      toWizardStep({
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        outputNamespace: step.outputNamespace,
      }),
    );
    activeStep.value = 0;

    const nodes = workflow.pipelineSchema?.nodes ?? {};

    pipelineTopology.value.forEach((step) => {
      const node = nodes[step.nodeId];

      // Un nodo presente en la topologia pero ausente del mapa seria un esquema
      // incoherente; se deja el store en su estado inicial en vez de reventar,
      // y el paso aparecera invalido, que es el aviso correcto para el operador.
      if (node === undefined) return;

      resolveNodeStore(step.nodeType, step.nodeId)?.hydrateFromNode({
        outputNamespace: node.outputNamespace,
        params: node.params,
      });
    });

    syncUpstreamNamespaces();
  };

  /**
   * Trae un flujo del backend y lo carga en el borrador.
   *
   * Es la accion que consume la vista. `hydrateForEdit` queda como
   * transformacion PURA y sincrona —sin red, testeable con un objeto a mano— y
   * este metodo pone la peticion: la cadena obligatoria es componente -> accion
   * de Pinia -> servicio (`frontend-architecture.md` §2), y un `.vue` tiene
   * prohibido importar un servicio directamente.
   *
   * No captura el error: el store solo garantiza el `finally` que apaga
   * `isLoading`, y es el componente quien decide el mensaje al usuario (§2.1).
   */
  const loadWorkflowForEdit = async (workflowId: string): Promise<WorkflowDetail> => {
    isLoading.value = true;

    try {
      const workflow = await workflowsService.fetchWorkflow(workflowId);

      hydrateForEdit(workflow);

      return workflow;
    } finally {
      isLoading.value = false;
    }
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
      (step) => resolveNodeStore(step.nodeType, step.nodeId)?.isConfigValid !== true,
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
      resolveNodeStore(step.nodeType, step.nodeId)?.setAvailableUpstreamNamespaces?.(
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
      const store = resolveNodeStore(step.nodeType, step.nodeId);

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
      // porque `PipelineSchemaDto` lo exige y la plantilla de origen es la
      // referencia mas honesta hasta que exista la fila nueva.
      flowId: selectedTemplateId.value ?? '',
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

    const trimmedDescription = description?.trim() ?? '';
    const pipelineSchema = assemblePipelineSchema(name);

    try {
      const editedId = editingWorkflowId.value;

      if (editedId !== null) {
        // Edicion. NO viaja `active`: habilitar un flujo es competencia del
        // interruptor del catalogo, y colarlo aqui haria que guardar un cambio
        // de filtro lo pusiera en produccion sin pedirlo.
        //
        // Tampoco viaja `templateId`: el maestro del que nacio un flujo es un
        // hecho historico y `UpdateWorkflowDto` no declara ese campo.
        return await workflowsService.updateWorkflow(editedId, {
          name,
          description: trimmedDescription,
          pipelineSchema,
        });
      }

      return await workflowsService.createWorkflow({
        name,
        // `exactOptionalPropertyTypes`: la clave se omite en vez de enviarse
        // como `undefined`, que el DTO backend rechazaria.
        ...(trimmedDescription !== '' ? { description: trimmedDescription } : {}),
        pipelineSchema,
        // Trazabilidad de la procedencia. El grafo viaja COPIADO en
        // `pipelineSchema`, asi que editar la plantilla despues no altera este
        // flujo. La clave se omite si el flujo no parte de ninguna.
        ...(selectedTemplateId.value !== null ? { templateId: selectedTemplateId.value } : {}),
      });
    } finally {
      isLoading.value = false;
    }
  };

  /**
   * Devuelve a su estado inicial los stores de los nodos de la topologia actual.
   *
   * Es imprescindible porque la instancia de un store de nodo SOBREVIVE a la
   * topologia que la creo: vive en la instancia de Pinia, no en el borrador. Sin
   * esta limpieza, crear un flujo y volver al asistente arrancaria con los
   * `params` del flujo anterior ya cargados y `canSave` en `true` sin que el
   * operador haya tocado un solo campo — que es exactamente el caso en el que un
   * guardado accidental publica la configuracion equivocada.
   *
   * Recorre la topologia ANTES de vaciarla: una vez vacia ya no hay forma de
   * saber a que stores preguntar.
   */
  const resetNodeStores = (): void => {
    pipelineTopology.value.forEach((step) => {
      resolveNodeStore(step.nodeType, step.nodeId)?.resetConfig();
    });
  };

  const resetDraft = (): void => {
    resetNodeStores();

    // Sin esto, abandonar una edicion y empezar un alta guardaria el flujo nuevo
    // ENCIMA del que se estaba editando.
    editingWorkflowId.value = null;
    selectedTemplateId.value = null;
    pipelineTopology.value = [];
    activeStep.value = 0;
  };

  return {
    availableTemplates,
    selectedTemplateId,
    pipelineTopology,
    activeStep,
    isLoading,
    activeStepDefinition,
    selectedTemplate,
    isFirstStep,
    isLastStep,
    isActiveStepValid,
    invalidSteps,
    canSave,
    upstreamNamespaces,
    syncUpstreamNamespaces,
    assemblePipelineSchema,
    assembleAndSaveWorkflow,
    resetNodeStores,
    loadAvailableTemplates,
    selectTemplate,
    editingWorkflowId,
    hydrateForEdit,
    loadWorkflowForEdit,
    goToNextStep,
    goToPreviousStep,
    resetDraft,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useFlujoDraftStore, import.meta.hot));
}
