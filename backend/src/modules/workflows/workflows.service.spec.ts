import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { WorkflowsService } from './workflows.service';

import type { CreateWorkflowDto } from './dto/create-workflow.dto';

import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import type { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import type { Workflow } from './entities/workflow.entity';
import type { Repository } from 'typeorm';

const WORKFLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';
const EXECUTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const AUTHOR_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';
const MAPPER_NODE_ID = 'nodo_mapeador';

/** Namespaces que el disparador manual siembra en el contexto. */
const INITIAL_PAYLOAD = {
  parsed_email: {
    clean_title: 'Avance en Computacion Cuantica',
    image_path: '/2026/09/laboratorio.jpg',
  },
};

/** Pipeline de un solo nodo, el mismo que siembra el fixture del Camino B. */
const buildSchema = (): PipelineSchemaDto => ({
  flowId: WORKFLOW_ID,
  name: 'Pipeline de verificacion del mapeador de plantillas',
  version: '1.0.0',
  entrypoint: MAPPER_NODE_ID,
  nodes: {
    [MAPPER_NODE_ID]: {
      nodeId: MAPPER_NODE_ID,
      nodeType: NodeType.MAPEADOR_PLANTILLA,
      outputNamespace: 'rendered_html',
      nextStep: null,
      onErrorStep: null,
      params: { templateId: TEMPLATE_ID },
    },
  },
});

const buildWorkflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: WORKFLOW_ID,
  name: '[E2E] Mapeador de plantilla',
  description: null,
  active: true,
  pipelineSchema: buildSchema(),
  // Un flujo que no nacio de ninguna plantilla, que es el caso de todos los
  // anteriores a la migracion 010 y el del asistente creando uno desde cero.
  templateId: null,
  template: null,
  createdById: AUTHOR_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** Checkpoint tal y como lo devuelve `executeWorkflow` al terminar. */
const buildExecution = (
  overrides: Partial<FsmExecution> = {},
): FsmExecution => ({
  executionId: EXECUTION_ID,
  flowId: WORKFLOW_ID,
  currentState: ExecutionState.EXITOSO,
  activeCursor: null,
  contextPayload: {
    ...INITIAL_PAYLOAD,
    rendered_html: {
      compiled_markup: '<h1>Avance en Computacion Cuantica</h1>',
    },
  },
  retryState: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

type WorkflowRepositoryMock = jest.Mocked<
  Pick<Repository<Workflow>, 'findOne' | 'find' | 'create' | 'save'>
>;
type ValidatorMock = jest.Mocked<
  Pick<PipelineValidatorService, 'validateSchema'>
>;
type EngineMock = jest.Mocked<
  Pick<FsmEngineService, 'createExecution' | 'executeWorkflow'>
>;

/** Dobles del caso feliz; cada prueba sobrescribe solo lo que le concierne. */
interface ServiceHarness {
  service: WorkflowsService;
  repository: WorkflowRepositoryMock;
  validator: ValidatorMock;
  engine: EngineMock;
}

/**
 * Monta el servicio con los tres colaboradores mockeados.
 *
 * El motor va SIEMPRE mockeado, a diferencia del renderer en las pruebas del
 * mapeador: `executeWorkflow` escribe checkpoints en PostgreSQL en cada
 * transicion, asi que usarlo de verdad convertiria esta suite unitaria en una
 * de integracion. Lo que aqui se comprueba es la orquestacion —que se valide
 * antes de crear, que se siembre el payload, que las excepciones suban tal
 * cual—, no el recorrido del grafo, que ya cubre `fsm-engine.service.spec.ts`.
 */
const buildHarness = (): ServiceHarness => {
  const repository: WorkflowRepositoryMock = {
    findOne: jest.fn().mockResolvedValue(buildWorkflow()),
    find: jest.fn().mockResolvedValue([buildWorkflow()]),
    // `create` devuelve la entidad sin persistir; `save` la que quedo en la BD.
    create: jest.fn((partial: Partial<Workflow>) => partial as Workflow),
    save: jest.fn((entity: Workflow) =>
      Promise.resolve({ ...buildWorkflow(), ...entity }),
    ),
  };
  const validator: ValidatorMock = {
    validateSchema: jest.fn().mockResolvedValue(buildSchema()),
  };
  const engine: EngineMock = {
    createExecution: jest.fn().mockResolvedValue(
      buildExecution({
        currentState: ExecutionState.INACTIVO,
        contextPayload: INITIAL_PAYLOAD,
      }),
    ),
    executeWorkflow: jest.fn().mockResolvedValue(buildExecution()),
  };

  const service = new WorkflowsService(
    repository as unknown as Repository<Workflow>,
    validator as unknown as PipelineValidatorService,
    engine as unknown as FsmEngineService,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

  return { service, repository, validator, engine };
};

describe('WorkflowsService (despacho manual, Camino B)', () => {
  describe('1. Caso feliz', () => {
    it('1.1 deberia sembrar los namespaces iniciales y devolver la ejecucion EXITOSO', async () => {
      // 1. Arrange
      const { service, engine } = buildHarness();

      // 2. Act
      const response = await service.runWorkflowTest(WORKFLOW_ID, {
        initialPayload: INITIAL_PAYLOAD,
      });

      // 3. Assert
      expect(engine.createExecution).toHaveBeenCalledWith(
        WORKFLOW_ID,
        INITIAL_PAYLOAD,
      );
      expect(response).toEqual({
        executionId: EXECUTION_ID,
        finalState: ExecutionState.EXITOSO,
        activeCursor: null,
        context: buildExecution().contextPayload,
      });
    });

    it('1.2 deberia despachar con contexto vacio si no llega initialPayload', async () => {
      // 1. Arrange
      const { service, engine } = buildHarness();

      // 2. Act
      await service.runWorkflowTest(WORKFLOW_ID, {});

      // 3. Assert
      expect(engine.createExecution).toHaveBeenCalledWith(WORKFLOW_ID, {});
    });

    it('1.3 NO deberia pasar el payload tambien como initialPayload del motor', async () => {
      // 1. Arrange: duplicarlo lo dejaria ademas bajo el namespace `trigger`
      const { service, engine } = buildHarness();

      // 2. Act
      await service.runWorkflowTest(WORKFLOW_ID, {
        initialPayload: INITIAL_PAYLOAD,
      });

      // 3. Assert
      expect(engine.executeWorkflow).toHaveBeenCalledWith(
        EXECUTION_ID,
        buildSchema(),
      );
    });

    it('1.4 deberia devolver el cursor culpable cuando el motor deja PAUSADO', async () => {
      // 1. Arrange
      const { service, engine } = buildHarness();
      engine.executeWorkflow.mockResolvedValue(
        buildExecution({
          currentState: ExecutionState.PAUSADO,
          activeCursor: MAPPER_NODE_ID,
        }),
      );

      // 2. Act
      const response = await service.runWorkflowTest(WORKFLOW_ID, {});

      // 3. Assert: un flujo detenido no es un error HTTP; es un 200 con estado
      expect(response.finalState).toBe(ExecutionState.PAUSADO);
      expect(response.activeCursor).toBe(MAPPER_NODE_ID);
    });
  });

  describe('2. Flujo inexistente o sin esquema', () => {
    it('2.1 deberia lanzar NotFoundException si el flujo no existe', async () => {
      // 1. Arrange
      const { service, repository, validator, engine } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(
        service.runWorkflowTest(WORKFLOW_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(validator.validateSchema).not.toHaveBeenCalled();
      expect(engine.createExecution).not.toHaveBeenCalled();
    });

    it('2.2 deberia lanzar BadRequestException si el flujo no tiene configuracion_pipeline', async () => {
      // 1. Arrange
      const { service, repository, engine } = buildHarness();
      repository.findOne.mockResolvedValue(
        buildWorkflow({ pipelineSchema: null }),
      );

      // 2. Act + 3. Assert
      await expect(
        service.runWorkflowTest(WORKFLOW_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.createExecution).not.toHaveBeenCalled();
    });

    it('2.3 deberia propagar el BadRequestException del validador sin crear ejecucion', async () => {
      // 1. Arrange
      const { service, validator, engine } = buildHarness();
      validator.validateSchema.mockRejectedValue(
        new BadRequestException({ error: 'PIPELINE_SCHEMA_INVALIDO' }),
      );

      // 2. Act + 3. Assert: el orden importa — validar ANTES de tocar la BD
      await expect(
        service.runWorkflowTest(WORKFLOW_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.createExecution).not.toHaveBeenCalled();
    });
  });

  describe('3. Concurrencia (RNF-09)', () => {
    it('3.1 deberia propagar el ConflictException de createExecution sin arrancar el motor', async () => {
      // 1. Arrange
      const { service, engine } = buildHarness();
      engine.createExecution.mockRejectedValue(
        new ConflictException('ya hay una ejecucion EN_PROCESO'),
      );

      // 2. Act + 3. Assert
      await expect(
        service.runWorkflowTest(WORKFLOW_ID, {}),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(engine.executeWorkflow).not.toHaveBeenCalled();
    });
  });
});

/**
 * Pipeline de tres nodos cuyas CLAVES estan a proposito en orden inverso al de
 * ejecucion (destino -> parser -> trigger).
 *
 * Es el nucleo de la prueba de orden: si la proyeccion usara
 * `Object.values(schema.nodes)`, devolveria justo esta secuencia invertida y el
 * asistente pintaria el stepper al reves.
 */
const buildUnorderedSchema = (): PipelineSchemaDto => ({
  flowId: WORKFLOW_ID,
  name: 'Notiweb - publicacion automatica',
  version: '1.0.0',
  entrypoint: 'trigger_imap',
  nodes: {
    nodo_destino: {
      nodeId: 'nodo_destino',
      nodeType: NodeType.DESTINO_HTTP,
      outputNamespace: 'destino_http',
      nextStep: null,
      onErrorStep: null,
      params: { url: 'https://drupal.unuware.com/jsonapi/node/article' },
    },
    nodo_parser: {
      nodeId: 'nodo_parser',
      nodeType: NodeType.PARSER_PRE_IA,
      outputNamespace: 'parsed_email',
      nextStep: 'nodo_destino',
      onErrorStep: null,
      params: { stripSignatures: true },
    },
    trigger_imap: {
      nodeId: 'trigger_imap',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: 'nodo_parser',
      onErrorStep: null,
      params: {
        host: 'imap.unuware.com',
        user: 'notiweb@unuware.com',
        passwordEnvKey: 'IMAP_PASSWORD',
      },
    },
  },
});

describe('WorkflowsService (catalogo de pipelines del asistente)', () => {
  describe('4. Filtrado de flujos seleccionables', () => {
    it('4.1 deberia omitir los flujos sin configuracion_pipeline', async () => {
      // 1. Arrange: uno configurado y otro a medio crear.
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow(),
        buildWorkflow({ id: EXECUTION_ID, pipelineSchema: null }),
      ]);

      // 2. Act
      const result = await service.findSelectablePipelines();

      // 3. Assert: un flujo sin esquema no sirve como plantilla de la que
      //    partir, y el asistente no tendria pasos que mostrar.
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe(WORKFLOW_ID);
    });

    it('4.2 deberia devolver una lista vacia si ningun flujo tiene esquema', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: null }),
      ]);

      // 2. Act
      const result = await service.findSelectablePipelines();

      // 3. Assert
      expect(result).toEqual([]);
    });

    it('4.3 deberia proyectar los metadatos del flujo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ description: 'Publicacion automatica de noticias' }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert
      expect(summary).toMatchObject({
        id: WORKFLOW_ID,
        name: '[E2E] Mapeador de plantilla',
        description: 'Publicacion automatica de noticias',
        active: true,
      });
    });
  });

  describe('5. Orden de la topologia', () => {
    it('5.1 deberia ordenar los pasos siguiendo nextStep desde entrypoint', async () => {
      // 1. Arrange: las claves del mapa van en orden INVERSO al de ejecucion.
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: buildUnorderedSchema() }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: el orden sale del grafo, no de `Object.keys`. Si saliera del
      //    mapa, esto seria ['nodo_destino', 'nodo_parser', 'trigger_imap'].
      expect(summary?.topology.map((step) => step.nodeId)).toEqual([
        'trigger_imap',
        'nodo_parser',
        'nodo_destino',
      ]);
    });

    it('5.2 deberia proyectar nodeType y outputNamespace de cada paso', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: buildUnorderedSchema() }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: es lo que el frontend necesita para resolver el configurador
      //    y para saber que namespaces aportan los pasos previos.
      expect(summary?.topology[0]).toEqual({
        nodeId: 'trigger_imap',
        nodeType: NodeType.TRIGGER_IMAP,
        outputNamespace: 'raw_email',
      });
    });

    it('5.3 no deberia colgarse ante un nextStep circular', async () => {
      // 1. Arrange: ciclo que `validatePipelineTopology` rechazaria, pero que
      //    una fila escrita por SQL directo puede contener.
      const schema = buildUnorderedSchema();
      schema.nodes.nodo_destino.nextStep = 'trigger_imap';
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: schema }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: el `Set` de visitados corta el bucle; sin el, la peticion
      //    HTTP no volveria nunca.
      expect(summary?.topology).toHaveLength(3);
    });

    it('5.4 deberia truncar la topologia ante un puntero huerfano', async () => {
      // 1. Arrange: `nodo_parser` no existe en el mapa.
      const schema = buildUnorderedSchema();
      delete schema.nodes.nodo_parser;
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: schema }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: devuelve lo acumulado en vez de lanzar. Es un esquema roto,
      //    pero el catalogo debe responder para que alguien pueda verlo.
      expect(summary?.topology.map((step) => step.nodeId)).toEqual([
        'trigger_imap',
      ]);
    });
  });

  describe('6. No filtracion de configuracion sensible', () => {
    it('6.1 no deberia incluir params en ningun paso', async () => {
      // 1. Arrange: el nodo trigger lleva host, user y passwordEnvKey.
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: buildUnorderedSchema() }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: un endpoint de listado no debe convertirse en una fuga de
      //    configuracion de infraestructura hacia el navegador.
      for (const step of summary?.topology ?? []) {
        expect(step).not.toHaveProperty('params');
      }

      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain('imap.unuware.com');
      expect(serialized).not.toContain('IMAP_PASSWORD');
      expect(serialized).not.toContain('drupal.unuware.com');
    });

    it('6.2 no deberia incluir los punteros del grafo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([
        buildWorkflow({ pipelineSchema: buildUnorderedSchema() }),
      ]);

      // 2. Act
      const [summary] = await service.findSelectablePipelines();

      // 3. Assert: el orden ya viene resuelto, asi que el cliente no necesita
      //    recorrer ningun grafo.
      expect(summary?.topology[0]).not.toHaveProperty('nextStep');
      expect(summary?.topology[0]).not.toHaveProperty('onErrorStep');
    });
  });
});

/** Cuerpo valido de `POST /api/workflows`, tal como lo envia el asistente. */
const buildCreateDto = (
  overrides: Partial<CreateWorkflowDto> = {},
): CreateWorkflowDto => ({
  name: 'Notiweb - publicacion automatica',
  description: 'Publica noticias entrantes en el CMS',
  pipelineSchema: buildUnorderedSchema() as unknown as Record<string, unknown>,
  ...overrides,
});

describe('WorkflowsService (alta de flujos desde el asistente)', () => {
  describe('7. Persistencia', () => {
    it('7.1 deberia validar el esquema ANTES de tocar la base de datos', async () => {
      // 1. Arrange
      const { service, validator, repository } = buildHarness();
      validator.validateSchema.mockRejectedValue(
        new BadRequestException('nodes.trigger_imap.nextStep no resuelve'),
      );

      // 2. Act & 3. Assert: la columna `configuracion_pipeline` es la unica
      //    fuente de verdad del motor; admitir ahi un grafo roto seria una
      //    ejecucion que revienta a mitad de camino en vez de un 400 al guardar.
      await expect(
        service.createWorkflow(buildCreateDto(), AUTHOR_ID),
      ).rejects.toThrow(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('7.2 deberia persistir el esquema YA VALIDADO, no el crudo del cuerpo', async () => {
      // 1. Arrange
      const validated = buildUnorderedSchema();
      const { service, validator, repository } = buildHarness();
      validator.validateSchema.mockResolvedValue(validated);

      // 2. Act
      await service.createWorkflow(buildCreateDto(), AUTHOR_ID);

      // 3. Assert: guardar el crudo dejaria en la BD propiedades que el
      //    validador descarta con `whitelist`.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ pipelineSchema: validated }),
      );
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('7.3 deberia tomar la autoria del token y no del cuerpo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();

      // 2. Act
      await service.createWorkflow(buildCreateDto(), AUTHOR_ID);

      // 3. Assert: asi no se puede suplantar al autor.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ createdById: AUTHOR_ID }),
      );
    });

    it('7.4 deberia nacer INACTIVO por defecto', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();

      // 2. Act
      await service.createWorkflow(buildCreateDto(), AUTHOR_ID);

      // 3. Assert: `flujos.activo` gobierna los disparadores automaticos. Un
      //    flujo que se activase solo empezaria a consumir el buzon corporativo
      //    —marcando los correos como leidos— sin revision previa.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });

    it('7.5 deberia respetar un active explicito', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();

      // 2. Act
      await service.createWorkflow(buildCreateDto({ active: true }), AUTHOR_ID);

      // 3. Assert
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ active: true }),
      );
    });

    it('7.6 deberia normalizar una descripcion ausente a null', async () => {
      // 1. Arrange: `description` es opcional en el DTO.
      const dto: Partial<CreateWorkflowDto> = buildCreateDto();
      delete dto.description;
      const { service, repository } = buildHarness();

      // 2. Act
      await service.createWorkflow(dto as CreateWorkflowDto, AUTHOR_ID);

      // 3. Assert: la columna es nullable, no admite `undefined`.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });
  });

  describe('8. Respuesta del alta', () => {
    it('8.1 deberia devolver el resumen con la topologia ordenada', async () => {
      // 1. Arrange
      const { service, validator, repository } = buildHarness();
      const validated = buildUnorderedSchema();
      validator.validateSchema.mockResolvedValue(validated);
      repository.save.mockResolvedValue(
        buildWorkflow({ pipelineSchema: validated }),
      );

      // 2. Act
      const result = await service.createWorkflow(buildCreateDto(), AUTHOR_ID);

      // 3. Assert: misma forma que el listado, para que el cliente no trate de
      //    forma distinta el flujo que acaba de crear.
      expect(result.id).toBe(WORKFLOW_ID);
      expect(result.topology.map((step) => step.nodeId)).toEqual([
        'trigger_imap',
        'nodo_parser',
        'nodo_destino',
      ]);
    });

    it('8.2 no deberia devolver los params de los nodos', async () => {
      // 1. Arrange
      const { service, validator, repository } = buildHarness();
      const validated = buildUnorderedSchema();
      validator.validateSchema.mockResolvedValue(validated);
      repository.save.mockResolvedValue(
        buildWorkflow({ pipelineSchema: validated }),
      );

      // 2. Act
      const result = await service.createWorkflow(buildCreateDto(), AUTHOR_ID);

      // 3. Assert: el alta reutiliza la misma proyeccion segura que el listado.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('IMAP_PASSWORD');
      expect(serialized).not.toContain('imap.unuware.com');
    });
  });
});
