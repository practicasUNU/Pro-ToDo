import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

import { useFlujoDraftStore } from './flujo-draft.store';

import { NodeType } from '@/types/pipeline';

import type { PipelineSummary, WorkflowTemplateSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/workflow-templates.service', () => ({
  fetchWorkflowTemplates: vi.fn(),
}));
vi.mock('@services/workflows.service', () => ({
  createWorkflow: vi.fn(),
}));
vi.mock('@services/nodes/trigger-imap.service', () => ({
  checkImapConnection: vi.fn(),
}));
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
}));

const workflowTemplatesService = await import('@services/workflow-templates.service');
const fetchWorkflowTemplates = vi.mocked(workflowTemplatesService.fetchWorkflowTemplates);

const workflowsService = await import('@services/workflows.service');
const createWorkflow = vi.mocked(workflowsService.createWorkflow);

const TEMPLATE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_TEMPLATE_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';

// `nodeId` de la topologia de prueba. Los stores de nodo se instancian POR
// `nodeId`, asi que una prueba que resuelva el store con otro identificador
// mirara una instancia vacia distinta de la que el borrador esta usando.
const TRIGGER_NODE_ID = 'trigger_imap';
const PARSER_NODE_ID = 'nodo_parser';
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
const buildSelectedDraft = async (): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();
  fetchWorkflowTemplates.mockResolvedValue([buildTemplate()]);
  await draft.loadAvailableTemplates();
  draft.selectTemplate(TEMPLATE_ID);

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
      draft.selectTemplate(TEMPLATE_ID);
      verifyTriggerStore();
      draft.goToNextStep();
      expect(draft.activeStep).toBe(1);

      // 2. Act
      draft.selectTemplate(OTHER_TEMPLATE_ID);

      // 3. Assert: arrastrar el cursor mostraria el paso 2 de un flujo distinto.
      expect(draft.activeStep).toBe(0);
      expect(draft.selectedTemplateId).toBe(OTHER_TEMPLATE_ID);
    });

    it('2.5 deberia ignorar un pipelineId que no esta en el catalogo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.selectTemplate('id-inexistente');

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
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act: avanzar al PARSER_PRE_IA, que aun no tiene configurador.
      draft.goToNextStep();

      // 3. Assert: sin configurador no hay forma de declararlo valido, y dejar
      //    avanzar seria ensamblar un pipeline con un nodo sin configurar.
      expect(draft.activeStepDefinition?.nodeType).toBe(NodeType.PARSER_PRE_IA);
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
      const mapper = useTemplateMapperStore(MAPPER_NODE_ID);
      expect(mapper.availableUpstreamNamespaces).toEqual(['raw_email', 'parsed_email']);
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
      draft.selectTemplate(TEMPLATE_ID);

      // 2. Act
      draft.selectTemplate(OTHER_TEMPLATE_ID);

      // 3. Assert: en el pipeline corto el mapeador es el primero, asi que no
      //    tiene nada aguas arriba. Arrastrar la lista anterior le haria creer
      //    que `raw_email` existe en un flujo donde nadie lo produce.
      const mapper = useTemplateMapperStore(MAPPER_NODE_ID);
      expect(mapper.availableUpstreamNamespaces).toEqual([]);
    });
  });

  describe('8. Ensamblado del pipeline_schema', () => {
    it('8.1 deberia recolectar los params de cada store de nodo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      verifyTriggerStore();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: los siete campos de conexion salen del store del trigger, no
      //    de una copia que mantuviera el agregador.
      expect(schema.nodes.trigger_imap?.params).toEqual({
        host: 'imap.unuware.com',
        port: 993,
        secure: true,
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
        mailbox: 'INBOX',
        pollIntervalMs: 60_000,
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

    it('8.4 deberia dejar onErrorStep en null en todos los nodos', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      const schema = draft.assemblePipelineSchema('Flujo de prueba');

      // 3. Assert: el asistente aun no ofrece caminos de recuperacion, y un
      //    puntero inventado seria peor que su ausencia.
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
  });

  describe('9. Guardado del flujo', () => {
    it('9.1 deberia rechazar el guardado con pasos sin configurar', async () => {
      // 1. Arrange: el trigger arranca sin probar la conexion.
      const draft = await buildSelectedDraft();

      // 2. Act & 3. Assert: la guarda vive en el store y no solo en el
      //    `:disable` del boton; guardar un flujo a medias dejaria en la BD un
      //    esquema que revienta en su primera ejecucion.
      await expect(draft.assembleAndSaveWorkflow('Flujo incompleto')).rejects.toThrow(
        /sin configurar/,
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
      draft.selectTemplate(OTHER_TEMPLATE_ID);
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
      draft.selectTemplate(TEMPLATE_ID);

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
      draft.selectTemplate(TEMPLATE_ID);
      verifyTriggerStore();

      // 2. Act
      draft.selectTemplate(OTHER_TEMPLATE_ID);

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
      draft.selectTemplate(TEMPLATE_ID);

      // 3. Assert: arranca de la plantilla intacta, no del recorte anterior.
      expect(draft.pipelineTopology).toHaveLength(3);
      expect(draft.pipelineTopology.map((step) => step.nodeId)).toEqual([
        TRIGGER_NODE_ID,
        PARSER_NODE_ID,
        MAPPER_NODE_ID,
      ]);
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
});
