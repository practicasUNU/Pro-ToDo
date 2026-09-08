import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTriggerImapStore } from '@stores/nodes/trigger-imap.store';

import { useFlujoDraftStore } from './flujo-draft.store';

import { NodeType } from '@/types/pipeline';

import type { PipelineSummary } from '@/types/pipeline';

// Sin esto se cargaria `@boot/axios`, que necesita entorno de navegador.
vi.mock('@services/pipelines.service', () => ({
  fetchSelectablePipelines: vi.fn(),
}));
vi.mock('@services/nodes/trigger-imap.service', () => ({
  checkImapConnection: vi.fn(),
}));
vi.mock('@services/nodes/template-mapper.service', () => ({
  fetchSelectableTemplates: vi.fn(),
  compilePreview: vi.fn(),
}));

const pipelinesService = await import('@services/pipelines.service');
const fetchSelectablePipelines = vi.mocked(
  pipelinesService.fetchSelectablePipelines,
);

const PIPELINE_ID = 'b3f1c2d4-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER_PIPELINE_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';

/** Pipeline de tres pasos: trigger -> parser -> mapeador. */
const buildPipeline = (
  overrides: Partial<PipelineSummary> = {},
): PipelineSummary => ({
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
const buildSelectedDraft = async (): Promise<
  ReturnType<typeof useFlujoDraftStore>
> => {
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
});
