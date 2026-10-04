// @vitest-environment happy-dom
//
// Necesita DOM porque el store del nodo consulta `useSessionStore` para saber
// si el usuario puede elegir modelos de pago, y esa cadena llega a
// `LocalStorage` de Quasar, que toca `window`.

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useParserEmailStore } from '@stores/nodes/parser-email.store';
import { useSmtpAlertStore } from '@stores/nodes/smtp-alert.store';
import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

import { OCR_STEP_NAME, useFlujoDraftStore } from './flujo-draft.store';
import { useOcrProcessorStore } from '@stores/nodes/ocr-processor.store';

import { NodeCategory } from '@/types/node-catalog';
import { NodeType } from '@/types/pipeline';
import {
  MULTIMODAL_FALLBACK_CODE,
  SHARED_ALERT_NODE_ID,
  SHARED_OCR_NODE_ID,
} from '@/types/nodes/error-branch.types';

import type { NodeCatalogEntry } from '@/types/node-catalog';
import type {
  PipelineSummary,
  WorkflowDetail,
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
} from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
// `useSessionStore` llega aqui por el selector de modelo, que consulta el rol
// para deshabilitar los modelos de pago. Se dobla el SERVICIO y no axios:
// `@boot/axios` importa `#q-app`, que no resuelve fuera del build de Quasar.
vi.mock('@services/auth.service', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
  refreshSession: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
  fetchWorkflowTemplate: vi.fn(),
}));
vi.mock('@services/workflows.service', () => ({
  createWorkflow: vi.fn(),
  fetchWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));
vi.mock('@services/nodes/trigger-imap.service', () => ({
  checkImapConnection: vi.fn(),
}));
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
}));
vi.mock('@services/nodes/parser-email.service', () => ({
  checkParser: vi.fn(),
}));
vi.mock('@services/nodes/llm-extractor.service', () => ({
  fetchLlmModels: vi.fn(),
  testLlmConnection: vi.fn(),
}));
vi.mock('@services/nodes/web-scraper.service', () => ({
  checkScraper: vi.fn(),
}));
// El agregador consulta el catalogo de nodos para componer `upstreamContext`.
// El store del nodo de IA consume el catalogo de prompts, asi que el
// registro de stores lo arrastra hasta aqui.
vi.mock('@services/ai-prompt-templates.service', () => ({
  fetchAiPromptTemplates: vi.fn(),
  fetchAiPromptTemplateById: vi.fn(),
}));
vi.mock('@services/node-catalog.service', () => ({
  fetchNodeCatalog: vi.fn(),
}));

const workflowTemplatesService = await import('@services/workflow-templates.service');
const fetchWorkflowTemplates = vi.mocked(workflowTemplatesService.fetchWorkflowTemplates);
const fetchWorkflowTemplate = vi.mocked(workflowTemplatesService.fetchWorkflowTemplate);

const nodeCatalogService = await import('@services/node-catalog.service');
const fetchNodeCatalog = vi.mocked(nodeCatalogService.fetchNodeCatalog);

const workflowsService = await import('@services/workflows.service');
const fetchWorkflow = vi.mocked(workflowsService.fetchWorkflow);
const updateWorkflow = vi.mocked(workflowsService.updateWorkflow);
const createWorkflow = vi.mocked(workflowsService.createWorkflow);

const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TEMPLATE_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';

// `nodeId` de la topologia de prueba. Los stores de nodo se instancian POR
// `nodeId`, asi que una prueba que resuelva el store con otro identificador
// mirara una instancia vacia distinta de la que el borrador esta usando.
const TRIGGER_NODE_ID = 'trigger_imap';
const PARSER_NODE_ID = 'nodo_parser';

/** Flujo YA GUARDADO que el asistente abre en modo edicion. */
const WORKFLOW_ID = 'e1d2c3b4-a596-4f80-9c1d-2e3f4a5b6c7d';

/** Plantilla HTML que el nodo mapeador tiene elegida en ese flujo. */
const HTML_TEMPLATE_ID = 'a7b8c9d0-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const MAPPER_NODE_ID = 'nodo_mapeador';

/** Plantilla de tres pasos: trigger -> parser -> mapeador. */
const buildTemplate = (
  overrides: Partial<WorkflowTemplateSummary> = {},
): WorkflowTemplateSummary => ({
  id: TEMPLATE_ID,
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  active: true,
  topology: [
    {
      nodeId: TRIGGER_NODE_ID,
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
    },
    {
      nodeId: PARSER_NODE_ID,
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
    },
    {
      nodeId: MAPPER_NODE_ID,
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
    },
  ],
  ...overrides,
});

/**
 * Topologia con un tipo de nodo que SIGUE sin configurador.
 *
 * Existe porque `PARSER_PRE_IA`, `EXTRACTOR_WEB` y ahora `PROCESADOR_IA` fueron
 * dejando de serlo al implementarse sus triadas. El caso "nodo no ejecutable"
 * tiene que probarse contra un tipo que de verdad no tenga store registrado, o
 * la prueba pasaria a verificar lo contrario de lo que su nombre dice.
 *
 * Toca ahora a `ESCUDO_POST_IA`, que ademas no tiene estrategia en el motor, asi
 * que su turno tardara. La constante seguira rotando conforme cada tipo reciba
 * su triada; el ultimo de la cola es `DESTINO_HTTP`.
 *
 * La topologia por defecto NO se toca: las pruebas de namespaces aguas arriba
 * dependen de que el parser siga aportando `parsed_email` antes del mapeador.
 */
const UNSUPPORTED_NODE_ID = 'nodo_escudo';

const UNSUPPORTED_TOPOLOGY = [
  {
    nodeId: TRIGGER_NODE_ID,
    nodeType: NodeType.TRIGGER_IMAP,
    outputNamespace: 'raw_email',
  },
  {
    nodeId: UNSUPPORTED_NODE_ID,
    nodeType: NodeType.ESCUDO_POST_IA,
    outputNamespace: 'validated_drupal_json',
  },
];

/**
 * Flujo ya instanciado, tal como lo devuelve `POST /api/workflows`.
 *
 * Distinto del de la plantilla y no por capricho: un flujo lleva `templateId`
 * —la procedencia— y una plantilla no. Reutilizar un solo fixture ocultaria
 * justo la frontera que esta entrega establece.
 */
const buildWorkflow = (overrides: Partial<PipelineSummary> = {}): PipelineSummary => ({
  id: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  active: false,
  templateId: TEMPLATE_ID,
  topology: [],
  ...overrides,
});

/** Borrador con el catalogo cargado y un pipeline ya elegido. */
/**
 * Catalogo doble: solo los dos tipos cuyos campos interesan a las pruebas.
 *
 * Se siembra en `buildSelectedDraft` porque `loadAvailableTemplates` lo pide en
 * paralelo con las plantillas: es de ahi de donde `upstreamContext` saca los
 * campos de cada namespace.
 */
const CATALOG_ENTRIES: NodeCatalogEntry[] = [
  {
    id: 'cat-trigger',
    code: NodeType.TRIGGER_IMAP,
    name: 'Disparador IMAP',
    category: NodeCategory.TRIGGER,
    description: null,
    implemented: true,
    outputFields: [{ name: 'subject', type: 'text' }],
  },
  {
    id: 'cat-parser',
    code: NodeType.PARSER_PRE_IA,
    name: 'Parser pre-IA',
    category: NodeCategory.PROCESAMIENTO,
    description: null,
    implemented: true,
    outputFields: [{ name: 'extracted_urls', type: 'url[]' }],
  },
];

/**
 * Detalle de plantilla con las rutas de contingencia que se le indiquen.
 *
 * Desde que `onErrorStep` es propiedad de la PLANTILLA, esta es la unica via por
 * la que el asistente conoce una rama: el store ya no expone ningun `setter`, y
 * seguir escribiendo `errorBranches` a mano en las pruebas comprobaria un camino
 * que la aplicacion no recorre.
 *
 * El nodo satelite se declara solo si alguna ruta lo nombra, igual que hace el
 * editor de plantillas.
 *
 * @param routes Ruta por `nodeId` que se desvia.
 * @param template Topologia de la que derivar el mapa de nodos.
 */
const buildTemplateDetail = (
  routes: Record<string, unknown> = {},
  template: WorkflowTemplateSummary = buildTemplate(),
): WorkflowTemplateDetail => {
  const steps = template.topology;
  const nodes: Record<string, unknown> = {};

  steps.forEach((step, index) => {
    nodes[step.nodeId] = {
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      outputNamespace: step.outputNamespace,
      nextStep: steps[index + 1]?.nodeId ?? null,
      onErrorStep: routes[step.nodeId] ?? null,
      params: {},
    };
  });

  const referencesAlert = Object.values(routes).some((route) =>
    typeof route === 'string'
      ? route === SHARED_ALERT_NODE_ID
      : (route as { targetNode?: string } | null)?.targetNode === SHARED_ALERT_NODE_ID,
  );

  const referencesOcr = Object.values(routes).some(
    (route) =>
      typeof route === 'object' &&
      (route as { targetNode?: string } | null)?.targetNode === SHARED_OCR_NODE_ID,
  );

  if (referencesOcr) {
    nodes[SHARED_OCR_NODE_ID] = {
      nodeId: SHARED_OCR_NODE_ID,
      nodeType: NodeType.PROCESADOR_OCR,
      outputNamespace: 'ocr_result',
      // REINCORPORA: a diferencia de la alerta, devuelve el flujo a su curso.
      nextStep: steps[1]?.nodeId ?? null,
      onErrorStep: null,
      params: {},
    };
  }

  if (referencesAlert) {
    nodes[SHARED_ALERT_NODE_ID] = {
      nodeId: SHARED_ALERT_NODE_ID,
      nodeType: NodeType.DESTINO_SMTP,
      outputNamespace: 'smtp_result',
      nextStep: null,
      onErrorStep: null,
      params: {},
    };
  }

  return {
    ...template,
    pipelineSchema: {
      flowId: 'plantilla',
      name: template.name,
      version: '1.0.0',
      entrypoint: steps[0]?.nodeId ?? '',
      nodes,
    },
  };
};

/** Ruta incondicional hacia el nodo de alerta compartido. */
const ALERT_ROUTE = SHARED_ALERT_NODE_ID;

/** Ruta selectiva de vision, la unica que atrapa el codigo del parser. */
const VISION_ROUTE = {
  targetNode: SHARED_OCR_NODE_ID,
  catchErrors: [MULTIMODAL_FALLBACK_CODE],
};

/**
 * Borrador con las rutas de contingencia que declara su PLANTILLA.
 *
 * Es la unica via por la que el asistente conoce una rama desde que
 * `onErrorStep` pertenece a la plantilla: el store dejo de exponer un `setter`,
 * asi que escribir `errorBranches` a mano aqui comprobaria un camino que la
 * aplicacion ya no recorre.
 *
 * @param routes Ruta por `nodeId` que se desvia.
 * @param template Topologia de la que partir; por defecto la de tres pasos.
 */
const buildDraftWithBranches = async (
  routes: Record<string, unknown>,
  template: WorkflowTemplateSummary = buildTemplate(),
): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();

  fetchWorkflowTemplates.mockResolvedValue([template]);
  fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);
  fetchWorkflowTemplate.mockResolvedValue(buildTemplateDetail(routes, template));

  await draft.loadAvailableTemplates();
  await draft.selectTemplate(template.id);

  return draft;
};

const buildSelectedDraft = async (): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();
  fetchWorkflowTemplates.mockResolvedValue([buildTemplate()]);
  fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);
  await draft.loadAvailableTemplates();
  await draft.selectTemplate(TEMPLATE_ID);

  return draft;
};

/**
 * Deja el store del trigger indicado en estado valido y con la conexion probada.
 *
 * El `nodeId` es un parametro y no una constante porque las pruebas de
 * aislamiento (bloque 10) necesitan configurar dos disparadores distintos con
 * valores distintos.
 */
const verifyTriggerStore = (nodeId: string = TRIGGER_NODE_ID, host = 'imap.unuware.com'): void => {
  const trigger = useTriggerImapStore(nodeId);
  trigger.patchConfig({
    host,
    user: 'notiweb@unuware.com',
    passwordEnvKey: 'IMAP_PASSWORD',
  });
  trigger.connectionVerified = true;
};

describe('useFlujoDraftStore · agregador del asistente', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // Por defecto, una plantilla SIN rutas de contingencia: `selectTemplate`
    // pide el detalle para hidratarlas, y sin este doble toda seleccion fallaria.
    fetchWorkflowTemplate.mockResolvedValue(buildTemplateDetail());
  });

  describe('1. Carga del catalogo', () => {
    it('1.1 deberia cargar los pipelines seleccionables', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate()]);

      // 2. Act
      await draft.loadAvailableTemplates();

      // 3. Assert
      expect(draft.availableTemplates).toHaveLength(1);
      expect(draft.isLoading).toBe(false);
    });

    it('1.2 deberia apagar isLoading aunque el servicio lance', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockRejectedValue(new Error('500'));

      // 2. Act & 3. Assert: el error sube al componente, pero el `finally` deja
      //    el indicador apagado.
      await expect(draft.loadAvailableTemplates()).rejects.toThrow('500');
      expect(draft.isLoading).toBe(false);
    });
  });

  describe('2. Seleccion de pipeline', () => {
    it('2.1 deberia fijar la topologia y arrancar en el primer paso', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert
      expect(draft.selectedTemplateId).toBe(TEMPLATE_ID);
      expect(draft.pipelineTopology).toHaveLength(3);
      expect(draft.activeStep).toBe(0);
    });

    it('2.2 deberia conservar el orden de ejecucion que envia el backend', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert
      expect(draft.pipelineTopology.map((step) => step.nodeId)).toEqual([
        'trigger_imap',
        'nodo_parser',
        'nodo_mapeador',
      ]);
    });

    it('2.3 deberia enriquecer cada paso con su etiqueta legible', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: `name` se deriva de NODE_TYPE_LABELS, no viaja por la red.
      expect(draft.pipelineTopology[0]?.name).toBe('Disparador IMAP');
      expect(draft.pipelineTopology[2]?.name).toBe('Mapeador de plantilla');
    });

    it('2.4 deberia resetear el cursor al cambiar de pipeline', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildTemplate(),
        buildTemplate({ id: OTHER_TEMPLATE_ID, name: 'Otro flujo' }),
      ]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);
      verifyTriggerStore();
      draft.goToNextStep();
      expect(draft.activeStep).toBe(1);

      // 2. Act
      await draft.selectTemplate(OTHER_TEMPLATE_ID);

      // 3. Assert: arrastrar el cursor mostraria el paso 2 de un flujo distinto.
      expect(draft.activeStep).toBe(0);
      expect(draft.selectedTemplateId).toBe(OTHER_TEMPLATE_ID);
    });

    it('2.5 deberia ignorar un pipelineId que no esta en el catalogo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      await draft.selectTemplate('id-inexistente');

      // 3. Assert
      expect(draft.selectedTemplateId).toBe(TEMPLATE_ID);
    });
  });

  describe('3. Delegacion de la validez al store del nodo', () => {
    it('3.1 deberia ser invalido si el store del nodo activo lo es', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: el trigger arranca sin configurar, asi que el asistente no
      //    debe dejar avanzar.
      expect(draft.activeStepDefinition?.nodeType).toBe(NodeType.TRIGGER_IMAP);
      expect(draft.isActiveStepValid).toBe(false);
    });

    it('3.2 deberia volverse valido cuando el store del nodo se declara valido', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      verifyTriggerStore();

      // 3. Assert: el asistente PREGUNTA, no reimplementa la validacion.
      expect(draft.isActiveStepValid).toBe(true);
    });

    it('3.3 deberia ser invalido en un paso cuyo tipo no tiene store registrado', async () => {
      // 1. Arrange: topologia con PROCESADOR_IA, que sigue sin configurador.
      //    Antes se probaba contra PARSER_PRE_IA y despues contra EXTRACTOR_WEB,
      //    pero los dos ya tienen triada: sin rotar el fixture, esta prueba
      //    pasaria a verificar lo contrario de lo que su nombre dice.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate({ topology: UNSUPPORTED_TOPOLOGY })]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);
      verifyTriggerStore();

      // 2. Act
      draft.goToNextStep();

      // 3. Assert: sin configurador no hay forma de declararlo valido, y dejar
      //    avanzar seria ensamblar un pipeline con un nodo sin configurar.
      expect(draft.activeStepDefinition?.nodeType).toBe(NodeType.ESCUDO_POST_IA);
      expect(draft.isActiveStepValid).toBe(false);
    });

    it('3.4 deberia ser invalido sin pipeline elegido', () => {
      // 1. Arrange & 2. Act
      const draft = useFlujoDraftStore();

      // 3. Assert
      expect(draft.activeStepDefinition).toBeNull();
      expect(draft.isActiveStepValid).toBe(false);
    });
  });

  describe('4. Navegacion del stepper', () => {
    it('4.1 no deberia avanzar si el paso activo es invalido', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.goToNextStep();

      // 3. Assert: la guarda vive en el store y no solo en el `:disable` del
      //    boton; el estado no debe depender de que la vista se acuerde.
      expect(draft.activeStep).toBe(0);
    });

    it('4.2 deberia avanzar cuando el paso activo es valido', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act
      draft.goToNextStep();

      // 3. Assert
      expect(draft.activeStep).toBe(1);
    });

    it('4.3 deberia permitir retroceder sin validar', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      draft.goToNextStep();

      // 2. Act
      draft.goToPreviousStep();

      // 3. Assert: volver atras a corregir siempre debe ser posible.
      expect(draft.activeStep).toBe(0);
    });

    it('4.4 no deberia retroceder mas alla del primer paso', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.goToPreviousStep();

      // 3. Assert
      expect(draft.activeStep).toBe(0);
      expect(draft.isFirstStep).toBe(true);
    });

    it('4.5 deberia reconocer el ultimo paso', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.activeStep = 2;

      // 3. Assert
      expect(draft.isLastStep).toBe(true);
    });
  });

  describe('5. Namespaces aguas arriba', () => {
    it('5.1 deberia devolver una lista vacia para el primer paso', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: el disparador no tiene nada por delante.
      expect(draft.upstreamNamespaces(0)).toEqual([]);
    });

    it('5.2 deberia acumular los namespaces de los pasos anteriores', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert
      expect(draft.upstreamNamespaces(1)).toEqual(['raw_email']);
      expect(draft.upstreamNamespaces(2)).toEqual(['raw_email', 'parsed_email']);
    });

    it('5.3 no deberia incluir el namespace del propio paso', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: un nodo no puede leer su propia salida.
      expect(draft.upstreamNamespaces(2)).not.toContain('rendered_html');
    });

    it('5.4 deberia cruzar cada namespace anterior con sus campos del catalogo', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: el frontend NO replica la forma de ningun payload; pregunta
      //    al catalogo, que publica lo que declara cada estrategia. Viaja tambien
      //    el `nodeType`, con el que el consumidor etiqueta el origen.
      expect(draft.upstreamContext(2)).toEqual([
        {
          namespace: 'raw_email',
          nodeType: NodeType.TRIGGER_IMAP,
          fields: [{ name: 'subject', type: 'text' }],
        },
        {
          namespace: 'parsed_email',
          nodeType: NodeType.PARSER_PRE_IA,
          fields: [{ name: 'extracted_urls', type: 'url[]' }],
        },
      ]);
    });

    it('5.5 tampoco deberia incluir el propio paso en el contexto rico', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert: misma regla que `upstreamNamespaces`, y el disparador no
      //    tiene nada por delante.
      expect(draft.upstreamContext(0)).toEqual([]);
      expect(draft.upstreamContext(2).map((item) => item.namespace)).not.toContain('rendered_html');
    });

    it('5.6 deberia devolver campos vacios para un tipo que el catalogo no cubre', async () => {
      // 1. Arrange: es lo que pasa con un tipo sin estrategia, o si el catalogo
      //    aun no ha cargado.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate()]);
      fetchNodeCatalog.mockResolvedValue([]);

      // 2. Act
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 3. Assert: vacio significa "no hay nada que ofrecer todavia", nunca un
      //    error; el namespace sigue estando.
      expect(draft.upstreamContext(2)).toEqual([
        { namespace: 'raw_email', nodeType: NodeType.TRIGGER_IMAP, fields: [] },
        { namespace: 'parsed_email', nodeType: NodeType.PARSER_PRE_IA, fields: [] },
      ]);
    });
  });

  describe('6. Reseteo', () => {
    it('6.1 deberia limpiar la seleccion y el cursor', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      draft.goToNextStep();

      // 2. Act
      draft.resetDraft();

      // 3. Assert
      expect(draft.selectedTemplateId).toBeNull();
      expect(draft.pipelineTopology).toEqual([]);
      expect(draft.activeStep).toBe(0);
    });

    it('6.2 deberia conservar el catalogo cargado', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.resetDraft();

      // 3. Assert: volver al selector no debe obligar a otra peticion HTTP.
      expect(draft.availableTemplates).toHaveLength(1);
    });
  });

  describe('7. Sincronizacion de namespaces aguas arriba', () => {
    it('7.1 deberia exponer raw_email al mapeador al elegir el pipeline', async () => {
      // 1. Arrange & 2. Act
      await buildSelectedDraft();

      // 3. Assert: el mapeador es el tercer paso, asi que recibe los namespaces
      //    de los dos anteriores. Antes de esta conexion usaba una lista fija
      //    marcada PROVISIONAL y validaba contra namespaces inventados.
      // Se comprueba por el canal RICO: el mapeador dejo de implementar el de
      // solo-nombres al retirarse su contrato de variables, y lo que esta
      // prueba vigila es que el ANFITRION recalcule, no por que canal viaja.
      const mapper = useTemplateMapperStore(MAPPER_NODE_ID);
      expect(mapper.availableUpstreamContext.map(({ namespace }) => namespace)).toEqual([
        'raw_email',
        'parsed_email',
      ]);
    });

    it('7.2 no deberia fallar con nodos que no declaran el metodo', async () => {
      // 1. Arrange & 2. Act: el trigger no tiene
      //    `setAvailableUpstreamNamespaces` porque es el primero del grafo.
      const draft = await buildSelectedDraft();

      // 3. Assert: la llamada opcional no revienta.
      expect(() => draft.syncUpstreamNamespaces()).not.toThrow();
    });

    it('7.3 deberia recalcular al cambiar de pipeline', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      const shortPipeline = buildTemplate({
        id: OTHER_TEMPLATE_ID,
        topology: [
          {
            nodeId: MAPPER_NODE_ID,
            nodeType: NodeType.MAPEADOR_PLANTILLA,
            outputNamespace: 'rendered_html',
          },
        ],
      });
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate(), shortPipeline]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 2. Act
      await draft.selectTemplate(OTHER_TEMPLATE_ID);

      // 3. Assert: en el pipeline corto el mapeador es el primero, asi que no
      //    tiene nada aguas arriba. Arrastrar la lista anterior le haria creer
      //    que `raw_email` existe en un flujo donde nadie lo produce.
      const mapper = useTemplateMapperStore(MAPPER_NODE_ID);
      expect(mapper.availableUpstreamContext).toEqual([]);
    });
  });

  describe('8. Ensamblado del pipeline_schema', () => {
    it('8.1 deberia recolectar los params de cada store de nodo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: la conexion y los criterios de disparo salen del store del
      //    trigger, no de una copia que mantuviera el agregador. Los filtros
      //    vacios no viajan; el DTO del backend los rechaza con `@IsNotEmpty()`.
      expect(schema.nodes.trigger_imap?.params).toEqual({
        host: 'imap.unuware.com',
        port: 993,
        secure: true,
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
        mailbox: 'INBOX',
        pollIntervalMs: 60_000,
        unreadOnly: true,
        // Llega hasta aqui porque el store del trigger lo publica: es la prueba
        // de que el toggle de la plantilla sobrevive al instanciar el flujo, en
        // vez de perderse al reconstruir los `params`.
        includeAttachments: false,
      });
    });

    it('8.2 no deberia duplicar outputNamespace dentro de params', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: en el esquema es propiedad del NODO. Publicarlo tambien en
      //    `params` crearia dos fuentes de verdad dentro del mismo JSON.
      expect(schema.nodes.trigger_imap?.outputNamespace).toBe('raw_email');
      expect(schema.nodes.trigger_imap?.params).not.toHaveProperty('outputNamespace');
    });

    it('8.3 deberia encadenar nextStep siguiendo el orden de la topologia', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert
      expect(schema.entrypoint).toBe('trigger_imap');
      expect(schema.nodes.trigger_imap?.nextStep).toBe('nodo_parser');
      expect(schema.nodes.nodo_parser?.nextStep).toBe('nodo_mapeador');
      expect(schema.nodes.nodo_mapeador?.nextStep).toBeNull();
    });

    it('8.4 deberia dejar onErrorStep en null sin ramas declaradas', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: `null` es el defecto CORRECTO y no una limitacion. Sin rama,
      //    el motor detiene la ejecucion en el nodo que falla, que es lo que
      //    debe pasar mientras nadie declare a donde desviarse.
      for (const node of Object.values(schema.nodes)) {
        expect(node.onErrorStep).toBeNull();
      }
    });

    it('8.5 deberia declarar la version SemVer inicial', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: `SEMVER_PATTERN` del backend lo exige.
      expect(schema.version).toBe('1.0.0');
    });

    it('8.6 deberia heredar la executionPolicy de la plantilla elegida', async () => {
      // 1. Arrange: sin esto la politica moriria en el asistente. El borrador
      //    reconstruye el esquema desde los pasos, asi que un campo raiz que no
      //    se reenvie no llega nunca al flujo, y configurarla en la plantilla no
      //    serviria absolutamente de nada.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildTemplate({ executionPolicy: { stopOnFirstSuccess: true } }),
      ]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert
      expect(schema.executionPolicy).toEqual({ stopOnFirstSuccess: true });
    });

    it('8.7 deberia OMITIR la clave cuando la plantilla no declara politica', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: el backend valida con `forbidNonWhitelisted`; emitir un
      //    objeto vacio seria una declaracion indistinguible de una a medias.
      expect(Object.hasOwn(schema, 'executionPolicy')).toBe(false);
    });
  });

  describe('9. Guardado del flujo', () => {
    it('9.1 deberia rechazar el guardado con pasos sin configurar', async () => {
      // 1. Arrange: el trigger arranca con los campos sin rellenar.
      const draft = await buildSelectedDraft();

      // 2. Act & 3. Assert: la guarda vive en el store y no solo en el
      //    `:disable` del boton; guardar un flujo a medias dejaria en la BD un
      //    esquema que revienta en su primera ejecucion.
      await expect(draft.assembleAndSaveWorkflow('Flujo incompleto')).rejects.toThrow(
        /impiden guardar/,
      );
      expect(createWorkflow).not.toHaveBeenCalled();
    });

    it('9.2 deberia nombrar los pasos invalidos en el error', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act & 3. Assert
      await expect(draft.assembleAndSaveWorkflow('Flujo incompleto')).rejects.toThrow(
        /Disparador IMAP/,
      );
    });

    it('9.3 deberia enviar nombre, descripcion y esquema ensamblado', async () => {
      // 1. Arrange: los tres pasos validos.
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      createWorkflow.mockResolvedValue(buildWorkflow({ id: 'nuevo-id' }));

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb v2', '  Con espacios  ');

      // 3. Assert
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Notiweb v2',
          description: 'Con espacios',
        }),
      );
      const payload = createWorkflow.mock.calls[0]?.[0];
      expect(payload?.pipelineSchema.nodes.trigger_imap?.nodeId).toBe('trigger_imap');
    });

    it('9.4 deberia omitir description cuando llega vacia', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      createWorkflow.mockResolvedValue(buildWorkflow());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb v2', '   ');

      // 3. Assert: con `exactOptionalPropertyTypes` la clave se omite en vez de
      //    enviarse como `undefined`, que el DTO backend rechazaria.
      expect(createWorkflow.mock.calls[0]?.[0]).not.toHaveProperty('description');
    });

    it('9.5 no deberia meter el flujo creado en el catalogo de plantillas', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      const created = buildWorkflow({ id: 'nuevo-id', name: 'Recien creado' });
      createWorkflow.mockResolvedValue(created);

      // 2. Act
      const result = await draft.assembleAndSaveWorkflow('Recien creado');

      // 3. Assert: el flujo se devuelve al llamante, que navega a `/flujos`. El
      //    catalogo del asistente son PLANTILLAS, y colar ahi una instancia la
      //    ofreceria como blueprint —el error que esta entrega vino a corregir.
      expect(result).toEqual(created);
      expect(draft.availableTemplates).toHaveLength(1);
      expect(draft.availableTemplates[0]?.id).toBe(TEMPLATE_ID);
    });

    it('9.6 deberia apagar isLoading aunque el guardado falle', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      createWorkflow.mockRejectedValue(new Error('400 Bad Request'));

      // 2. Act & 3. Assert
      await expect(draft.assembleAndSaveWorkflow('Notiweb v2')).rejects.toThrow('400 Bad Request');
      expect(draft.isLoading).toBe(false);
    });

    it('9.7 deberia exponer canSave e invalidSteps de forma coherente', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];

      // 3. Assert (antes)
      expect(draft.canSave).toBe(false);
      expect(draft.invalidSteps).toHaveLength(1);

      // 2. Act
      verifyTriggerStore();

      // 3. Assert (despues)
      expect(draft.canSave).toBe(true);
      expect(draft.invalidSteps).toEqual([]);
    });
  });

  describe('10. Aislamiento de la configuracion por nodo', () => {
    /** Pipeline con DOS disparadores IMAP: el caso que rompia el estado compartido. */
    const TWIN_TRIGGER_TOPOLOGY = [
      {
        nodeId: 'trigger_principal',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
      },
      {
        nodeId: 'trigger_secundario',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email_backup',
      },
    ];

    it('10.1 deberia dar una instancia independiente a cada nodeId', () => {
      // 1. Arrange
      const first = useTriggerImapStore('trigger_principal');
      const second = useTriggerImapStore('trigger_secundario');

      // 2. Act
      first.patchConfig({ host: 'imap.principal.com' });

      // 3. Assert: con un store por `nodeType` ambas referencias serian el mismo
      //    objeto y el segundo nodo habria heredado el host del primero.
      expect(first.config.host).toBe('imap.principal.com');
      expect(second.config.host).toBe('');
      // La definicion esta memoizada: el mismo `nodeId` devuelve el mismo store.
      expect(useTriggerImapStore('trigger_principal')).toBe(first);
    });

    it('10.2 deberia ensamblar params propios para dos nodos del mismo tipo', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildTemplate({ id: OTHER_TEMPLATE_ID, topology: TWIN_TRIGGER_TOPOLOGY }),
      ]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(OTHER_TEMPLATE_ID);
      verifyTriggerStore('trigger_principal', 'imap.principal.com');
      verifyTriggerStore('trigger_secundario', 'imap.backup.com');

      // 2. Act
      const schema = draft.assemblePipelineSchema('Dos buzones');

      // 3. Assert: cada nodo publica SU host. Antes, configurar el segundo
      //    sobrescribia el estado del primero y los dos nodos salian del
      //    ensamblado con la misma configuracion.
      expect(schema.nodes.trigger_principal?.params.host).toBe('imap.principal.com');
      expect(schema.nodes.trigger_secundario?.params.host).toBe('imap.backup.com');
    });

    it('10.3 deberia conservar todos los nodos de la topologia en el ensamblado', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Notiweb v2');

      // 3. Assert: regresion de la premisa que se reporto como mutacion
      //    destructiva. Los tres nodos sobreviven y la cadena esta completa de
      //    punta a punta, sin punteros a nodos ausentes.
      expect(Object.keys(schema.nodes)).toEqual([TRIGGER_NODE_ID, PARSER_NODE_ID, MAPPER_NODE_ID]);
      expect(schema.entrypoint).toBe(TRIGGER_NODE_ID);
      expect(schema.nodes[TRIGGER_NODE_ID]?.nextStep).toBe(PARSER_NODE_ID);
      expect(schema.nodes[PARSER_NODE_ID]?.nextStep).toBe(MAPPER_NODE_ID);
      expect(schema.nodes[MAPPER_NODE_ID]?.nextStep).toBeNull();
    });

    it('10.4 deberia limpiar los stores de nodo al resetear el borrador', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);
      expect(trigger.isConfigValid).toBe(true);

      // 2. Act
      draft.resetDraft();
      // El catalogo sobrevive al reseteo (prueba 6.2), asi que el operador puede
      // empezar otro flujo del mismo pipeline sin recargar la vista.
      await draft.selectTemplate(TEMPLATE_ID);

      // 3. Assert: el borrador nuevo arranca en blanco. La instancia del store
      //    vive en Pinia y sobrevive a la topologia, asi que sin la limpieza
      //    explicita el flujo nuevo saldria con los `params` del anterior y
      //    `canSave` en true sin haber tocado un solo campo.
      expect(trigger.config.host).toBe('');
      expect(trigger.connectionVerified).toBe(false);
      expect(trigger.isConfigValid).toBe(false);
      expect(draft.canSave).toBe(false);
    });

    it('10.5 no deberia arrastrar la configuracion al cambiar de pipeline', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildTemplate(),
        buildTemplate({ id: OTHER_TEMPLATE_ID, topology: TWIN_TRIGGER_TOPOLOGY }),
      ]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);
      verifyTriggerStore();

      // 2. Act
      await draft.selectTemplate(OTHER_TEMPLATE_ID);

      // 3. Assert: el trigger del pipeline abandonado queda limpio, y los dos
      //    del nuevo arrancan sin configurar.
      expect(useTriggerImapStore(TRIGGER_NODE_ID).config.host).toBe('');
      expect(draft.invalidSteps).toHaveLength(2);
      expect(draft.canSave).toBe(false);
    });
  });

  describe('11. Clonado inmutable de la plantilla', () => {
    it('11.1 no deberia compartir objetos entre el borrador y el catalogo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      const templateStep = draft.availableTemplates[0]?.topology[0];
      const draftStep = draft.pipelineTopology[0];

      // 3. Assert: mismos valores, objetos DISTINTOS. Compartir la referencia
      //    haria que retocar el borrador mutase el catalogo en memoria.
      expect(draftStep?.nodeId).toBe(templateStep?.nodeId);
      expect(draftStep).not.toBe(templateStep);
    });

    it('11.2 no deberia alterar la plantilla al mutar la topologia del borrador', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act: el asistente reordena o recorta pasos, como en las pruebas del
      //    bloque 9.
      draft.pipelineTopology = [draft.pipelineTopology[0]!];

      // 3. Assert: la plantilla del catalogo sigue teniendo sus tres nodos.
      expect(draft.availableTemplates[0]?.topology).toHaveLength(3);
    });

    it('11.3 deberia reconstruir el borrador desde la plantilla al reelegirla', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];

      // 2. Act: volver al selector y elegir la MISMA plantilla.
      draft.resetDraft();
      await draft.selectTemplate(TEMPLATE_ID);

      // 3. Assert: arranca de la plantilla intacta, no del recorte anterior.
      expect(draft.pipelineTopology).toHaveLength(3);
      expect(draft.pipelineTopology.map((step) => step.nodeId)).toEqual([
        TRIGGER_NODE_ID,
        PARSER_NODE_ID,
        MAPPER_NODE_ID,
      ]);
    });
  });

  describe('17. Rutas de contingencia (onErrorStep)', () => {
    const ALERT_RECIPIENT = 'guardia@unuware.com';

    /** Ruta selectiva de alerta, la que atrapa solo el codigo del parser. */
    const SELECTIVE_ALERT_ROUTE = {
      targetNode: SHARED_ALERT_NODE_ID,
      catchErrors: [MULTIMODAL_FALLBACK_CODE],
    };

    /** Deja el nodo de alerta compartido en estado valido. */
    const configureAlertNode = (): void => {
      useSmtpAlertStore(SHARED_ALERT_NODE_ID).updateConfig({ to: [ALERT_RECIPIENT] });
    };

    it('17.1 deberia conservar la forma de CADENA para cualquier fallo', async () => {
      // 1. Arrange 📐: es la unica forma que el motor trata como "atrapa todo".
      //    Un `catchErrors` con un codigo comodin inventado se guardaria sin
      //    protestar y no se dispararia jamas.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      configureAlertNode();

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      expect(schema.nodes[MAPPER_NODE_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
    });

    it('17.2 deberia conservar la forma SELECTIVA para un fallo concreto', async () => {
      // 1. Arrange 📐
      const draft = await buildDraftWithBranches({ [PARSER_NODE_ID]: SELECTIVE_ALERT_ROUTE });
      configureAlertNode();

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      expect(schema.nodes[PARSER_NODE_ID]?.onErrorStep).toEqual({
        targetNode: SHARED_ALERT_NODE_ID,
        catchErrors: [MULTIMODAL_FALLBACK_CODE],
      });
    });

    it('17.3 deberia encender el interruptor del nodo fuente al hidratar', async () => {
      // 1. Arrange 📐: sin esto la regla 10 del validador rechaza el esquema al
      //    guardar, porque la ruta atraparia un codigo que el parser, con sus
      //    `params`, no puede emitir.
      const draft = await buildDraftWithBranches({ [PARSER_NODE_ID]: SELECTIVE_ALERT_ROUTE });

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('F');

      // 3. Assert 🎯
      expect(useParserEmailStore(PARSER_NODE_ID).config.failOnUnextractableMedia).toBe(true);
      expect(schema.nodes[PARSER_NODE_ID]?.params.failOnUnextractableMedia).toBe(true);
    });

    it('17.4 deberia dejarlo apagado cuando la plantilla no declara la ruta', async () => {
      // 1. Arrange 📐: encenderlo sin ruta convertiria en PAUSADO un flujo que
      //    hoy atraviesa tranquilamente un correo de solo imagen.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('F');

      // 3. Assert 🎯
      expect(useParserEmailStore(PARSER_NODE_ID).config.failOnUnextractableMedia).toBe(false);
      expect(schema.nodes[PARSER_NODE_ID]?.onErrorStep).toBeNull();
    });

    it('17.5 deberia reunir DOS ramas en un solo nodo de alerta', async () => {
      // 1. Arrange 📐: la regla 5 del validador prohibe que dos nodos escriban
      //    `smtp_result`, y la lista cerrada solo tiene uno. Un satelite por paso
      //    devolveria un 400 en cuanto hubiera dos ramas.
      const draft = await buildDraftWithBranches({
        [PARSER_NODE_ID]: SELECTIVE_ALERT_ROUTE,
        [MAPPER_NODE_ID]: ALERT_ROUTE,
      });
      configureAlertNode();

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      const smtpNodes = Object.values(schema.nodes).filter(
        (node) => node.outputNamespace === 'smtp_result',
      );

      expect(smtpNodes).toHaveLength(1);
      expect(smtpNodes[0]?.nodeId).toBe(SHARED_ALERT_NODE_ID);
    });

    it('17.6 deberia emitir el satelite como nodo terminal fuera del encadenado', async () => {
      // 1. Arrange 📐: colarlo en la secuencia lo pondria en el camino feliz,
      //    enviando un aviso en cada ejecucion correcta.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      configureAlertNode();

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      expect(schema.nodes[SHARED_ALERT_NODE_ID]?.nextStep).toBeNull();
      expect(schema.nodes[MAPPER_NODE_ID]?.nextStep).toBeNull();
      expect(schema.nodes[PARSER_NODE_ID]?.nextStep).toBe(MAPPER_NODE_ID);
    });

    it('17.7 deberia llevar al satelite los params de su propio store', async () => {
      // 1. Arrange 📐
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      configureAlertNode();

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      expect(schema.nodes[SHARED_ALERT_NODE_ID]?.params.to).toEqual([ALERT_RECIPIENT]);
    });

    it('17.8 deberia BLOQUEAR el guardado con el nodo de alerta a medias', async () => {
      // 1. Arrange 📐: `collectIncompleteParams` del backend recorre el mapa
      //    ENTERO al activar, satelites incluidos. Dejar guardar aqui produciria
      //    un flujo que despues no se puede encender, sin decir por que.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      verifyTriggerStore();
      useTemplateMapperStore(MAPPER_NODE_ID).setTemplateId(HTML_TEMPLATE_ID);

      // 2. Act ⚙️
      const blocked = draft.invalidSteps.find((item) => item.reason === 'ALERTA_INCOMPLETA');

      // 3. Assert 🎯: el bloqueo se senala en EL PASO DE CONTINGENCIAS, no en
      //    cada nodo que declara la rama: desde que el formulario vive en un
      //    solo sitio, repartirlo mandaria al operador a corregirlo donde ya no
      //    esta.
      expect(draft.canSave).toBe(false);
      expect(blocked?.index).toBe(draft.alertStepIndex);
      expect(blocked?.step.nodeId).toBe(SHARED_ALERT_NODE_ID);
    });

    it('17.8bis deberia anadir el paso de contingencias solo con rama SMTP', async () => {
      // 1. Arrange 📐
      const sinRama = await buildDraftWithBranches({});

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(sinRama.contingencySteps).toHaveLength(0);
      expect(sinRama.configurableStepCount).toBe(sinRama.pipelineTopology.length);

      setActivePinia(createPinia());

      const conRama = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });

      expect(conRama.contingencySteps).toHaveLength(1);
      expect(conRama.alertStepIndex).toBe(conRama.pipelineTopology.length);
      expect(conRama.configurableStepCount).toBe(conRama.pipelineTopology.length + 1);
    });

    it('17.8ter deberia mover el final del stepper al paso de contingencias', async () => {
      // 1. Arrange 📐: sin esto, el boton del ultimo nodo diria "Revisar y
      //    guardar" y saltaria por encima del formulario de destinatarios.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });

      // 2. Act ⚙️: cursor en el ultimo NODO.
      draft.activeStep = draft.pipelineTopology.length - 1;

      // 3. Assert 🎯
      expect(draft.isLastStep).toBe(false);

      draft.activeStep = draft.alertStepIndex;

      expect(draft.isLastStep).toBe(true);
      expect(draft.isContingencyStep).toBe(true);
    });

    it('17.8quater deberia validar el paso de contingencias con su nodo', async () => {
      // 1. Arrange 📐: ese paso no esta en la topologia, asi que su validez es
      //    la del nodo de alerta compartido.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      draft.activeStep = draft.alertStepIndex;

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.isActiveStepValid).toBe(false);

      configureAlertNode();

      expect(draft.isActiveStepValid).toBe(true);
    });

    it('17.9 deberia desbloquearlo al completar el nodo de alerta', async () => {
      // 1. Arrange 📐
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      verifyTriggerStore();
      useTemplateMapperStore(MAPPER_NODE_ID).setTemplateId(HTML_TEMPLATE_ID);

      // 2. Act ⚙️
      configureAlertNode();

      // 3. Assert 🎯
      expect(draft.incompleteContingencySteps).toHaveLength(0);
      expect(draft.canSave).toBe(true);
    });

    it('17.10 deberia resolver la vision al satelite de OCR', async () => {
      // 1. Arrange 📐: antes devolvia `null` sin un PROCESADOR_IA en el flujo,
      //    porque un segundo nodo de IA chocaria con el en `llm_response`. Con
      //    `ocr_result` propio se auto-aprovisiona como la alerta.
      const draft = await buildSelectedDraft();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.resolveBranchTarget('VISION_IA')).toBe(SHARED_OCR_NODE_ID);
      expect(draft.resolveBranchTarget('ALERTA_SMTP')).toBe(SHARED_ALERT_NODE_ID);
    });

    it('17.11 deberia reutilizar el DESTINO_SMTP que trae la plantilla', async () => {
      // 1. Arrange 📐: provisionar otro junto a el seria un 400 por la regla 5.
      const draft = await buildDraftWithBranches(
        { [TRIGGER_NODE_ID]: 'destino_correo' },
        buildTemplate({
          topology: [
            {
              nodeId: TRIGGER_NODE_ID,
              nodeType: NodeType.TRIGGER_IMAP,
              outputNamespace: 'raw_email',
            },
            {
              nodeId: 'destino_correo',
              nodeType: NodeType.DESTINO_SMTP,
              outputNamespace: 'smtp_result',
            },
          ],
        }),
      );

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert 🎯
      expect(draft.contingencySteps).toHaveLength(0);
      expect(schema.nodes[TRIGGER_NODE_ID]?.onErrorStep).toBe('destino_correo');
      expect(schema.nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
    });

    it('17.12 deberia limpiar las ramas al resetear el borrador', async () => {
      // 1. Arrange 📐: la instancia del satelite sobrevive a la topologia, asi
      //    que sin esto un flujo nuevo arrancaria con los destinatarios del
      //    anterior ya puestos.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });
      configureAlertNode();

      // 2. Act ⚙️
      draft.resetDraft();

      // 3. Assert 🎯
      expect(draft.errorBranches).toEqual({});
      expect(useSmtpAlertStore(SHARED_ALERT_NODE_ID).config.to).toEqual([]);
    });

    it('17.13 NO deberia exponer ninguna via para declarar una rama', async () => {
      // 1. Arrange 📐: `onErrorStep` es TOPOLOGIA, y su unica autoridad es la
      //    plantilla. Si el asistente recuperase un `setter`, una instancia
      //    podria inventarse un grafo que su plantilla no declara y dos flujos
      //    de la misma plantilla saldrian distintos sin que nada lo explicara.
      const draft = await buildSelectedDraft();

      // 2. Act ⚙️ + 3. Assert 🎯
      expect('setErrorBranch' in draft).toBe(false);
    });
  });

  describe('12. Procedencia del flujo creado', () => {
    it('12.1 deberia enviar el templateId de la plantilla elegida', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      createWorkflow.mockResolvedValue(buildWorkflow());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb v2');

      // 3. Assert: es la trazabilidad de la procedencia. El grafo viaja copiado
      //    en `pipelineSchema`, asi que el flujo no depende de la plantilla.
      expect(createWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: TEMPLATE_ID }),
      );
    });

    it('12.2 deberia usar la plantilla de origen como flowId del esquema', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Notiweb v2');

      // 3. Assert: el backend lo ignora y asigna el de la fila que crea, pero
      //    `PipelineSchemaDto` exige el campo y la plantilla es la referencia
      //    mas honesta hasta que la fila exista.
      expect(schema.flowId).toBe(TEMPLATE_ID);
    });
  });

  describe('21. Paso de contingencia del satelite OCR', () => {
    /** Topologia con el nodo de IA, para que el rescate tenga a donde volver. */
    const buildVisionTemplate = (): WorkflowTemplateSummary =>
      buildTemplate({
        topology: [
          {
            nodeId: TRIGGER_NODE_ID,
            nodeType: NodeType.TRIGGER_IMAP,
            outputNamespace: 'raw_email',
          },
          {
            nodeId: PARSER_NODE_ID,
            nodeType: NodeType.PARSER_PRE_IA,
            outputNamespace: 'parsed_email',
          },
          {
            nodeId: 'nodo_ia',
            nodeType: NodeType.PROCESADOR_IA,
            outputNamespace: 'llm_response',
          },
        ],
      });

    it('21.1 deberia instanciar un paso propio para ocr_ia', async () => {
      // 1. Arrange 📐: el satelite no esta en `pipelineTopology` —solo se llega
      //    a el por la ruta de error—, asi que sin un paso sintetico el operador
      //    no tendria donde configurarlo.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildVisionTemplate(),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.contingencySteps).toHaveLength(1);
      expect(draft.contingencySteps[0]?.nodeId).toBe(SHARED_OCR_NODE_ID);
      expect(draft.contingencySteps[0]?.nodeType).toBe(NodeType.PROCESADOR_OCR);
      expect(draft.contingencySteps[0]?.name).toBe(OCR_STEP_NAME);
    });

    it('21.2 deberia contarlo en los pasos configurables', async () => {
      // 1. Arrange 📐: de `configurableStepCount` salen el indice del paso de
      //    revision y los botones "Siguiente"/"Revisar" del stepper.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildVisionTemplate(),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.configurableStepCount).toBe(draft.pipelineTopology.length + 1);
      expect(draft.contingencyStepIndex(SHARED_OCR_NODE_ID)).toBe(draft.pipelineTopology.length);
    });

    it('21.3 deberia aislar sus params de los del nodo de IA', async () => {
      // 1. Arrange 📐: los dos hablan con un modelo, y compartir store haria que
      //    cambiar el de transcripcion moviera el de redaccion sin avisar.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildVisionTemplate(),
      );

      // 2. Act ⚙️
      useOcrProcessorStore(SHARED_OCR_NODE_ID).updateConfig({
        model: 'gemini-2.0-flash',
      });

      const schema = draft.assemblePipelineSchema('Flujo con rescate');

      // 3. Assert 🎯
      expect(schema.nodes[SHARED_OCR_NODE_ID]?.params.model).toBe('gemini-2.0-flash');
      expect(schema.nodes.nodo_ia?.params.model).not.toBe('gemini-2.0-flash');
    });

    it('21.4 deberia emitir el satelite REINCORPORANDO el flujo', async () => {
      // 1. Arrange 📐: es lo que lo separa del satelite de alerta. Emitirlo
      //    terminal dejaria el flujo muerto justo despues del rescate.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildVisionTemplate(),
      );

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo con rescate');

      // 3. Assert 🎯: el parser iba a `nodo_ia`, asi que ahi vuelve.
      expect(schema.nodes[SHARED_OCR_NODE_ID]?.nextStep).toBe('nodo_ia');
      expect(schema.nodes[SHARED_OCR_NODE_ID]?.outputNamespace).toBe('ocr_result');
    });

    it('21.5 deberia desviar el fallo del propio satelite hacia la alerta', async () => {
      // 1. Arrange 📐: el satelite tambien falla —sin adjuntos, 503 del
      //    proveedor, transcripcion vacia—. Con `onErrorStep: null` el motor no
      //    encontraba ruta y PAUSABA el flujo teniendo al lado una alerta cuyo
      //    unico cometido es que una persona se entere.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE, nodo_ia: ALERT_ROUTE },
        buildVisionTemplate(),
      );
      useSmtpAlertStore(SHARED_ALERT_NODE_ID).updateConfig({ to: ['guardia@unuware.com'] });

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo con rescate');

      // 3. Assert 🎯: forma de CADENA, la unica que atrapa cualquier codigo.
      expect(schema.nodes[SHARED_OCR_NODE_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
      // La alerta sigue siendo terminal: apuntarse a si misma seria un bucle.
      expect(schema.nodes[SHARED_ALERT_NODE_ID]?.onErrorStep).toBeNull();
    });

    it('21.6 deberia dejar el satelite sin ruta si el flujo no tiene alerta', async () => {
      // 1. Arrange 📐: inventar el destino romperia la regla 3 del validador
      //    —todo `onErrorStep` no nulo resuelve a un nodo existente— y
      //    convertiria un guardado correcto en un 400.
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildVisionTemplate(),
      );

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Flujo con rescate');

      // 3. Assert 🎯
      expect(schema.nodes[SHARED_ALERT_NODE_ID]).toBeUndefined();
      expect(schema.nodes[SHARED_OCR_NODE_ID]?.onErrorStep).toBeNull();
    });
  });

  describe('20. Parametros base que impone la plantilla', () => {
    it('20.1 deberia repartir a cada nodo los params de su plantilla', async () => {
      // 1. Arrange 📐: `template.topology` es una proyeccion PARCIAL sin
      //    `params`, asi que el asistente los ignoraba por completo: una
      //    plantilla podia fijar la ingesta de adjuntos y el flujo instanciado
      //    nacia sin ella, dejando muda la ruta de contingencia de vision.
      const template = buildTemplate();
      const detail = buildTemplateDetail({}, template);
      const nodes = detail.pipelineSchema.nodes as Record<
        string,
        { params: Record<string, unknown> }
      >;

      nodes[TRIGGER_NODE_ID] = {
        ...nodes[TRIGGER_NODE_ID],
        params: { includeAttachments: true },
      };

      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([template]);
      fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);
      fetchWorkflowTemplate.mockResolvedValue(detail);

      await draft.loadAvailableTemplates();

      // 2. Act ⚙️
      await draft.selectTemplate(template.id);

      // 3. Assert 🎯
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);

      expect(trigger.config.includeAttachments).toBe(true);
      expect(trigger.isFieldLockedByTemplate('includeAttachments')).toBe(true);
    });
  });

  describe('19. Lectura de las ramas desde la vista', () => {
    it('19.1 deberia devolver la rama declarada por la plantilla', async () => {
      // 1. Arrange 📐
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.getNodeErrorBranch(MAPPER_NODE_ID)).toEqual({
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });
      expect(draft.getNodeErrorBranch(PARSER_NODE_ID)).toBeNull();
    });

    it('19.2 NO deberia contar la alerta como recuperacion contextual', async () => {
      // 1. Arrange 📐: una alerta es TERMINAL —avisa a una persona— y se
      //    configura en el paso de contingencias, no junto al nodo que la
      //    declara. Solo la recuperacion funcional se dibuja ahi.
      const draft = await buildDraftWithBranches({ [MAPPER_NODE_ID]: ALERT_ROUTE });

      // 2. Act ⚙️ + 3. Assert 🎯
      expect(draft.hasContextualRecoveryBranch(MAPPER_NODE_ID)).toBe(false);
    });

    it('19.3 SI deberia contar la ruta de vision', async () => {
      // 1. Arrange 📐
      const draft = await buildDraftWithBranches(
        { [PARSER_NODE_ID]: VISION_ROUTE },
        buildTemplate({
          topology: [
            {
              nodeId: TRIGGER_NODE_ID,
              nodeType: NodeType.TRIGGER_IMAP,
              outputNamespace: 'raw_email',
            },
            {
              nodeId: PARSER_NODE_ID,
              nodeType: NodeType.PARSER_PRE_IA,
              outputNamespace: 'parsed_email',
            },
            {
              nodeId: 'nodo_ia',
              nodeType: NodeType.PROCESADOR_IA,
              outputNamespace: 'llm_response',
            },
          ],
        }),
      );

      // 2. Act ⚙️ + 3. Assert 🎯
      // El destino es el SATELITE y ya no el nodo de IA del flujo: transcribir
      // y redactar son trabajos distintos y cada uno tiene el suyo.
      expect(draft.hasContextualRecoveryBranch(PARSER_NODE_ID)).toBe(true);
      expect(draft.resolveBranchTarget('VISION_IA')).toBe(SHARED_OCR_NODE_ID);
    });

    it('19.4 deberia llevar el cursor al paso de un nodo concreto', async () => {
      // 1. Arrange 📐
      const draft = await buildSelectedDraft();

      // 2. Act ⚙️
      draft.goToNodeStep(MAPPER_NODE_ID);

      // 3. Assert 🎯
      expect(draft.activeStepDefinition?.nodeId).toBe(MAPPER_NODE_ID);
    });

    it('19.5 no deberia mover el cursor hacia un nodo que no existe', async () => {
      // 1. Arrange 📐
      const draft = await buildSelectedDraft();

      // 2. Act ⚙️
      draft.goToNodeStep('nodo_inventado');

      // 3. Assert 🎯
      expect(draft.activeStep).toBe(0);
    });
  });
});

describe('useFlujoDraftStore · modo edicion', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    // Por defecto, una plantilla SIN rutas de contingencia: `selectTemplate`
    // pide el detalle para hidratarlas, y sin este doble toda seleccion fallaria.
    fetchWorkflowTemplate.mockResolvedValue(buildTemplateDetail());
  });

  /** Flujo guardado, con los `params` que el asistente debe repoblar. */
  const buildWorkflowDetail = (): WorkflowDetail => ({
    id: WORKFLOW_ID,
    name: 'Notiweb - publicacion automatica',
    description: 'Publica noticias entrantes en el CMS',
    active: true,
    templateId: TEMPLATE_ID,
    // Solo los dos tipos con configurador registrado. Un tipo sin store en
    // `nodeStoreRegistry` no puede declararse valido, asi que un flujo que lo
    // contenga no se puede guardar desde el asistente: es la misma barrera
    // Poka-Yoke que ya rige en el alta, no algo propio de la edicion.
    topology: [
      {
        nodeId: TRIGGER_NODE_ID,
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
      },
      {
        nodeId: MAPPER_NODE_ID,
        nodeType: NodeType.MAPEADOR_PLANTILLA,
        outputNamespace: 'rendered_html',
      },
    ],
    pipelineSchema: {
      flowId: TEMPLATE_ID,
      name: 'Notiweb - publicacion automatica',
      version: '1.0.0',
      entrypoint: TRIGGER_NODE_ID,
      nodes: {
        [TRIGGER_NODE_ID]: {
          nodeId: TRIGGER_NODE_ID,
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: MAPPER_NODE_ID,
          onErrorStep: null,
          params: {
            host: 'imap.unuware.com',
            port: 993,
            secure: true,
            user: 'notiweb@unuware.com',
            passwordEnvKey: 'IMAP_PASSWORD',
            mailbox: 'INBOX',
            pollIntervalMs: 60_000,
            unreadOnly: true,
            subjectFilter: 'Notiweb',
          },
        },
        [MAPPER_NODE_ID]: {
          nodeId: MAPPER_NODE_ID,
          nodeType: NodeType.MAPEADOR_PLANTILLA,
          outputNamespace: 'rendered_html',
          nextStep: null,
          onErrorStep: null,
          params: { templateId: HTML_TEMPLATE_ID },
        },
      },
    },
  });

  describe('13. Hidratacion de un flujo existente', () => {
    it('13.1 deberia reconstruir la topologia en orden', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();

      // 2. Act
      draft.hydrateForEdit(buildWorkflowDetail());

      // 3. Assert
      expect(draft.pipelineTopology.map((step) => step.nodeId)).toEqual([
        TRIGGER_NODE_ID,
        MAPPER_NODE_ID,
      ]);
      expect(draft.activeStep).toBe(0);
      expect(draft.editingWorkflowId).toBe(WORKFLOW_ID);
    });

    it('13.2 deberia repoblar los params de cada store de nodo', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();

      // 2. Act
      draft.hydrateForEdit(buildWorkflowDetail());

      // 3. Assert: sin esto el asistente abriria el formulario en blanco y
      // guardar borraria la configuracion que se venia a retocar.
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);
      const mapper = useTemplateMapperStore(MAPPER_NODE_ID);

      expect(trigger.config.host).toBe('imap.unuware.com');
      expect(trigger.config.subjectFilter).toBe('Notiweb');
      expect(mapper.config.templateId).toBe(HTML_TEMPLATE_ID);
      expect(mapper.config.outputNamespace).toBe('rendered_html');
    });

    it('13.3 deberia dar por valido un nodo IMAP ya guardado sin reprobar conexion', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();

      // 2. Act
      draft.hydrateForEdit(buildWorkflowDetail());

      // 3. Assert: esa configuracion ya supero la prueba cuando se creo el
      // flujo; exigirla de nuevo obligaria a reprobar el buzon para cambiar una
      // palabra de un filtro.
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);

      expect(trigger.connectionVerified).toBe(true);
      expect(trigger.isConfigValid).toBe(true);
    });

    it('13.4 deberia volver a avisar al tocar un campo de conexion', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);

      // 2. Act
      trigger.patchConfig({ host: 'otro.servidor.com' });

      // 3. Assert: la garantia sigue viva tras hidratar, pero ya no como
      //    bloqueo sino como aviso que el operador confirma al guardar.
      expect(trigger.connectionVerified).toBe(false);
      expect(draft.stepWarnings).toHaveLength(1);
    });

    it('13.5 NO deberia invalidarla al tocar solo un filtro', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());
      const trigger = useTriggerImapStore(TRIGGER_NODE_ID);

      // 2. Act
      trigger.patchFilters({ subjectFilter: 'Otro asunto' });

      // 3. Assert: un filtro no interviene en las credenciales.
      expect(trigger.connectionVerified).toBe(true);
    });

    it('13.6 deberia tolerar un flujo sin pipelineSchema', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();

      // 2. Act
      draft.hydrateForEdit({
        ...buildWorkflowDetail(),
        topology: [],
        pipelineSchema: null,
      });

      // 3. Assert: un borrador a medio crear es un estado legitimo.
      expect(draft.pipelineTopology).toEqual([]);
      expect(draft.editingWorkflowId).toBe(WORKFLOW_ID);
    });

    it('13.7 no deberia arrastrar la config de un flujo editado antes', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());

      // 2. Act: se abre otro flujo cuyo nodo IMAP no declara filtro.
      const other = buildWorkflowDetail();
      const otherNodes = { ...other.pipelineSchema?.nodes };
      const triggerNode = otherNodes[TRIGGER_NODE_ID];
      if (triggerNode !== undefined) {
        otherNodes[TRIGGER_NODE_ID] = {
          ...triggerNode,
          params: { ...triggerNode.params, subjectFilter: undefined },
        };
      }
      draft.hydrateForEdit({
        ...other,
        pipelineSchema: { ...other.pipelineSchema!, nodes: otherNodes },
      });

      // 3. Assert: `toNodeParams()` OMITE los filtros vacios, asi que sin
      // reponer `''` el valor anterior sobreviviria al cambio de flujo.
      expect(useTriggerImapStore(TRIGGER_NODE_ID).config.subjectFilter).toBe('');
    });
  });

  describe('14. Guardado en modo edicion', () => {
    it('14.1 deberia actualizar el flujo y NO crear uno nuevo', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());
      updateWorkflow.mockResolvedValue(buildWorkflow());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb revisado', 'Nueva descripcion');

      // 3. Assert
      expect(createWorkflow).not.toHaveBeenCalled();
      expect(updateWorkflow).toHaveBeenCalledWith(
        WORKFLOW_ID,
        expect.objectContaining({ name: 'Notiweb revisado' }),
      );
    });

    it('14.2 deberia enviar el pipelineSchema con los cambios del formulario', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());
      useTriggerImapStore(TRIGGER_NODE_ID).patchFilters({ subjectFilter: 'Otro asunto' });
      updateWorkflow.mockResolvedValue(buildWorkflow());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb', '');

      // 3. Assert
      const [, payload] = updateWorkflow.mock.calls[0] ?? [];
      const params = payload?.pipelineSchema?.nodes[TRIGGER_NODE_ID]?.params;

      expect(params?.subjectFilter).toBe('Otro asunto');
      expect(params?.host).toBe('imap.unuware.com');
    });

    it('14.3 NO deberia enviar active ni templateId al editar', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());
      updateWorkflow.mockResolvedValue(buildWorkflow());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb', '');

      // 3. Assert: habilitar es competencia del interruptor del catalogo, y la
      // procedencia es un hecho historico que `UpdateWorkflowDto` no admite.
      const [, payload] = updateWorkflow.mock.calls[0] ?? [];

      expect(payload).not.toHaveProperty('active');
      expect(payload).not.toHaveProperty('templateId');
    });

    it('14.4 deberia volver a crear tras resetDraft', () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      draft.hydrateForEdit(buildWorkflowDetail());

      // 2. Act
      draft.resetDraft();

      // 3. Assert: sin limpiar `editingWorkflowId`, el alta siguiente guardaria
      // ENCIMA del flujo que se estaba editando.
      expect(draft.editingWorkflowId).toBeNull();
    });
  });

  describe('15. Carga desde el backend', () => {
    it('15.1 deberia pedir el detalle e hidratar con el resultado', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflow.mockResolvedValue(buildWorkflowDetail());

      // 2. Act
      await draft.loadWorkflowForEdit(WORKFLOW_ID);

      // 3. Assert
      expect(fetchWorkflow).toHaveBeenCalledWith(WORKFLOW_ID);
      expect(draft.editingWorkflowId).toBe(WORKFLOW_ID);
      expect(useTriggerImapStore(TRIGGER_NODE_ID).config.host).toBe('imap.unuware.com');
    });

    it('15.2 deberia propagar el error dejando isLoading apagado', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchWorkflow.mockRejectedValue(new Error('404'));

      // 2. Act & 3. Assert: el mensaje al usuario lo decide el componente.
      await expect(draft.loadWorkflowForEdit(WORKFLOW_ID)).rejects.toThrow('404');
      expect(draft.isLoading).toBe(false);
    });
  });

  describe('16. Motivo por el que un paso bloquea el guardado', () => {
    it('16.1 deberia distinguir el nodo sin configurador del que solo esta incompleto', async () => {
      // 1. Arrange: TRIGGER_IMAP (con configurador, sin probar) y ESCUDO_POST_IA
      //    (sin configurador). Se usa la topologia alternativa porque
      //    PARSER_PRE_IA y PROCESADOR_IA fueron dejando de ser tipos sin
      //    configurador al recibir su triada.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate({ topology: UNSUPPORTED_TOPOLOGY })]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 2. Act
      const byType = new Map(draft.invalidSteps.map((item) => [item.step.nodeType, item.reason]));

      // 3. Assert: presentarlos igual dejaba al operador reintentando algo que
      //    no tiene arreglo desde el asistente.
      expect(byType.get(NodeType.ESCUDO_POST_IA)).toBe('SIN_CONFIGURADOR');
      expect(byType.get(NodeType.TRIGGER_IMAP)).toBe('CONFIGURACION_INCOMPLETA');
    });

    it('16.2 deberia incluir el indice para poder saltar al paso culpable', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const [first] = draft.invalidSteps;

      // 3. Assert
      expect(first?.index).toBe(0);
      expect(draft.pipelineTopology[first?.index ?? -1]?.nodeId).toBe(first?.step.nodeId);
    });

    it('16.3 deberia acompanar cada motivo de un mensaje no vacio', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act & 3. Assert: es el texto que la vista muestra; vacio devolveria
      //    el asistente al estado mudo que este bloque existe para evitar.
      expect(draft.invalidSteps.length).toBeGreaterThan(0);
      draft.invalidSteps.forEach((item) => {
        expect(item.message.trim()).not.toBe('');
      });
    });

    it('16.4 deberia marcar hasUnsupportedNodes con un tipo sin configurador', async () => {
      // 1. Arrange: topologia con PROCESADOR_IA, que sigue sin triada.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([buildTemplate({ topology: UNSUPPORTED_TOPOLOGY })]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 2. Act & 3. Assert
      expect(draft.hasUnsupportedNodes).toBe(true);
      expect(draft.canSave).toBe(false);
    });

    it('16.4.1 NO deberia marcar hasUnsupportedNodes con el parser ya implementado', async () => {
      // 1. Arrange: el reverso de la prueba anterior, y el desbloqueo funcional
      //    de esta rama. La topologia por defecto incluye PARSER_PRE_IA: antes
      //    de tener triada hacia `canSave` imposible para siempre.
      const draft = await buildSelectedDraft();

      // 2. Act & 3. Assert: sigue habiendo pasos incompletos —el trigger no se
      //    ha configurado— pero ninguno es ya INEJECUTABLE.
      expect(draft.hasUnsupportedNodes).toBe(false);
      expect(draft.invalidSteps.map((item) => item.reason)).not.toContain('SIN_CONFIGURADOR');
    });

    it('16.6 no deberia contar un aviso como motivo de bloqueo', async () => {
      // 1. Arrange: el contrato clave de la separacion. Un trigger cuya conexion
      //    sigue sin verificar, pero cuyo operador ya declaro que configura sin
      //    comprobarla, avisa y NO bloquea. Sin el reconocimiento si bloquearia,
      //    y entonces lo que se estaria probando es el bloqueo, no la separacion.
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      const triggerStore = useTriggerImapStore(TRIGGER_NODE_ID);
      triggerStore.connectionVerified = false;
      triggerStore.skipCheckAcknowledged = true;

      // 2. Act
      const reasons = draft.invalidSteps.map((item) => item.step.nodeType);

      // 3. Assert
      expect(draft.stepWarnings.length).toBeGreaterThan(0);
      expect(reasons).not.toContain(NodeType.TRIGGER_IMAP);
    });

    it('16.6.1 SI deberia bloquear una conexion sin probar ni reconocer', async () => {
      // 1. Arrange: la contrapartida de 16.6, para que la separacion entre aviso
      //    y bloqueo no se lea como "el nodo IMAP nunca bloquea".
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      useTriggerImapStore(TRIGGER_NODE_ID).connectionVerified = false;

      // 2. Act
      const reasons = draft.invalidSteps.map((item) => item.step.nodeType);

      // 3. Assert
      expect(reasons).toContain(NodeType.TRIGGER_IMAP);
      expect(draft.canSave).toBe(false);
    });

    it('16.7 deberia situar el aviso en el paso que lo emite', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();
      useTriggerImapStore(TRIGGER_NODE_ID).connectionVerified = false;

      // 2. Act
      const [warning] = draft.stepWarnings;

      // 3. Assert: es lo que permite a la vista saltar al paso culpable.
      expect(warning?.step.nodeId).toBe(TRIGGER_NODE_ID);
      expect(draft.pipelineTopology[warning?.index ?? -1]?.nodeId).toBe(TRIGGER_NODE_ID);
    });

    it('16.8 no deberia aportar avisos un nodo que no los declara', async () => {
      // 1. Arrange: `configWarnings` es opcional en el contrato; el mapeador no
      //    lo implementa y eso no puede romper la agregacion.
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act & 3. Assert
      expect(draft.stepWarnings).toEqual([]);
    });

    it('16.5 no deberia marcar hasUnsupportedNodes si solo falta completar campos', async () => {
      // 1. Arrange: topologia con un unico nodo que SI tiene configurador.
      const draft = useFlujoDraftStore();
      fetchWorkflowTemplates.mockResolvedValue([
        buildTemplate({
          topology: [
            {
              nodeId: TRIGGER_NODE_ID,
              nodeType: NodeType.TRIGGER_IMAP,
              outputNamespace: 'raw_email',
            },
          ],
        }),
      ]);
      await draft.loadAvailableTemplates();
      await draft.selectTemplate(TEMPLATE_ID);

      // 2. Act & 3. Assert: bloquea, pero es corregible sin salir del asistente.
      expect(draft.canSave).toBe(false);
      expect(draft.hasUnsupportedNodes).toBe(false);
      expect(draft.invalidSteps[0]?.reason).toBe('CONFIGURACION_INCOMPLETA');
    });
  });

  describe('18. Ida y vuelta de las rutas de contingencia', () => {
    /** Flujo guardado CON una rama y su nodo de alerta satelite. */
    const buildBranchedDetail = (): WorkflowDetail => {
      const base = buildWorkflowDetail();
      const nodes = base.pipelineSchema?.nodes ?? {};

      return {
        ...base,
        pipelineSchema: {
          ...(base.pipelineSchema as NonNullable<WorkflowDetail['pipelineSchema']>),
          nodes: {
            ...nodes,
            [TRIGGER_NODE_ID]: {
              ...(nodes[TRIGGER_NODE_ID] as NonNullable<(typeof nodes)[string]>),
              onErrorStep: SHARED_ALERT_NODE_ID,
            },
            [SHARED_ALERT_NODE_ID]: {
              nodeId: SHARED_ALERT_NODE_ID,
              nodeType: NodeType.DESTINO_SMTP,
              outputNamespace: 'smtp_result',
              nextStep: null,
              onErrorStep: null,
              params: { to: ['guardia@unuware.com'], subject: 'Incidencia' },
            },
          },
        },
      };
    };

    it('18.1 deberia recuperar la rama al abrir el flujo', () => {
      // 1. Arrange 📐: `topology` solo trae el camino activo, asi que sin
      //    reconstruirlas el asistente abriria sin ramas.
      const draft = useFlujoDraftStore();
      fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);

      // 2. Act ⚙️
      draft.hydrateForEdit(buildBranchedDetail());

      // 3. Assert 🎯
      expect(draft.errorBranches[TRIGGER_NODE_ID]).toEqual({
        trigger: 'CUALQUIER_FALLO',
        action: 'ALERTA_SMTP',
      });
    });

    it('18.2 deberia repoblar el nodo de alerta satelite', () => {
      // 1. Arrange 📐: no esta en `topology` —solo se llega a el por la ruta—,
      //    asi que su configuracion hay que buscarla en el mapa de nodos.
      const draft = useFlujoDraftStore();
      fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);

      // 2. Act ⚙️
      draft.hydrateForEdit(buildBranchedDetail());

      // 3. Assert 🎯
      expect(useSmtpAlertStore(SHARED_ALERT_NODE_ID).config.to).toEqual(['guardia@unuware.com']);
    });

    it('18.3 NO deberia perder la rama al reensamblar', () => {
      // 1. Arrange 📐: REGRESION del caso que motiva esta entrega. Sin la ida y
      //    vuelta, abrir un flujo con contingencia y volver a guardarlo borraria
      //    la ruta y su nodo de alerta, y el operador perderia la configuracion
      //    con solo mirar el flujo.
      const draft = useFlujoDraftStore();
      fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);
      draft.hydrateForEdit(buildBranchedDetail());

      // 2. Act ⚙️
      const schema = draft.assemblePipelineSchema('Notiweb');

      // 3. Assert 🎯
      expect(schema.nodes[TRIGGER_NODE_ID]?.onErrorStep).toBe(SHARED_ALERT_NODE_ID);
      expect(schema.nodes[SHARED_ALERT_NODE_ID]?.params.to).toEqual(['guardia@unuware.com']);
      expect(schema.nodes[SHARED_ALERT_NODE_ID]?.nextStep).toBeNull();
    });

    it('18.4 deberia ignorar una ruta que no encaja en el catalogo', () => {
      // 1. Arrange 📐: el panel JSON del editor de plantillas permite escribir
      //    rutas a mano. Adivinar una intencion equivocada la reescribiria en el
      //    esquema con otro significado, que es peor que no mostrarla.
      const draft = useFlujoDraftStore();
      fetchNodeCatalog.mockResolvedValue(CATALOG_ENTRIES);
      const detail = buildBranchedDetail();
      const nodes = detail.pipelineSchema?.nodes ?? {};

      // 2. Act ⚙️
      draft.hydrateForEdit({
        ...detail,
        pipelineSchema: {
          ...(detail.pipelineSchema as NonNullable<WorkflowDetail['pipelineSchema']>),
          nodes: {
            ...nodes,
            [TRIGGER_NODE_ID]: {
              ...(nodes[TRIGGER_NODE_ID] as NonNullable<(typeof nodes)[string]>),
              onErrorStep: {
                targetNode: SHARED_ALERT_NODE_ID,
                catchErrors: ['ERR_ESCRITO_A_MANO'],
              },
            },
          },
        },
      });

      // 3. Assert 🎯
      expect(draft.errorBranches[TRIGGER_NODE_ID]).toBeUndefined();
    });
  });
});
