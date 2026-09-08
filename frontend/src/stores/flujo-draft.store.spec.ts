import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTemplateMapperStore } from '@stores/nodes/template-mapper.store';
import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

import { useFlujoDraftStore } from './flujo-draft.store';

import { NodeType } from '@/types/pipeline';

import type { PipelineSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/pipelines.service', () => ({
  fetchSelectablePipelines: vi.fn(),
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

const pipelinesService = await import('@services/pipelines.service');
const fetchSelectablePipelines = vi.mocked(pipelinesService.fetchSelectablePipelines);

const workflowsService = await import('@services/workflows.service');
const createWorkflow = vi.mocked(workflowsService.createWorkflow);

const PIPELINE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_PIPELINE_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';

/** Pipeline de tres pasos: trigger -> parser -> mapeador. */
const buildPipeline = (overrides: Partial<PipelineSummary> = {}): PipelineSummary => ({
  id: PIPELINE_ID,
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  active: true,
  topology: [
    {
      nodeId: 'trigger_imap',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
    },
    {
      nodeId: 'nodo_parser',
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
    },
    {
      nodeId: 'nodo_mapeador',
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
    },
  ],
  ...overrides,
});

/** Borrador con el catalogo cargado y un pipeline ya elegido. */
const buildSelectedDraft = async (): Promise<ReturnType<typeof useFlujoDraftStore>> => {
  const draft = useFlujoDraftStore();
  fetchSelectablePipelines.mockResolvedValue([buildPipeline()]);
  await draft.loadAvailablePipelines();
  draft.selectPipeline(PIPELINE_ID);

  return draft;
};

/** Deja el store del trigger en estado valido y con la conexion probada. */
const verifyTriggerStore = (): void => {
  const trigger = useTriggerImapStore();
  trigger.patchConfig({
    host: 'imap.unuware.com',
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
      fetchSelectablePipelines.mockResolvedValue([buildPipeline()]);

      // 2. Act
      await draft.loadAvailablePipelines();

      // 3. Assert
      expect(draft.availablePipelines).toHaveLength(1);
      expect(draft.isLoading).toBe(false);
    });

    it('1.2 deberia apagar isLoading aunque el servicio lance', async () => {
      // 1. Arrange
      const draft = useFlujoDraftStore();
      fetchSelectablePipelines.mockRejectedValue(new Error('500'));

      // 2. Act & 3. Assert: el error sube al componente, pero el `finally` deja
      //    el indicador apagado.
      await expect(draft.loadAvailablePipelines()).rejects.toThrow('500');
      expect(draft.isLoading).toBe(false);
    });
  });

  describe('2. Seleccion de pipeline', () => {
    it('2.1 deberia fijar la topologia y arrancar en el primer paso', async () => {
      // 1. Arrange & 2. Act
      const draft = await buildSelectedDraft();

      // 3. Assert
      expect(draft.selectedPipelineId).toBe(PIPELINE_ID);
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
      fetchSelectablePipelines.mockResolvedValue([
        buildPipeline(),
        buildPipeline({ id: OTHER_PIPELINE_ID, name: 'Otro flujo' }),
      ]);
      await draft.loadAvailablePipelines();
      draft.selectPipeline(PIPELINE_ID);
      verifyTriggerStore();
      draft.goToNextStep();
      expect(draft.activeStep).toBe(1);

      // 2. Act
      draft.selectPipeline(OTHER_PIPELINE_ID);

      // 3. Assert: arrastrar el cursor mostraria el paso 2 de un flujo distinto.
      expect(draft.activeStep).toBe(0);
      expect(draft.selectedPipelineId).toBe(OTHER_PIPELINE_ID);
    });

    it('2.5 deberia ignorar un pipelineId que no esta en el catalogo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.selectPipeline('id-inexistente');

      // 3. Assert
      expect(draft.selectedPipelineId).toBe(PIPELINE_ID);
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
      expect(draft.selectedPipelineId).toBeNull();
      expect(draft.pipelineTopology).toEqual([]);
      expect(draft.activeStep).toBe(0);
    });

    it('6.2 deberia conservar el catalogo cargado', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();

      // 2. Act
      draft.resetDraft();

      // 3. Assert: volver al selector no debe obligar a otra peticion HTTP.
      expect(draft.availablePipelines).toHaveLength(1);
    });
  });

  describe('7. Sincronizacion de namespaces aguas arriba', () => {
    it('7.1 deberia exponer raw_email al mapeador al elegir el pipeline', async () => {
      // 1. Arrange & 2. Act
      await buildSelectedDraft();

      // 3. Assert: el mapeador es el tercer paso, asi que recibe los namespaces
      //    de los dos anteriores. Antes de esta conexion usaba una lista fija
      //    marcada PROVISIONAL y validaba contra namespaces inventados.
      const mapper = useTemplateMapperStore();
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
      const shortPipeline = buildPipeline({
        id: OTHER_PIPELINE_ID,
        topology: [
          {
            nodeId: 'nodo_mapeador',
            nodeType: NodeType.MAPEADOR_PLANTILLA,
            outputNamespace: 'rendered_html',
          },
        ],
      });
      fetchSelectablePipelines.mockResolvedValue([buildPipeline(), shortPipeline]);
      await draft.loadAvailablePipelines();
      draft.selectPipeline(PIPELINE_ID);

      // 2. Act
      draft.selectPipeline(OTHER_PIPELINE_ID);

      // 3. Assert: en el pipeline corto el mapeador es el primero, asi que no
      //    tiene nada aguas arriba. Arrastrar la lista anterior le haria creer
      //    que `raw_email` existe en un flujo donde nadie lo produce.
      const mapper = useTemplateMapperStore();
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
      createWorkflow.mockResolvedValue(buildPipeline({ id: 'nuevo-id' }));

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
      createWorkflow.mockResolvedValue(buildPipeline());

      // 2. Act
      await draft.assembleAndSaveWorkflow('Notiweb v2', '   ');

      // 3. Assert: con `exactOptionalPropertyTypes` la clave se omite en vez de
      //    enviarse como `undefined`, que el DTO backend rechazaria.
      expect(createWorkflow.mock.calls[0]?.[0]).not.toHaveProperty('description');
    });

    it('9.5 deberia anadir el flujo creado al catalogo', async () => {
      // 1. Arrange
      const draft = await buildSelectedDraft();
      draft.pipelineTopology = [draft.pipelineTopology[0]!];
      verifyTriggerStore();
      const created = buildPipeline({ id: 'nuevo-id', name: 'Recien creado' });
      createWorkflow.mockResolvedValue(created);

      // 2. Act
      const result = await draft.assembleAndSaveWorkflow('Recien creado');

      // 3. Assert: sin esto, volver al selector mostraria una lista sin el flujo
      //    que se acaba de guardar.
      expect(result).toEqual(created);
      expect(draft.availablePipelines[0]).toEqual(created);
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
});
