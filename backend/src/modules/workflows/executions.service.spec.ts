import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { SystemCapacityExceededException } from '@core/fsm/exceptions/system-capacity-exceeded.exception';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { ExecutionsService } from './executions.service';

import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import type { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import type { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { AlertQueryService } from '@modules/logs/services/alert-query.service';
import type { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import type { Workflow } from '@modules/workflows/entities/workflow.entity';
import type { WorkflowsService } from '@modules/workflows/workflows.service';
import type { Repository } from 'typeorm';

const FLOW_ID = 'b6c1f0d2-3e4a-4b5c-8d6e-7f8091a2b3c4';
const EXECUTION_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const USER_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';

/**
 * Operador que reanuda, con su correo.
 *
 * El servicio recibe el `AuthenticatedUser` entero y no solo el identificador:
 * el aviso en tiempo real nombra a quien reanudo, y con el UUID suelto la
 * interfaz imprimia una cadena que no dice nada a nadie.
 */
const CURRENT_USER: AuthenticatedUser = {
  id: USER_ID,
  email: 'editor@unuware.com',
  role: UserRole.EDITOR,
};
const PAUSED_NODE_ID = 'nodo_b';
const LOG_PATH = 'logs/execution-2026-10-10.log';

const buildSchema = (): PipelineSchemaDto => ({
  flowId: FLOW_ID,
  name: 'Flujo de prueba',
  version: '1.0.0',
  entrypoint: 'nodo_a',
  nodes: {
    nodo_a: {
      nodeId: 'nodo_a',
      nodeType: NodeType.TRIGGER_IMAP,
      outputNamespace: 'raw_email',
      nextStep: PAUSED_NODE_ID,
      onErrorStep: null,
      params: {},
    },
    [PAUSED_NODE_ID]: {
      nodeId: PAUSED_NODE_ID,
      nodeType: NodeType.PROCESADOR_IA,
      outputNamespace: 'llm_response',
      nextStep: null,
      onErrorStep: null,
      params: {},
    },
  },
});

/** Fila pausada tipica: la que CU-09 existe para desatascar. */
const buildExecution = (
  overrides: Partial<FsmExecution> = {},
): FsmExecution => ({
  executionId: EXECUTION_ID,
  flowId: FLOW_ID,
  currentState: ExecutionState.PAUSADO,
  activeCursor: PAUSED_NODE_ID,
  contextPayload: { raw_email: { asunto: 'Nota de prensa' } },
  retryState: { [PAUSED_NODE_ID]: 5 },
  logFilePath: LOG_PATH,
  failureReason: 'El nodo fallo (GRAVE).',
  createdAt: new Date('2026-10-10T08:00:00.000Z'),
  updatedAt: new Date('2026-10-10T08:05:00.000Z'),
  ...overrides,
});

const buildWorkflow = (overrides: Partial<Workflow> = {}): Workflow =>
  ({
    id: FLOW_ID,
    name: 'Flujo de prueba',
    description: null,
    active: true,
    pipelineSchema: buildSchema(),
    ...overrides,
  }) as Workflow;

interface ServiceHarness {
  service: ExecutionsService;
  query: {
    findPage: jest.Mock;
    findById: jest.Mock;
    findLiveByFlow: jest.Mock;
  };
  repository: { findOne: jest.Mock };
  validator: { validateSchema: jest.Mock };
  engine: {
    assertGlobalCapacityAvailable: jest.Mock;
    prepareResume: jest.Mock;
    executeWorkflow: jest.Mock;
    createExecution: jest.Mock;
    discardExecution: jest.Mock;
  };
  workflows: {
    deactivateAfterDiscard: jest.Mock;
    reactivateAfterResume: jest.Mock;
    applyStopOnFirstSuccess: jest.Mock;
    publishWorkflowSnapshot: jest.Mock;
  };
  events: ExecutionEventsCoordinator;
  hybridLogger: { logNodeExecution: jest.Mock };
  alertQuery: { findExecutionIdsWithAlerts: jest.Mock };
}

/**
 * Monta el servicio con los cinco colaboradores mockeados.
 *
 * El motor va SIEMPRE mockeado: `executeWorkflow` escribe checkpoints en
 * PostgreSQL en cada transicion, y lo que aqui se comprueba es la orquestacion
 * —que se valide antes de reanudar, que no se cree fila nueva, que las guardas
 * salten en el orden correcto—, no el recorrido del grafo.
 */
const buildHarness = (): ServiceHarness => {
  const query = {
    findPage: jest
      .fn()
      .mockResolvedValue({ items: [buildExecution()], total: 1 }),
    findById: jest.fn().mockResolvedValue(buildExecution()),
    findLiveByFlow: jest.fn().mockResolvedValue([]),
  };
  const repository = {
    findOne: jest.fn().mockResolvedValue(buildWorkflow()),
  };
  const validator = {
    validateSchema: jest.fn().mockResolvedValue(buildSchema()),
  };
  const engine = {
    assertGlobalCapacityAvailable: jest.fn().mockResolvedValue(undefined),
    prepareResume: jest.fn().mockResolvedValue(buildExecution()),
    executeWorkflow: jest.fn().mockResolvedValue(
      buildExecution({
        currentState: ExecutionState.EXITOSO,
        activeCursor: null,
        failureReason: null,
      }),
    ),
    createExecution: jest.fn(),
    discardExecution: jest.fn().mockResolvedValue({
      execution: buildExecution({
        currentState: ExecutionState.DESCARTADO,
        activeCursor: null,
        failureReason: 'Descartada manualmente.',
      }),
      lastCursor: PAUSED_NODE_ID,
    }),
  };
  const workflows = {
    reactivateAfterResume: jest.fn().mockResolvedValue(undefined),
    applyStopOnFirstSuccess: jest.fn().mockResolvedValue(undefined),
    publishWorkflowSnapshot: jest.fn().mockResolvedValue(undefined),
    deactivateAfterDiscard: jest.fn().mockResolvedValue({
      id: FLOW_ID,
      name: 'Flujo de prueba',
      description: null,
      active: false,
      templateId: null,
      topology: [],
    }),
  };
  // Coordinador real sin puertos: no-op silencioso por diseno. Se conserva la
  // referencia para poder espiar sus emisiones.
  const events = new ExecutionEventsCoordinator();

  // Doble del registro hibrido: la reanudacion escribe una fila de demarcacion
  // en `logs_nodo` para separar los dos intentos en la trazabilidad.
  const hybridLogger: { logNodeExecution: jest.Mock } = {
    logNodeExecution: jest
      .fn()
      .mockResolvedValue({ logFilePath: null, logNodeId: null }),
  };

  // Sin alertas por defecto: cada prueba que las necesita las declara.
  const alertQuery: { findExecutionIdsWithAlerts: jest.Mock } = {
    findExecutionIdsWithAlerts: jest.fn().mockResolvedValue(new Set<string>()),
  };

  const service = new ExecutionsService(
    query as unknown as FsmExecutionQueryService,
    repository as unknown as Repository<Workflow>,
    validator as unknown as PipelineValidatorService,
    engine as unknown as FsmEngineService,
    events,
    workflows as unknown as WorkflowsService,
    hybridLogger as unknown as HybridLoggerService,
    alertQuery as unknown as AlertQueryService,
  );
  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);

  return {
    service,
    query,
    repository,
    validator,
    engine,
    workflows,
    events,
    hybridLogger,
    alertQuery,
  };
};

describe('ExecutionsService (consulta y reintento manual CU-09)', () => {
  describe('1. Listado y detalle', () => {
    it('1.1 deberia aplicar el tamano de pagina por defecto', async () => {
      // 1. Arrange
      const { service, query } = buildHarness();

      // 2. Act
      const page = await service.findAll({});

      // 3. Assert
      expect(query.findPage).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 25, offset: 0 }),
      );
      expect(page.limit).toBe(25);
      expect(page.total).toBe(1);
    });

    it('1.1.c deberia acotar por fecha de inicio solo si llega un rango', async () => {
      // 1. Arrange
      const { service, query } = buildHarness();

      // 2. Act
      await service.findAll({});
      await service.findAll({ from: '2026-10-01', to: '2026-10-22' });

      // 3. Assert: sin rango no se acota; "hasta el 22" incluye el dia entero.
      expect(query.findPage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ startedBetween: undefined }),
      );
      expect(query.findPage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          startedBetween: {
            from: new Date('2026-10-01T00:00:00.000Z'),
            to: new Date('2026-10-23T00:00:00.000Z'),
          },
        }),
      );
    });

    it('1.1.b deberia traducir `sortBy` a la propiedad de la lista blanca', async () => {
      // 1. Arrange: la clave publica `startedAt` es la fecha de alta de la fila.
      const { service, query } = buildHarness();

      // 2. Act
      await service.findAll({ sortBy: 'startedAt', sortOrder: 'ASC' });

      // 3. Assert
      expect(query.findPage).toHaveBeenCalledWith(
        expect.objectContaining({
          sort: { column: 'createdAt', order: 'ASC' },
        }),
      );
    });

    it('1.2 deberia proyectar las fechas en ISO 8601', async () => {
      // 1. Arrange: JSON no transporta `Date`; declararlo en el DTO mentiria
      //    sobre lo que recibe el cliente.
      const { service } = buildHarness();

      // 2. Act
      const page = await service.findAll({});

      // 3. Assert
      expect(page.items[0]?.startedAt).toBe('2026-10-10T08:00:00.000Z');
    });

    it('1.2bis deberia marcar hasAlerts con UNA consulta por pagina', async () => {
      // 1. Arrange 📐: el visor de logs se ofrece en las filas con alertas.
      const { service, alertQuery } = buildHarness();
      alertQuery.findExecutionIdsWithAlerts.mockResolvedValue(
        new Set([EXECUTION_ID]),
      );

      // 2. Act ⚙️
      const page = await service.findAll({});

      // 3. Assert 🎯: nunca una consulta por fila.
      expect(alertQuery.findExecutionIdsWithAlerts).toHaveBeenCalledTimes(1);
      expect(alertQuery.findExecutionIdsWithAlerts).toHaveBeenCalledWith(
        page.items.map((item) => item.executionId),
      );
      expect(page.items[0]?.hasAlerts).toBe(true);
    });

    it('1.2ter deberia dejar hasAlerts en false sin alertas', async () => {
      // 1. Arrange 📐
      const { service } = buildHarness();

      // 2. Act ⚙️
      const page = await service.findAll({});

      // 3. Assert 🎯
      expect(page.items.every((item) => !item.hasAlerts)).toBe(true);
    });

    it('1.3 el detalle deberia incluir el contexto acumulado', async () => {
      // 1. Arrange
      const { service } = buildHarness();

      // 2. Act
      const detail = await service.findOne(EXECUTION_ID);

      // 3. Assert
      expect(detail.context).toEqual({
        raw_email: { asunto: 'Nota de prensa' },
      });
      expect(detail.logFilePath).toBe(LOG_PATH);
    });

    it('1.4 deberia lanzar NotFoundException si la ejecucion no existe', async () => {
      // 1. Arrange
      const { service, query } = buildHarness();
      query.findById.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(service.findOne(EXECUTION_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('2. Reanudacion: caso feliz', () => {
    it('2.1 deberia reutilizar la MISMA fila y no crear ninguna nueva', async () => {
      // 1. Arrange: es la propiedad que define CU-09. Si se creara una fila, el
      //    historico crezca con cada intento y se perderia el contexto ya
      //    acumulado, que es justo lo que evita repetir el trabajo hecho.
      const { service, engine } = buildHarness();

      // 2. Act
      const response = await service.resumeExecution(
        EXECUTION_ID,
        {},
        CURRENT_USER,
      );

      // 3. Assert
      expect(engine.createExecution).not.toHaveBeenCalled();
      expect(engine.executeWorkflow).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.anything(),
        { flowName: 'Flujo de prueba' },
      );
      expect(response.executionId).toBe(EXECUTION_ID);
      expect(response.status).toBe(ExecutionState.EXITOSO);
    });

    it('2.2 deberia restaurar los reintentos por defecto', async () => {
      // 1. Arrange: sin esto, reanudar concederia UN intento en vez de la
      //    politica declarada por el nodo.
      const { service, engine } = buildHarness();

      // 2. Act
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert
      expect(engine.prepareResume).toHaveBeenCalledWith(
        EXECUTION_ID,
        undefined,
        true,
        PAUSED_NODE_ID,
        buildSchema(),
        CURRENT_USER.id,
      );
    });

    it('2.2b deberia reactivar el flujo dejando constancia de quien reanuda', async () => {
      // 1. Arrange 📐
      const { service, workflows } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER, {
        sourceIp: '10.0.0.7',
      });

      // 3. Assert 🎯: el actor y la IP viajan al evento `REANUDAR`.
      expect(workflows.reactivateAfterResume).toHaveBeenCalledWith(
        expect.any(String),
        {
          actorId: CURRENT_USER.id,
          executionId: EXECUTION_ID,
          sourceIp: '10.0.0.7',
        },
      );
    });

    it('2.2c deberia republicar la fila del flujo cuando el motor devuelve el control', async () => {
      // 1. Arrange 📐
      const { service, engine, workflows } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯: la foto final sale DESPUES del motor, no antes.
      expect(workflows.publishWorkflowSnapshot).toHaveBeenCalledWith(FLOW_ID);
      expect(
        workflows.publishWorkflowSnapshot.mock.invocationCallOrder[0],
      ).toBeGreaterThan(engine.executeWorkflow.mock.invocationCallOrder[0]);
    });

    it('2.3 deberia trasladar el parche de contexto y el resetRetries explicito', async () => {
      // 1. Arrange
      const { service, engine } = buildHarness();
      const contextPatch = { raw_email: { asunto: 'Corregido' } };

      // 2. Act
      await service.resumeExecution(
        EXECUTION_ID,
        { contextPatch, resetRetries: false },
        CURRENT_USER,
      );

      // 3. Assert
      expect(engine.prepareResume).toHaveBeenCalledWith(
        EXECUTION_ID,
        contextPatch,
        false,
        PAUSED_NODE_ID,
        buildSchema(),
        CURRENT_USER.id,
      );
    });

    it('2.4 NO deberia exigir que el flujo este activo', async () => {
      // 1. Arrange: `activo` gobierna los DISPARADORES automaticos. CU-09 es
      //    una accion manual sobre una ejecucion que ya existe, y exigirlo
      //    dejaria sin salida a las pausadas de todo flujo apagado.
      const { service, repository, engine } = buildHarness();
      repository.findOne.mockResolvedValue(buildWorkflow({ active: false }));

      // 2. Act
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert
      expect(engine.executeWorkflow).toHaveBeenCalledTimes(1);
    });
  });

  describe('2 bis. Reanudacion selectiva (targetStepId)', () => {
    it('2b.1 deberia reanudar desde un paso YA RECORRIDO', async () => {
      // 1. Arrange 📐: `nodo_a` escribio `raw_email`, que esta en el contexto
      //    acumulado. Esa es la prueba de que llego a ejecutarse.
      const { service, engine } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(
        EXECUTION_ID,
        { targetStepId: 'nodo_a' },
        CURRENT_USER,
      );

      // 3. Assert 🎯
      expect(engine.prepareResume).toHaveBeenCalledWith(
        EXECUTION_ID,
        undefined,
        true,
        'nodo_a',
        buildSchema(),
        CURRENT_USER.id,
      );
    });

    it('2b.2 deberia RECHAZAR un paso que no llego a ejecutarse', async () => {
      // 1. Arrange 📐: `nodo_b` es el cursor y nadie escribio `llm_response`.
      //    Saltar hacia adelante dejaria sin contexto los pasos intermedios.
      const { service, engine, query } = buildHarness();

      query.findById.mockResolvedValue(
        buildExecution({ activeCursor: 'nodo_a', contextPayload: {} }),
      );

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        service.resumeExecution(
          EXECUTION_ID,
          { targetStepId: PAUSED_NODE_ID },
          CURRENT_USER,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });

    it('2b.3 deberia RECHAZAR un paso que no existe en el esquema', async () => {
      // 1. Arrange 📐
      const { service, engine } = buildHarness();

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(
        service.resumeExecution(
          EXECUTION_ID,
          { targetStepId: 'nodo_fantasma' },
          CURRENT_USER,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });

    it('2b.4 deberia ACEPTAR el propio cursor como destino', async () => {
      // 1. Arrange 📐: es lo que manda el canvas cuando el operador pulsa sobre
      //    el nodo que ya estaba detenido. Redundante, pero legitimo.
      const { service, engine } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(
        EXECUTION_ID,
        { targetStepId: PAUSED_NODE_ID },
        CURRENT_USER,
      );

      // 3. Assert 🎯
      expect(engine.prepareResume).toHaveBeenCalledWith(
        EXECUTION_ID,
        undefined,
        true,
        PAUSED_NODE_ID,
        buildSchema(),
        CURRENT_USER.id,
      );
    });

    it('2b.4b deberia anunciar el paso elegido y el anterior por el canal', async () => {
      // 1. Arrange 📐: el cliente reinicia las cajas posteriores al punto
      //    elegido y borra la marca de pausa del nodo donde estaba detenida.
      //    Sin las dos claves no puede hacer ni lo uno ni lo otro.
      const { service, events } = buildHarness();
      const emitFlowResumed = jest.spyOn(events, 'emitFlowResumed');

      // 2. Act ⚙️
      await service.resumeExecution(
        EXECUTION_ID,
        { targetStepId: 'nodo_a' },
        CURRENT_USER,
      );

      // 3. Assert 🎯
      expect(emitFlowResumed).toHaveBeenCalledWith(
        expect.objectContaining({
          activeCursor: 'nodo_a',
          targetStepId: 'nodo_a',
          previousCursor: PAUSED_NODE_ID,
          resumedBy: { id: USER_ID, email: CURRENT_USER.email },
        }),
      );
    });

    it('2b.4c NO deberia declarar targetStepId en una reanudacion normal', async () => {
      // 1. Arrange 📐: sin eleccion del operador no hay nada que reiniciar mas
      //    alla de lo que el propio motor vaya pisando.
      const { service, events } = buildHarness();
      const emitFlowResumed = jest.spyOn(events, 'emitFlowResumed');

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯
      expect(emitFlowResumed.mock.calls[0]?.[0]).not.toHaveProperty(
        'targetStepId',
      );
    });

    it('2b.5 deberia dejar una fila de demarcacion en la trazabilidad', async () => {
      // 1. Arrange 📐: reanudar NO borra las filas del intento anterior, asi
      //    que sin esta marca las dos tandas quedarian mezcladas.
      const { service, hybridLogger } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(
        EXECUTION_ID,
        { targetStepId: 'nodo_a' },
        CURRENT_USER,
      );

      // 3. Assert 🎯
      expect(hybridLogger.logNodeExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: EXECUTION_ID,
          nodeId: 'nodo_a',
          status: NodeLogStatus.ADVERTENCIA,
        }),
      );
    });

    it('2b.6 deberia aplicar la politica de corrida unica al terminar', async () => {
      // 1. Arrange 📐: era el defecto. `applyStopOnFirstSuccess` solo corria
      //    desde el despacho automatico, de modo que un flujo que se atascaba,
      //    se reanudaba a mano y terminaba bien se quedaba ACTIVO con su
      //    sondeo vivo: la politica "una sola corrida" solo se cumplia si
      //    nadie habia tenido que intervenir.
      const { service, workflows } = buildHarness();

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯: se le entrega el desenlace REAL del motor, porque las
      // cuatro condiciones de la politica se leen de ahi.
      expect(workflows.applyStopOnFirstSuccess).toHaveBeenCalledTimes(1);
      expect(workflows.applyStopOnFirstSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ id: expect.any(String) }),
        expect.anything(),
        // El desenlace REAL que devolvio el motor: las cuatro condiciones de
        // la politica se leen de ahi (`currentState`, `haltReason`,
        // `tookContingency`).
        expect.objectContaining({ currentState: ExecutionState.EXITOSO }),
      );
    });

    it('2b.7 deberia decidir la politica DESPUES de ejecutar, no antes', async () => {
      // 1. Arrange 📐: hasta que `executeWorkflow` no devuelve no se sabe como
      //    termino, asi que invocarla antes apagaria flujos por el desenlace
      //    del intento ANTERIOR.
      const { service, engine, workflows } = buildHarness();
      const order: string[] = [];
      engine.executeWorkflow.mockImplementation(() => {
        order.push('executeWorkflow');

        return Promise.resolve(
          buildExecution({
            currentState: ExecutionState.EXITOSO,
            activeCursor: null,
            failureReason: null,
          }),
        );
      });
      workflows.applyStopOnFirstSuccess.mockImplementation(() => {
        order.push('applyStopOnFirstSuccess');
      });

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯
      expect(order).toEqual(['executeWorkflow', 'applyStopOnFirstSuccess']);
    });
  });

  describe('2 ter. Omision de la extraccion cara al reanudar', () => {
    /** Esquema cuyo paso detenido es el OCR, que es extraccion cara. */
    const buildOcrSchema = (): PipelineSchemaDto => ({
      ...buildSchema(),
      nodes: {
        nodo_a: {
          nodeId: 'nodo_a',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: PAUSED_NODE_ID,
          onErrorStep: null,
          params: {},
        },
        [PAUSED_NODE_ID]: {
          nodeId: PAUSED_NODE_ID,
          nodeType: NodeType.PROCESADOR_OCR,
          outputNamespace: 'ocr_result',
          nextStep: null,
          onErrorStep: null,
          params: {},
        },
      },
    });

    it('2t.1 deberia omitir el nodo de OCR cuyo resultado se conserva', async () => {
      // 1. Arrange 📐: conservar el namespace no ahorra nada por si solo. El
      //    bucle arranca en el cursor y volveria a ejecutar el nodo, pagando
      //    otra vez la pasada multimodal para sobrescribir con lo mismo.
      const { service, query, validator, engine } = buildHarness();
      validator.validateSchema.mockResolvedValue(buildOcrSchema());
      query.findById.mockResolvedValue(
        buildExecution({
          contextPayload: {
            raw_email: { asunto: 'Nota de prensa' },
            ocr_result: { extracted_text: 'Texto del PDF escaneado' },
          },
        }),
      );

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯
      expect(engine.executeWorkflow).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.anything(),
        expect.objectContaining({
          skipNodeTypes: [NodeType.PROCESADOR_OCR],
        }),
      );
    });

    it('2t.2 NO deberia omitir el nodo si su namespace esta vacio', async () => {
      // 1. Arrange 📐: no hay cache que aprovechar, asi que el OCR tiene que
      //    correr. Omitirlo dejaria al flujo sin el texto que nadie extrajo.
      const { service, query, validator, engine } = buildHarness();
      validator.validateSchema.mockResolvedValue(buildOcrSchema());
      query.findById.mockResolvedValue(
        buildExecution({
          contextPayload: { raw_email: { asunto: 'Nota de prensa' } },
        }),
      );

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯
      expect(engine.executeWorkflow).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.anything(),
        { flowName: 'Flujo de prueba' },
      );
    });

    it('2t.3 NO deberia omitir un nodo que no es de extraccion cara', async () => {
      // 1. Arrange 📐: el `PROCESADOR_IA` del esquema por defecto SI puede dar
      //    algo distinto en el segundo intento, que es justo lo que el
      //    operador busca al reanudar sobre el.
      const { service, query, engine } = buildHarness();
      query.findById.mockResolvedValue(
        buildExecution({
          contextPayload: {
            raw_email: { asunto: 'Nota de prensa' },
            llm_response: { title: 'Corrida anterior' },
          },
        }),
      );

      // 2. Act ⚙️
      await service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER);

      // 3. Assert 🎯
      expect(engine.executeWorkflow).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.anything(),
        { flowName: 'Flujo de prueba' },
      );
    });
  });

  describe('3 bis. Reanudacion de una ejecucion FALLIDO', () => {
    it('3b.1 deberia reanudar una FALLIDO que conserva el cursor', async () => {
      // 1. Arrange 📐: `failCatastrophically` cierra en FALLIDO pero CONSERVA
      //    el cursor, y hasta ahora esa fila no tenia salida: ni se reanudaba
      //    ni se descartaba. Las dos vias que llevan ahi sin que el nodo sea
      //    irreparable —el cierre en cascada al desactivar un flujo y un fallo
      //    de entorno— dejaban trabajo a medias sin forma de retomarlo.
      const { service, query, engine } = buildHarness();
      query.findById.mockResolvedValue(
        buildExecution({ currentState: ExecutionState.FALLIDO }),
      );

      // 2. Act ⚙️
      const response = await service.resumeExecution(
        EXECUTION_ID,
        {},
        CURRENT_USER,
      );

      // 3. Assert 🎯
      expect(engine.prepareResume).toHaveBeenCalledWith(
        EXECUTION_ID,
        undefined,
        true,
        PAUSED_NODE_ID,
        buildSchema(),
        CURRENT_USER.id,
      );
      expect(engine.executeWorkflow).toHaveBeenCalledTimes(1);
      expect(response.executionId).toBe(EXECUTION_ID);
    });

    it('3b.2 deberia rechazar con 409 una FALLIDO que perdio el cursor', async () => {
      // 1. Arrange 📐: sin cursor no hay desde donde reanudar, y arrancar
      //    desde el principio repetiria trabajo ya hecho. La guarda sobrevive
      //    a la apertura del estado.
      const { service, query, engine } = buildHarness();
      query.findById.mockResolvedValue(
        buildExecution({
          currentState: ExecutionState.FALLIDO,
          activeCursor: null,
        }),
      );

      // 2. Act + 3. Assert 🎯
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });
  });

  describe('3. Guardas de estado', () => {
    // `FALLIDO` NO figura: desde la invalidacion selectiva es reanudable, y su
    // caso vive en el bloque 3 bis.
    it.each([
      ExecutionState.EXITOSO,
      ExecutionState.EN_PROCESO,
      ExecutionState.OMITIDO,
      ExecutionState.INACTIVO,
    ])(
      '3.1 deberia rechazar con 409 una ejecucion en estado %s',
      async (state: ExecutionState) => {
        // 1. Arrange: un 409 y no un 400. La peticion esta bien formada y el
        //    recurso existe; lo que no encaja es su estado.
        const { service, query, engine } = buildHarness();
        query.findById.mockResolvedValue(
          buildExecution({ currentState: state }),
        );

        // 2. Act + 3. Assert
        await expect(
          service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(engine.prepareResume).not.toHaveBeenCalled();
      },
    );

    it('3.2 deberia nombrar el estado real en el mensaje', async () => {
      // 1. Arrange: es lo unico que distingue "llegue tarde, ya se reanudo" de
      //    "estoy mirando la ejecucion equivocada".
      const { service, query } = buildHarness();
      query.findById.mockResolvedValue(
        buildExecution({ currentState: ExecutionState.EXITOSO }),
      );

      // 2. Act
      const rejection: unknown = await service
        .resumeExecution(EXECUTION_ID, {}, CURRENT_USER)
        .catch((error: unknown) => error);

      // 3. Assert
      expect((rejection as ConflictException).message).toContain('EXITOSO');
    });

    it('3.3 deberia rechazar con 409 una pausada sin cursor', async () => {
      // 1. Arrange: `pauseAt` siempre lo escribe, asi que llegar aqui sin el
      //    significa que alguien toco la fila por SQL. Sin cursor no hay desde
      //    donde reanudar, y dejarlo pasar repetiria el flujo entero.
      const { service, query, engine } = buildHarness();
      query.findById.mockResolvedValue(buildExecution({ activeCursor: null }));

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });

    it('3.4 deberia lanzar NotFoundException si la ejecucion no existe', async () => {
      // 1. Arrange
      const { service, query, repository } = buildHarness();
      query.findById.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('3.5 deberia lanzar NotFoundException si el flujo que la origino ya no existe', async () => {
      // 1. Arrange
      const { service, repository, validator } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(validator.validateSchema).not.toHaveBeenCalled();
    });
  });

  describe('4. Guardas de esquema', () => {
    it('4.1 deberia lanzar BadRequestException si el flujo perdio su esquema', async () => {
      // 1. Arrange: es un 400 y no un 404. El flujo existe; lo que falta es
      //    terminar de configurarlo.
      const { service, repository, engine } = buildHarness();
      repository.findOne.mockResolvedValue(
        buildWorkflow({ pipelineSchema: null }),
      );

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });

    it('4.2 deberia rechazar con 400 si el nodo del cursor se borro al editar el flujo', async () => {
      // 1. Arrange: LA GUARDA QUE MAS IMPORTA. Sin ella, `executeWorkflow` cae
      //    en su propia guarda de cursor inexistente, vuelve a pausar en el
      //    mismo sitio y devuelve un 200 que no ha hecho NADA: el operador
      //    pulsaria Reanudar diez veces sin entender por que no avanza.
      const { service, validator, engine } = buildHarness();
      const schemaSinNodo = buildSchema();
      delete schemaSinNodo.nodes[PAUSED_NODE_ID];
      validator.validateSchema.mockResolvedValue(schemaSinNodo);

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
      expect(engine.executeWorkflow).not.toHaveBeenCalled();
    });

    it('4.3 deberia propagar el rechazo del validador', async () => {
      // 1. Arrange: la columna JSONB se puede haber escrito por SQL directo, y
      //    el motor recorre el grafo sin defensas en cada paso.
      const { service, validator, engine } = buildHarness();
      validator.validateSchema.mockRejectedValue(
        new BadRequestException('issues'),
      );

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.prepareResume).not.toHaveBeenCalled();
    });
  });

  describe('5. Techo global de saturacion', () => {
    it('5.1 deberia rechazar con 429 si el motor va lleno, antes de preparar nada', async () => {
      // 1. Arrange: reanudar entra al motor por `executeWorkflow` y no por
      //    `createExecution`, asi que la barrera no se aplicaria sola. Sin esta
      //    llamada, cada reintento manual sumaria una ejecucion por encima del
      //    techo y el limite dejaria de significar lo que dice.
      const { service, engine } = buildHarness();
      engine.assertGlobalCapacityAvailable.mockRejectedValue(
        new SystemCapacityExceededException(5, 5),
      );

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(SystemCapacityExceededException);

      // La fila no se toca: preparar y luego no arrancar la dejaria con el
      // contador de reintentos limpio y el motivo borrado sin haber corrido.
      expect(engine.prepareResume).not.toHaveBeenCalled();
      expect(engine.executeWorkflow).not.toHaveBeenCalled();
    });

    it('5.2 deberia comprobar la capacidad DESPUES de validar el esquema', async () => {
      // 1. Arrange: un esquema roto es un diagnostico permanente y la
      //    saturacion es transitoria. Anteponer el 429 haria que el operador
      //    reintentase en bucle un flujo que nunca va a poder reanudarse.
      const { service, validator, engine } = buildHarness();
      validator.validateSchema.mockRejectedValue(
        new BadRequestException('issues'),
      );

      // 2. Act + 3. Assert
      await expect(
        service.resumeExecution(EXECUTION_ID, {}, CURRENT_USER),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(engine.assertGlobalCapacityAvailable).not.toHaveBeenCalled();
    });
  });

  describe('4. Descarte manual (CU-09)', () => {
    it('4.1 deberia cerrar la ejecucion y desactivar su flujo', async () => {
      // 1. Arrange
      const { service, engine, workflows } = buildHarness();

      // 2. Act
      const result = await service.discardExecution(EXECUTION_ID, USER_ID);

      // 3. Assert
      // El descarte conserva su firma con el identificador suelto: no emite
      // ningun aviso que tenga que nombrar a nadie.
      expect(engine.discardExecution).toHaveBeenCalledWith(
        EXECUTION_ID,
        USER_ID,
      );
      expect(workflows.deactivateAfterDiscard).toHaveBeenCalledWith(FLOW_ID, {
        userId: USER_ID,
        executionId: EXECUTION_ID,
        previousState: ExecutionState.PAUSADO,
        reason: null,
        sourceIp: null,
      });
      expect(result.execution.state).toBe(ExecutionState.DESCARTADO);
      // Sin cursor: la fila es terminal y no se reanuda.
      expect(result.execution.activeCursor).toBeNull();
      // El flujo viaja en la misma respuesta porque un cliente que solo
      // recibiera la ejecucion lo pintaria activo hasta la siguiente recarga.
      expect(result.workflow.active).toBe(false);
    });

    // LA GUARDA MENOS OBVIA DE ESTA ENTREGA. Desactivar un flujo pasa por
    // `abortExecutionsForFlow`, que arrastra EN_PROCESO|PAUSADO a FALLIDO. Con
    // el orden invertido, el descarte encontraria la fila ya FALLIDO y la
    // columna `estado` diria que el motor se rindio donde hubo una decision
    // humana.
    it('4.2 deberia descartar ANTES de desactivar el flujo', async () => {
      // 1. Arrange
      const { service, engine, workflows } = buildHarness();
      const order: string[] = [];

      engine.discardExecution.mockImplementation(() => {
        order.push('discard');

        return Promise.resolve({
          execution: buildExecution({
            currentState: ExecutionState.DESCARTADO,
            activeCursor: null,
          }),
          lastCursor: PAUSED_NODE_ID,
        });
      });
      workflows.deactivateAfterDiscard.mockImplementation(() => {
        order.push('deactivate');

        return Promise.resolve({
          id: FLOW_ID,
          name: 'Flujo de prueba',
          description: null,
          active: false,
          templateId: null,
          topology: [],
        });
      });

      // 2. Act
      await service.discardExecution(EXECUTION_ID, USER_ID);

      // 3. Assert
      expect(order).toEqual(['discard', 'deactivate']);
    });

    it('4.3 deberia anunciar el descarte con el paso en el que se detuvo', async () => {
      // 1. Arrange. El cursor viaja en el evento porque la fila acaba de
      //    perderlo: quien lo reciba despues ya no puede consultarlo.
      const { service, events } = buildHarness();
      const emitFlowDiscarded = jest.spyOn(events, 'emitFlowDiscarded');

      // 2. Act
      await service.discardExecution(EXECUTION_ID, USER_ID);

      // 3. Assert
      expect(emitFlowDiscarded).toHaveBeenCalledWith(
        expect.objectContaining({
          executionId: EXECUTION_ID,
          flowId: FLOW_ID,
          discardedBy: USER_ID,
          lastCursor: PAUSED_NODE_ID,
          workflowDeactivated: true,
        }),
      );
    });

    it('4.4 NO deberia desactivar el flujo si el descarte no prospera', async () => {
      // 1. Arrange. El 409 lo decide el motor —solo una PAUSADO se descarta— y
      //    apagar el flujo de todas formas castigaria al operador por pulsar
      //    tarde sobre una ejecucion que ya se reanudo.
      const { service, engine, workflows } = buildHarness();
      engine.discardExecution.mockRejectedValue(
        new ConflictException('No esta PAUSADO.'),
      );

      // 2. Act & 3. Assert
      await expect(
        service.discardExecution(EXECUTION_ID, USER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(workflows.deactivateAfterDiscard).not.toHaveBeenCalled();
    });
  });
});
