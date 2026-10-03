import { defineStore, acceptHMRUpdate } from 'pinia';
import { computed, ref } from 'vue';

import { nodeConfigRegistry } from '@components/nodes/node-config-registry';
import { useNodeCatalogStore } from '@stores/node-catalog.store';
import { resolveNodeStore } from '@stores/nodes/node-store-registry';
import * as workflowTemplatesService from '@services/workflow-templates.service';
import * as workflowsService from '@services/workflows.service';

import { useSmtpAlertStore } from '@stores/nodes/smtp-alert.store';

import {
  assemblePipelineSchema as buildPipelineSchema,
  errorRouteTarget,
  INITIAL_SCHEMA_VERSION,
} from '@/utils/pipeline-assembler';
import { resolveSatelliteErrorRoute } from '@/utils/satellite-error-route';

import { DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE, toWizardStep } from '@/types/pipeline';
import {
  ERROR_BRANCH_ACTIONS,
  ERROR_BRANCH_TRIGGERS,
  SHARED_ALERT_NODE_ID,
} from '@/types/nodes/error-branch.types';

import type { UpstreamNamespace } from '@stores/nodes/node-store-registry';

import type { AssemblerStep } from '@/utils/pipeline-assembler';

import type {
  AssembledPipelineNode,
  AssembledPipelineSchema,
  PipelineExecutionPolicy,
  PipelineSummary,
  SelectiveErrorFallback,
  WizardStep,
  WorkflowDetail,
  WorkflowTemplateSummary,
  NodeType,
} from '@/types/pipeline';
import type {
  ErrorBranch,
  ErrorBranchAction,
  ErrorBranchTrigger,
} from '@/types/nodes/error-branch.types';

/**
 * Por que un paso no deja continuar.
 *
 * Los tres casos se ven igual en la interfaz —el boton no responde— pero solo
 * el ultimo lo puede resolver el operador sin salir del asistente.
 */
export type StepBlockReason =
  /** El tipo no tiene componente de configuracion registrado. */
  | 'SIN_CONFIGURADOR'
  /** Hay componente pero no store: el motor no sabe ejecutar este tipo. */
  | 'SIN_STORE'
  /** El nodo tiene configurador y aun no se declara valido. */
  | 'CONFIGURACION_INCOMPLETA'
  /** El paso de contingencias existe pero su nodo de alerta esta sin completar. */
  | 'ALERTA_INCOMPLETA';

/** Un aviso que un paso quiere que el operador confirme antes de persistir. */
export interface StepWarning {
  readonly step: WizardStep;
  /** Indice en la topologia, para poder saltar al paso que avisa. */
  readonly index: number;
  readonly message: string;
}

/** Un paso que bloquea el guardado, con su posicion y su motivo. */
export interface InvalidStep {
  readonly step: WizardStep;
  /** Indice en la topologia, para poder saltar al paso culpable. */
  readonly index: number;
  readonly reason: StepBlockReason;
  readonly message: string;
}

/** Etiqueta del paso sintetico de contingencias. */
export const ALERT_STEP_NAME = 'Contingencias por correo';

/** Rotulo del paso del satelite de transcripcion. */
export const OCR_STEP_NAME = 'OCR de Contingencia';

/** Rotulo del paso sintetico de cada accion que provisiona satelite. */
const CONTINGENCY_STEP_NAMES: Record<ErrorBranchAction, string> = {
  ALERTA_SMTP: ALERT_STEP_NAME,
  VISION_IA: OCR_STEP_NAME,
};

/** Texto que la vista muestra para cada motivo. */
const STEP_BLOCK_MESSAGES: Record<StepBlockReason, (step: WizardStep) => string> = {
  SIN_CONFIGURADOR: (step) => `El tipo ${step.name} todavia no tiene interfaz de configuracion.`,
  SIN_STORE: (step) =>
    `El tipo ${step.name} no tiene estrategia en el motor: este flujo no se puede guardar. Edita la plantilla para retirarlo.`,
  CONFIGURACION_INCOMPLETA: () => 'Faltan campos por completar en este paso.',
  ALERTA_INCOMPLETA: () => 'Indica al menos un destinatario para las alertas de contingencia.',
};

/**
 * Motivo por el que un paso bloquea, o `null` si es valido.
 *
 * El orden de las comprobaciones importa: se mira primero el componente y luego
 * el store porque un tipo sin componente tampoco tendra store, y anunciar "falta
 * el configurador" es mas util que "falta el store", que no significa nada para
 * quien usa el asistente.
 */
const resolveStepBlockReason = (step: WizardStep): StepBlockReason | null => {
  if (nodeConfigRegistry[step.nodeType] === undefined) return 'SIN_CONFIGURADOR';

  const store = resolveNodeStore(step.nodeType, step.nodeId);

  if (store === null) return 'SIN_STORE';

  return store.isConfigValid ? null : 'CONFIGURACION_INCOMPLETA';
};

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

  /**
   * Politica heredada de la plantilla, o la que ya tenia el flujo en edicion.
   *
   * Vive en un `ref` propio porque NO se deriva de la topologia: el asistente
   * reensambla el esquema entero a partir de los pasos y sus `params`, asi que
   * todo metadato raiz que no se guarde aqui se perderia al guardar. El
   * asistente no la edita —eso se hace en la plantilla—, solo la conserva.
   */
  const executionPolicy = ref<PipelineExecutionPolicy | null>(null);

  /**
   * Rutas de contingencia declaradas, indexadas por el `nodeId` que se desvia.
   *
   * VIVEN APARTE de `pipelineTopology` y no como un campo de `WizardStep`, y no
   * es una comodidad: el orden de ese arreglo ES la topologia —`nextStep` es el
   * elemento siguiente—, asi que un nodo de alerta metido ahi acabaria en el
   * camino feliz, ejecutandose en cada pasada en vez de solo al fallar algo.
   *
   * La rama guarda la INTENCION (que dispara, que se hace) y no el puntero. El
   * `targetNode` se resuelve al ensamblar, porque depende de la topologia
   * completa: la alerta reutiliza el `DESTINO_SMTP` del flujo si lo hay, y la
   * ruta de vision apunta al `PROCESADOR_IA` que ya exista.
   *
   * ESTADO DERIVADO, nunca escrito por la interfaz: se hidrata desde el
   * `pipeline_schema` de la plantilla —o del flujo, al editar— y el asistente
   * solo lo lee. `onErrorStep` es topologia, y su unica autoridad es la
   * plantilla: dejar que una instancia la mutara permitia inventarse un grafo
   * que su plantilla no declara, y la siguiente instancia de la misma plantilla
   * salia distinta sin que nada lo explicara.
   */
  const errorBranches = ref<Record<string, ErrorBranch>>({});

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

  /**
   * Si el cursor esta en el ultimo paso CONFIGURABLE.
   *
   * Se mide contra `configurableStepCount` y no contra la longitud de la
   * topologia porque el paso de contingencias, cuando existe, va detras del
   * ultimo nodo: sin esto, el boton del ultimo nodo diria "Revisar y guardar" y
   * saltaria por encima del formulario de destinatarios.
   */
  const isLastStep = computed<boolean>(
    () => configurableStepCount.value > 0 && activeStep.value === configurableStepCount.value - 1,
  );

  /** Si el cursor esta sobre el paso sintetico de contingencias. */
  const isContingencyStep = computed<boolean>(
    () =>
      activeStep.value >= pipelineTopology.value.length &&
      activeStep.value < configurableStepCount.value,
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
    // Los pasos de contingencia no estan en la topologia: su validez es la del
    // store del satelite que cada uno configura.
    if (isContingencyStep.value) {
      const step = contingencySteps.value[activeStep.value - pipelineTopology.value.length];

      return step === undefined
        ? false
        : (resolveNodeStore(step.nodeType, step.nodeId)?.isConfigValid ?? false);
    }

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

  /**
   * Lo mismo que `upstreamNamespaces`, pero CON los campos de cada namespace.
   *
   * Hermano del anterior y no su sustituto, porque responden a preguntas
   * distintas. El de nombres basta para saber si un namespace existe; este es el
   * que permite COMPONER `{{namespace.campo}}` en un selector cerrado, y para
   * eso el nombre no basta: hace falta saber que campos publica cada nodo y de
   * que tipo son. Lo consumen el extractor web —que solo puede apuntar a un
   * campo de tipo URL— y el mapeador de plantillas —que contrasta las variables
   * que la plantilla exige contra las que el flujo publica de verdad.
   *
   * Viaja tambien el `nodeType`, que el paso ya tiene: es lo que permite al
   * consumidor etiquetar el origen de una variable con el nodo que la produce y
   * no solo con el namespace en el que aterriza.
   *
   * Los campos salen del catalogo de nodos, que es donde el backend publica lo
   * que declara cada estrategia. El frontend NO replica la forma de ningun
   * payload: pregunta. Si el catalogo aun no ha cargado, o si el tipo de nodo no
   * declara sus campos, se devuelve el namespace con `fields` vacio — que para
   * el consumidor significa "no hay nada que ofrecer todavia", nunca un error.
   */
  const upstreamContext = (stepIndex: number): UpstreamNamespace[] => {
    const catalog = useNodeCatalogStore();

    return pipelineTopology.value.slice(0, Math.max(stepIndex, 0)).map((step) => ({
      namespace: step.outputNamespace,
      nodeType: step.nodeType,
      fields: catalog.findByCode(step.nodeType)?.outputFields ?? [],
    }));
  };

  /**
   * Solo las plantillas disponibles: una retirada no se puede instanciar.
   *
   * Aprovecha para asegurar el catalogo de nodos, del que `upstreamContext`
   * saca los campos de cada namespace. `fetchCatalog` se memoiza tras la primera
   * llamada —son datos de instalacion—, asi que no cuesta una peticion por
   * apertura del asistente. Sin esta linea, `selectTemplate` sincronizaria un
   * contexto con `fields` vacios y el selector del extractor web saldria
   * permanentemente deshabilitado sin motivo aparente.
   *
   * Se pide en PARALELO con las plantillas: son dos lecturas independientes y
   * encadenarlas solo sumaria latencia.
   */
  const loadAvailableTemplates = async (): Promise<void> => {
    isLoading.value = true;

    try {
      const [templates] = await Promise.all([
        workflowTemplatesService.fetchWorkflowTemplates(),
        useNodeCatalogStore().fetchCatalog(),
      ]);

      availableTemplates.value = templates;
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
  const selectTemplate = async (templateId: string): Promise<void> => {
    const template = availableTemplates.value.find((candidate) => candidate.id === templateId);

    if (template === undefined) return;

    // La topologia anterior deja de existir, y sus stores no deben sobrevivirle:
    // sin esto, cambiar de plantilla arrastraria la configuracion de un nodo que
    // el flujo nuevo ni siquiera contiene.
    resetNodeStores();

    selectedTemplateId.value = templateId;
    executionPolicy.value = template.executionPolicy ?? null;
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

    // El DETALLE y no el resumen: `WorkflowTemplateSummary.topology` es el camino
    // activo recorrido desde `entrypoint`, asi que no trae ni los `onErrorStep`
    // ni el nodo satelite que los atiende. Sin esta segunda lectura el asistente
    // abriria sin ramas y el flujo instanciado perderia la contingencia que su
    // plantilla declara.
    //
    // No se captura el error (§2.1): el componente decide el mensaje.
    isLoading.value = true;

    try {
      const detail = await workflowTemplatesService.fetchWorkflowTemplate(templateId);
      const schema = detail.pipelineSchema as unknown as Partial<AssembledPipelineSchema>;

      hydrateErrorBranches(schema.nodes ?? {});
      applyTemplateParams(schema.nodes ?? {});
    } finally {
      isLoading.value = false;
    }
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
    // Del FLUJO y no de su plantilla: la plantilla pudo cambiar despues, y lo
    // que se esta editando es el grafo que el flujo lleva copiado.
    executionPolicy.value = workflow.pipelineSchema?.executionPolicy ?? null;
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

    hydrateErrorBranches(nodes);
    syncUpstreamNamespaces();
  };

  /**
   * Reconstruye las ramas y el satelite desde el grafo guardado.
   *
   * Es imprescindible para poder EDITAR un flujo con contingencias: `topology`
   * solo trae el camino activo, asi que sin esto el asistente abriria sin ramas
   * y guardar las borraria junto con su nodo de alerta — el operador perderia la
   * configuracion con solo abrir el flujo y volver a cerrarlo.
   *
   * La intencion se deduce de la forma de la ruta, que es la inversa exacta de
   * `buildErrorRoute`: una cadena solo puede venir de "cualquier fallo", y un
   * objeto selectivo se reconoce por el codigo que nombra. Una ruta escrita a
   * mano que no encaje en el catalogo se IGNORA en vez de adivinarse: el
   * asistente no la mostraria bien, y reensamblarla desde una intencion
   * equivocada la reescribiria en el esquema.
   */
  const hydrateErrorBranches = (nodes: Record<string, AssembledPipelineNode>): void => {
    const recovered: Record<string, ErrorBranch> = {};

    for (const step of pipelineTopology.value) {
      const route = nodes[step.nodeId]?.onErrorStep;
      const targetNode = errorRouteTarget(route);

      if (targetNode === null) continue;

      const action = (Object.keys(ERROR_BRANCH_ACTIONS) as ErrorBranchAction[]).find(
        (candidate) =>
          nodes[targetNode]?.nodeType === ERROR_BRANCH_ACTIONS[candidate].targetNodeType,
      );

      if (action === undefined) continue;

      const catchCode = typeof route === 'string' ? null : (route?.catchErrors[0] ?? null);
      const trigger = (Object.keys(ERROR_BRANCH_TRIGGERS) as ErrorBranchTrigger[]).find(
        (candidate) => ERROR_BRANCH_TRIGGERS[candidate].catchCode === catchCode,
      );

      if (trigger === undefined) continue;

      recovered[step.nodeId] = { trigger, action };
    }

    errorBranches.value = recovered;

    // El interruptor del nodo fuente se mueve A LA VEZ, y tiene que ser asi: la
    // regla 10 del validador rechaza al guardar una ruta que atrapa un codigo
    // que el nodo, con sus `params`, no puede emitir. Se le pide al propio store
    // con `declareCaughtErrorCodes` en vez de escribirle la config —§3.1 prohibe
    // al agregador conocer la forma interna de un nodo—, y se le pasa la lista
    // completa, vacia incluida, para que un paso SIN ruta tambien quede apagado.
    for (const step of pipelineTopology.value) {
      const catchCode =
        ERROR_BRANCH_TRIGGERS[recovered[step.nodeId]?.trigger ?? 'CUALQUIER_FALLO'].catchCode;
      const declared =
        recovered[step.nodeId] === undefined || catchCode === null ? [] : [catchCode];

      resolveNodeStore(step.nodeType, step.nodeId)?.declareCaughtErrorCodes?.(declared);
    }

    // El satelite no esta en `topology` —solo se llega a el por la ruta—, asi
    // que su configuracion hay que ir a buscarla al mapa de nodos.
    const alertNode = nodes[SHARED_ALERT_NODE_ID];

    if (alertNode !== undefined) {
      useSmtpAlertStore(SHARED_ALERT_NODE_ID).hydrateFromNode({
        outputNamespace: alertNode.outputNamespace,
        params: alertNode.params,
      });
    }
  };

  /**
   * Reparte a cada store de nodo los `params` base que sembro la plantilla.
   *
   * Hasta ahora el asistente los ignoraba por completo: `selectTemplate` arma la
   * topologia desde `template.topology`, que es una proyeccion PARCIAL sin
   * `params`. El resultado era que una plantilla podia fijar un valor
   * estructural —el buzon, la ingesta de adjuntos— y el flujo instanciado nacia
   * sin el.
   *
   * Importa mas desde que una ruta de contingencia puede DEPENDER de uno: la
   * vision IA lee `raw_email.attachments`, que solo existen si el disparador los
   * ingiere. Sin este reparto, el asistente creaba flujos con la ruta declarada
   * y la ingesta apagada — pasaban la validacion y fallaban mudos.
   *
   * Canal aparte de `hydrateFromNode` a proposito (ver `applyTemplateParams` en
   * el contrato de `node-store-registry.ts`).
   *
   * @param nodes Mapa de nodos del `pipeline_schema` de la plantilla.
   */
  const applyTemplateParams = (nodes: Record<string, AssembledPipelineNode>): void => {
    for (const step of pipelineTopology.value) {
      const params = nodes[step.nodeId]?.params;

      if (params === undefined) continue;

      resolveNodeStore(step.nodeType, step.nodeId)?.applyTemplateParams?.(params);
    }
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
      // El catalogo ANTES de hidratar, por el mismo motivo que en
      // `loadAvailableTemplates`: `hydrateForEdit` termina sincronizando el
      // contexto aguas arriba, y sin los campos ya cargados lo sincronizaria
      // vacio.
      const [workflow] = await Promise.all([
        workflowsService.fetchWorkflow(workflowId),
        useNodeCatalogStore().fetchCatalog(),
      ]);

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

  /** Lleva el cursor al paso que configura un nodo concreto, si existe. */
  const goToNodeStep = (nodeId: string): void => {
    const index = pipelineTopology.value.findIndex((step) => step.nodeId === nodeId);

    if (index === -1) return;

    activeStep.value = index;
  };

  /** Retrocede sin validar: volver atras a corregir siempre debe ser posible. */
  const goToPreviousStep = (): void => {
    if (isFirstStep.value) return;

    activeStep.value -= 1;
  };

  /**
   * Pasos que impiden guardar, cada uno con SU motivo.
   *
   * Se pregunta a TODOS y no solo al activo: el asistente permite retroceder, y
   * sin esta comprobacion se podria guardar un flujo tras haber vaciado un paso
   * anterior ya visitado.
   *
   * El motivo no es decorativo. Antes esto era una lista de pasos a secas y
   * mezclaba dos fracasos que el operador vive de forma opuesta: "te falta
   * rellenar un campo", que se arregla en dos clics, y "este tipo de nodo no
   * tiene estrategia en el motor", que no tiene arreglo posible desde el
   * asistente y obliga a editar la plantilla. Presentarlos igual dejaba al
   * operador reintentando algo imposible sin ninguna pista.
   */
  /** Primer paso del flujo de un tipo dado, o `null`. */
  const findStepByType = (nodeType: NodeType): WizardStep | null =>
    pipelineTopology.value.find((step) => step.nodeType === nodeType) ?? null;

  /**
   * Nodo que atiende una accion de respaldo, o `null` si no es expresable.
   *
   * La alerta reutiliza el `DESTINO_SMTP` de la topologia cuando la plantilla ya
   * lo trae y solo entonces provisiona el satelite compartido: la regla 5 del
   * validador prohibe que dos nodos escriban `smtp_result`, asi que crear uno
   * nuevo junto a un destino existente devolveria un 400.
   *
   * La vision NO provisiona nunca. Un `PROCESADOR_IA` satelite chocaria con el
   * del flujo en `llm_response` por la misma regla, y ademas ese tipo todavia no
   * tiene configurador con el que rellenar su prompt. Se apunta al que ya hay, y
   * si no hay ninguno la accion simplemente no esta disponible.
   */
  const resolveBranchTarget = (action: ErrorBranchAction): string | null => {
    const { targetNodeType, canProvision, provisionedNodeId } = ERROR_BRANCH_ACTIONS[action];
    const existing = findStepByType(targetNodeType);

    if (existing !== null) return existing.nodeId;

    // Cada accion trae su propio satelite: desde que son dos, devolver siempre
    // el de alerta mandaba la ruta de vision al nodo equivocado.
    return canProvision ? provisionedNodeId : null;
  };

  /**
   * Acciones declaradas que obligan a provisionar su satelite.
   *
   * Una accion cuyo destino YA esta en la topologia no aporta paso: el nodo
   * tiene el suyo propio y anadir otro lo duplicaria.
   */
  const provisionedBranchActions = computed<ErrorBranchAction[]>(() => {
    const declared = new Set(Object.values(errorBranches.value).map((branch) => branch.action));

    return (Object.keys(ERROR_BRANCH_ACTIONS) as ErrorBranchAction[]).filter(
      (action) =>
        declared.has(action) &&
        ERROR_BRANCH_ACTIONS[action].provisionedNodeId !== null &&
        findStepByType(ERROR_BRANCH_ACTIONS[action].targetNodeType) === null,
    );
  });

  /**
   * Pasos sinteticos de los satelites provisionados, en orden estable.
   *
   * Se declaran como `WizardStep` completos aunque no sean nodos de la
   * topologia para que los consumidores —el panel de bloqueos de la revision,
   * que salta al paso culpable— no tengan que distinguirlos del resto. El mismo
   * truco que usa el paso de revision, que tampoco corresponde a ningun nodo.
   *
   * Son una LISTA y ya no un caso especial: desde que la transcripcion tiene
   * tipo propio hay dos satelites posibles, y un flujo puede declarar los dos.
   */
  const contingencySteps = computed<WizardStep[]>(() =>
    provisionedBranchActions.value.flatMap<WizardStep>((action) => {
      const { provisionedNodeId, targetNodeType } = ERROR_BRANCH_ACTIONS[action];

      if (provisionedNodeId === null) return [];

      return [
        {
          nodeId: provisionedNodeId,
          nodeType: targetNodeType,
          outputNamespace: DEFAULT_OUTPUT_NAMESPACE_BY_NODE_TYPE[targetNodeType],
          name: CONTINGENCY_STEP_NAMES[action],
        },
      ];
    }),
  );

  /**
   * A donde devuelve el flujo un satelite que reincorpora.
   *
   * Es el `nextStep` del paso que lo invoca, y sale del ORDEN de la topologia:
   * el paso que fallo ya no se reejecuta, asi que el rescate continua por donde
   * el iba. `null` si lo invoca el ultimo paso —no hay nada despues— o si
   * ninguna ruta lo nombra.
   */
  const resolveRejoinTarget = (satelliteNodeId: string): string | null => {
    const callerIndex = pipelineTopology.value.findIndex(
      (step) =>
        resolveBranchTarget(getNodeErrorBranch(step.nodeId)?.action ?? 'ALERTA_SMTP') ===
          satelliteNodeId && getNodeErrorBranch(step.nodeId) !== null,
    );

    return callerIndex === -1 ? null : (pipelineTopology.value[callerIndex + 1]?.nodeId ?? null);
  };

  /** Indice absoluto del paso de un satelite, o `-1` si no se muestra. */
  const contingencyStepIndex = (nodeId: string): number => {
    const offset = contingencySteps.value.findIndex((step) => step.nodeId === nodeId);

    return offset === -1 ? -1 : pipelineTopology.value.length + offset;
  };

  /** Indice del paso de alerta, o `-1`. Lo consulta la tarjeta de la rama. */
  const alertStepIndex = computed<number>(() => contingencyStepIndex(SHARED_ALERT_NODE_ID));

  /**
   * Satelites a medio configurar.
   *
   * No es un adorno del cliente: `collectIncompleteParams` del backend recorre
   * el mapa ENTERO al activar el flujo, satelites incluidos, precisamente porque
   * «activar un flujo con una rama de error a medio configurar es el fallo que
   * se descubriria de madrugada». Sin esto el asistente dejaria guardar un flujo
   * que despues no se puede encender, y el operador tendria que adivinar por que.
   */
  const incompleteContingencySteps = computed<WizardStep[]>(() =>
    contingencySteps.value.filter(
      (step) => !(resolveNodeStore(step.nodeType, step.nodeId)?.isConfigValid ?? false),
    ),
  );

  /** Numero total de pasos CONFIGURABLES, sin contar la revision final. */
  const configurableStepCount = computed<number>(
    () => pipelineTopology.value.length + contingencySteps.value.length,
  );

  const invalidSteps = computed<InvalidStep[]>(() => {
    const steps = pipelineTopology.value.flatMap<InvalidStep>((step, index) => {
      const reason = resolveStepBlockReason(step);

      if (reason === null) return [];

      return [{ step, index, reason, message: STEP_BLOCK_MESSAGES[reason](step) }];
    });

    // Cada satelite se senala en SU paso y no en cada paso que lo invoca: desde
    // que el formulario vive en un solo sitio, repartir el bloqueo entre los
    // nodos fuente mandaria al operador a corregirlo donde ya no esta.
    for (const step of incompleteContingencySteps.value) {
      steps.push({
        step,
        index: contingencyStepIndex(step.nodeId),
        reason: 'ALERTA_INCOMPLETA',
        message: STEP_BLOCK_MESSAGES.ALERTA_INCOMPLETA(step),
      });
    }

    return steps;
  });

  const canSave = computed<boolean>(
    () => pipelineTopology.value.length > 0 && invalidSteps.value.length === 0,
  );

  /** Ruta de contingencia declarada para un paso, o `null`. */
  const getNodeErrorBranch = (nodeId: string): ErrorBranch | null =>
    errorBranches.value[nodeId] ?? null;

  /**
   * Si el paso se desvia a un nodo de PROCESAMIENTO y no a una alerta.
   *
   * Es lo que distingue una recuperacion funcional —el flujo sigue adelante por
   * otra via— de un aviso a una persona, que es terminal. Solo la primera se
   * dibuja junto al paso que la declara.
   */
  const hasContextualRecoveryBranch = (nodeId: string): boolean =>
    getNodeErrorBranch(nodeId)?.action === 'VISION_IA';

  /**
   * Validez de un paso CONTANDO la de su rama contextual.
   *
   * NO se enchufa al boton "Siguiente", y es deliberado: el nodo que recibe la
   * recuperacion es un paso POSTERIOR del asistente, asi que bloquear el avance
   * del paso que la declara dejaria el asistente en punto muerto —a ese nodo
   * solo se llega pasando por este—. La conjuncion se aplica donde si
   * corresponde, en `canSave`, que mira todos los pasos a la vez.
   */
  const getStepValidationStatus = (nodeId: string): boolean => {
    const step = pipelineTopology.value.find((candidate) => candidate.nodeId === nodeId);

    if (step === undefined) return false;

    const ownValidity = resolveNodeStore(step.nodeType, step.nodeId)?.isConfigValid ?? false;

    if (!ownValidity || !hasContextualRecoveryBranch(nodeId)) return ownValidity;

    const branch = getNodeErrorBranch(nodeId);
    const targetId = branch === null ? null : resolveBranchTarget(branch.action);
    const targetStep =
      targetId === null
        ? null
        : (pipelineTopology.value.find((candidate) => candidate.nodeId === targetId) ?? null);

    return targetStep === null
      ? ownValidity
      : (resolveNodeStore(targetStep.nodeType, targetStep.nodeId)?.isConfigValid ?? false);
  };

  /** Ruta de un paso en la forma que espera el esquema, o `null` si no la hay. */
  const buildErrorRoute = (nodeId: string): string | SelectiveErrorFallback | null => {
    const branch = errorBranches.value[nodeId];

    if (branch === undefined) return null;

    const targetNode = resolveBranchTarget(branch.action);

    if (targetNode === null) return null;

    const { catchCode } = ERROR_BRANCH_TRIGGERS[branch.trigger];

    // La CADENA y no un objeto con un codigo comodin: es la unica forma que el
    // motor trata como "atrapa cualquier fallo". Un `catchErrors` con un codigo
    // inventado se guarda sin protestar y no se dispara jamas.
    return catchCode === null ? targetNode : { targetNode, catchErrors: [catchCode] };
  };

  /**
   * Si algun paso esta bloqueado por algo que el operador NO puede arreglar aqui.
   *
   * Es lo que separa "termina de rellenar" de "esta plantilla no se puede
   * guardar tal cual": la vista usa este dato para decidir si ofrece ayuda o
   * manda a editar la plantilla.
   */
  const hasUnsupportedNodes = computed<boolean>(() =>
    invalidSteps.value.some((item) => item.reason !== 'CONFIGURACION_INCOMPLETA'),
  );

  /**
   * Avisos de TODOS los pasos, no solo del activo.
   *
   * Hermano de `invalidSteps` y deliberadamente separado: aquel IMPIDE guardar,
   * este solo pide confirmacion. Fundirlos obligaria a `InvalidStep` a cargar un
   * grado de severidad y a que cada consumidor de `invalidSteps` lo filtrase
   * para no tratar un aviso como un bloqueo.
   *
   * Se pregunta al nodo por su contrato (§3.1) en vez de inspeccionar su config:
   * el agregador no sabe —ni debe— que es `connectionVerified`.
   */
  const stepWarnings = computed<StepWarning[]>(() =>
    pipelineTopology.value.flatMap((step, index) => {
      const warnings = resolveNodeStore(step.nodeType, step.nodeId)?.configWarnings ?? [];

      return warnings.map((message) => ({ step, index, message }));
    }),
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
   *
   * Se empujan LOS DOS canales y cada store implementa el que necesita: el
   * mapeador solo el de nombres, el extractor web solo el de campos. Ambos son
   * opcionales en el contrato, asi que un nodo que no implemente ninguno —un
   * disparador, que es el primero del grafo y no tiene nada aguas arriba— no
   * paga nada por ello.
   */
  const syncUpstreamNamespaces = (): void => {
    pipelineTopology.value.forEach((step, index) => {
      const store = resolveNodeStore(step.nodeType, step.nodeId);

      store?.setAvailableUpstreamNamespaces?.(upstreamNamespaces(index));
      store?.setAvailableUpstreamContext?.(upstreamContext(index));
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
   * `onErrorStep` sale de `errorBranches`, traducido a la forma que el motor
   * espera: cadena para el respaldo incondicional, objeto selectivo cuando la
   * rama nombra un codigo concreto, y `null` en los pasos sin rama —que sigue
   * siendo el defecto correcto: el motor detiene la ejecucion donde falla.
   *
   * El nodo de alerta compartido se anade como SATELITE y no como un paso mas:
   * el encadenado es posicional, y colarlo en la secuencia lo pondria en el
   * camino feliz, enviando un aviso en cada ejecucion correcta.
   */
  const assemblePipelineSchema = (name: string): AssembledPipelineSchema => {
    // El encadenado (`entrypoint`, `nextStep`, `onErrorStep`) lo hace el helper
    // compartido: el editor de plantillas ensambla el mismo grafo desde otra
    // entrada, y dos implementaciones divergirian. Lo que aporta el agregador es
    // resolver los `params` de cada nodo pidiendoselos a su propio store.
    const steps = pipelineTopology.value.map((step) => ({
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      outputNamespace: step.outputNamespace,
      params: resolveNodeStore(step.nodeType, step.nodeId)?.toNodeParams() ?? {},
      onErrorStep: buildErrorRoute(step.nodeId),
    }));

    // Un satelite por accion provisionada. El `nextStep` distingue las dos
    // clases: la alerta es terminal, y la transcripcion devuelve el flujo al
    // curso que llevaba el paso que la invoca.
    const satellites: AssemblerStep[] = contingencySteps.value.map((step) => {
      const action = provisionedBranchActions.value.find(
        (candidate) => ERROR_BRANCH_ACTIONS[candidate].provisionedNodeId === step.nodeId,
      );
      const rejoins = action !== undefined && ERROR_BRANCH_ACTIONS[action].rejoinsFlow;

      return {
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        outputNamespace: step.outputNamespace,
        params: resolveNodeStore(step.nodeType, step.nodeId)?.toNodeParams() ?? {},
        nextStep: rejoins ? resolveRejoinTarget(step.nodeId) : null,
        // Un satelite tambien falla, y hasta ahora salia con `onErrorStep: null`
        // a ciegas: si la transcripcion no sacaba texto, el motor no encontraba
        // ruta y PAUSABA el flujo teniendo al lado una alerta provisionada.
        onErrorStep:
          action === undefined
            ? null
            : resolveSatelliteErrorRoute(action, provisionedBranchActions.value),
      };
    });

    return buildPipelineSchema(
      steps,
      {
        // El backend ignora este `flowId` y asigna el de la fila que crea; viaja
        // porque `PipelineSchemaDto` lo exige y la plantilla de origen es la
        // referencia mas honesta hasta que exista la fila nueva.
        flowId: selectedTemplateId.value ?? '',
        name,
        version: INITIAL_SCHEMA_VERSION,
        // Sin esto la politica moriria aqui: el asistente reconstruye el esquema
        // desde los pasos, de modo que un campo raiz que no se reenvie no llega
        // nunca al flujo, y configurarla en la plantilla no serviria de nada.
        ...(executionPolicy.value !== null ? { executionPolicy: executionPolicy.value } : {}),
      },
      satellites,
    );
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
      // Se nombra el motivo de cada paso y no solo su etiqueta: este error
      // termina en un `$q.notify`, y "Disparador IMAP" a secas no dice si falta
      // rellenar algo o si el tipo no es ejecutable.
      throw new Error(
        `Hay ${invalidSteps.value.length} paso(s) que impiden guardar: ${invalidSteps.value
          .map((item) => `${item.step.name} (${item.message})`)
          .join(' ')}`,
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

    // El satelite tambien, y por el mismo motivo: su instancia sobrevive a la
    // topologia que la creo, asi que sin esto un flujo nuevo arrancaria con los
    // destinatarios del anterior ya puestos.
    useSmtpAlertStore(SHARED_ALERT_NODE_ID).resetConfig();
    errorBranches.value = {};
  };

  const resetDraft = (): void => {
    resetNodeStores();

    // Sin esto, abandonar una edicion y empezar un alta guardaria el flujo nuevo
    // ENCIMA del que se estaba editando.
    editingWorkflowId.value = null;
    selectedTemplateId.value = null;
    executionPolicy.value = null;
    pipelineTopology.value = [];
    activeStep.value = 0;
  };

  return {
    availableTemplates,
    selectedTemplateId,
    executionPolicy,
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
    hasUnsupportedNodes,
    stepWarnings,
    errorBranches,
    provisionedBranchActions,
    contingencySteps,
    contingencyStepIndex,
    incompleteContingencySteps,
    alertStepIndex,
    configurableStepCount,
    isContingencyStep,
    resolveBranchTarget,
    getNodeErrorBranch,
    hasContextualRecoveryBranch,
    getStepValidationStatus,
    goToNodeStep,
    upstreamNamespaces,
    upstreamContext,
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
