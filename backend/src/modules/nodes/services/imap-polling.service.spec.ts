import { ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { ImapPollingService } from './imap-polling.service';

import type { ConfigService } from '@nestjs/config';
import type { Workflow } from '@modules/workflows/entities/workflow.entity';
import type { WorkflowsService } from '@modules/workflows/workflows.service';
import type { Repository } from 'typeorm';

jest.mock('imapflow');

/* eslint-disable @typescript-eslint/no-require-imports */
const { ImapFlow } = require('imapflow') as { ImapFlow: jest.Mock };
/* eslint-enable @typescript-eslint/no-require-imports */

const FLOW_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const OTHER_FLOW_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';
const PASSWORD_ENV_KEY = 'IMAP_PASSWORD';
const IMAP_PASSWORD = 'clave-de-buzon-solo-para-pruebas';
const POLL_INTERVAL_MS = 30_000;
const EXECUTION_ID = 'd5b3e4f6-7a8c-4d9e-8f0a-1b2c3d4e5f60';

type WorkflowsMock = jest.Mocked<
  Pick<WorkflowsService, 'runAutomaticWorkflow'>
>;
type RepositoryMock = jest.Mocked<Pick<Repository<Workflow>, 'find'>>;

/** `params` validos del nodo TRIGGER_IMAP. */
const buildParams = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  host: 'imap.unuware.com',
  port: 993,
  secure: true,
  user: 'notiweb@unuware.com',
  passwordEnvKey: PASSWORD_ENV_KEY,
  mailbox: 'INBOX',
  pollIntervalMs: POLL_INTERVAL_MS,
  markAsRead: true,
  ...overrides,
});

/** Flujo con un nodo IMAP como entrypoint. */
const buildWorkflow = (overrides: Partial<Workflow> = {}): Workflow =>
  ({
    id: FLOW_ID,
    name: 'Noticias entrantes',
    description: null,
    active: true,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    pipelineSchema: {
      flowId: FLOW_ID,
      name: 'Noticias entrantes',
      version: '1.0.0',
      entrypoint: 'nodo_trigger',
      nodes: {
        nodo_trigger: {
          nodeId: 'nodo_trigger',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: null,
          onErrorStep: null,
          params: buildParams(),
        },
      },
    },
    ...overrides,
  }) as Workflow;

/** Doble del cliente IMAP: el sondeo solo usa connect, status y logout. */
const buildClient = (unseen = 3): Record<string, jest.Mock> => ({
  connect: jest.fn().mockResolvedValue(undefined),
  status: jest.fn().mockResolvedValue({ path: 'INBOX', unseen }),
  logout: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
});

interface Harness {
  service: ImapPollingService;
  workflows: WorkflowsMock;
  repository: RepositoryMock;
  registry: SchedulerRegistry;
  client: Record<string, jest.Mock>;
}

/**
 * Monta el servicio con dobles.
 *
 * `SchedulerRegistry` va REAL: es una clase pura en memoria, sin I/O, y su
 * comportamiento (lanzar ante un nombre duplicado, hacer `clearInterval` al
 * borrar) es justo parte del contrato que este servicio debe respetar. Un doble
 * convertiria las aserciones en tautologias.
 */
const buildHarness = (
  options: {
    workflowRows?: Workflow[];
    env?: Record<string, string>;
    unseen?: number;
  } = {},
): Harness => {
  const {
    workflowRows = [buildWorkflow()],
    env = {
      IMAP_POLLING_ENABLED: 'true',
      [PASSWORD_ENV_KEY]: IMAP_PASSWORD,
    },
    unseen = 3,
  } = options;

  const workflows: WorkflowsMock = {
    runAutomaticWorkflow: jest.fn().mockResolvedValue(EXECUTION_ID),
  };
  const repository: RepositoryMock = {
    find: jest.fn().mockResolvedValue(workflowRows),
  };
  const registry = new SchedulerRegistry();
  const configService = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;

  const client = buildClient(unseen);
  ImapFlow.mockImplementation(() => client);

  const service = new ImapPollingService(
    repository as unknown as Repository<Workflow>,
    workflows as unknown as WorkflowsService,
    registry,
    configService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, workflows, repository, registry, client };
};

const intervalNameOf = (flowId: string): string => `imap-poll:${flowId}`;

describe('ImapPollingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('1. Programacion de intervalos', () => {
    it('1.1 no deberia programar nada si IMAP_POLLING_ENABLED no es "true"', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness({ env: {} });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: fallo por omision seguro; ni se consulta la base de datos.
      expect(repository.find).not.toHaveBeenCalled();
      expect(registry.getIntervals()).toHaveLength(0);
    });

    it('1.2 deberia inscribir un intervalo por flujo elegible', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getIntervals()).toContain(intervalNameOf(FLOW_ID));
      service.onModuleDestroy();
    });

    it('1.3 deberia consultar solo los flujos activos', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: `activo` gobierna los disparadores automaticos.
      expect(repository.find).toHaveBeenCalledWith({
        where: { active: true },
      });
      service.onModuleDestroy();
    });

    it('1.4 deberia ignorar un flujo sin pipeline_schema', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness({
        workflowRows: [buildWorkflow({ pipelineSchema: null })],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getIntervals()).toHaveLength(0);
    });

    it('1.5 deberia ignorar un flujo sin nodo TRIGGER_IMAP', async () => {
      // 1. Arrange
      const workflow = buildWorkflow();
      const schema = workflow.pipelineSchema;

      if (schema !== null) {
        schema.nodes.nodo_trigger.nodeType = NodeType.MAPEADOR_PLANTILLA;
      }

      const { service, registry } = buildHarness({
        workflowRows: [workflow],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getIntervals()).toHaveLength(0);
    });

    it('1.6 deberia ignorar un flujo cuyo nodo IMAP tiene params invalidos', async () => {
      // 1. Arrange: un esquema a medio escribir no debe impedir que el resto
      //    de los flujos queden programados.
      const broken = buildWorkflow();
      const brokenSchema = broken.pipelineSchema;

      if (brokenSchema !== null) {
        brokenSchema.nodes.nodo_trigger.params = { host: '' };
      }

      const healthy = buildWorkflow({ id: OTHER_FLOW_ID });
      const { service, registry } = buildHarness({
        workflowRows: [broken, healthy],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getIntervals()).toEqual([intervalNameOf(OTHER_FLOW_ID)]);
      service.onModuleDestroy();
    });

    it('1.7 deberia sondear cuando vence el pollIntervalMs del nodo', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

      // 3. Assert
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledWith(FLOW_ID);
      service.onModuleDestroy();
    });

    it('1.8 deberia poder reprogramar sin chocar con el nombre ya inscrito', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();
      await service.onModuleInit();

      // 2. Act: `addInterval` lanzaria si no se borrase antes.
      await service.refreshSchedules();

      // 3. Assert
      expect(registry.getIntervals()).toEqual([intervalNameOf(FLOW_ID)]);
      service.onModuleDestroy();
    });

    it('1.9 deberia borrar todos los intervalos en onModuleDestroy', async () => {
      // 1. Arrange
      const { service, registry, workflows } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

      // 3. Assert: sin esto, cada recarga de `--watch` dejaria temporizadores
      //    vivos de la generacion anterior del proceso.
      expect(registry.getIntervals()).toHaveLength(0);
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('2. Deteccion y disparo', () => {
    it('2.1 deberia disparar el flujo cuando hay correo sin leer', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness({ unseen: 2 });

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(true);
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledWith(FLOW_ID);
    });

    it('2.2 no deberia disparar el flujo con el buzon vacio', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness({ unseen: 0 });

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });

    it('2.3 deberia usar STATUS y no descargar ni marcar nada', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: un solo lector del buzon. El sondeo detecta; la estrategia
      //    descarga y marca `\Seen`.
      expect(client.status).toHaveBeenCalledWith('INBOX', { unseen: true });
      expect(client.download).toBeUndefined();
      expect(client.messageFlagsAdd).toBeUndefined();
    });

    it('2.4 deberia cerrar la sesion IMAP tras sondear', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(client.logout).toHaveBeenCalledTimes(1);
    });

    it('2.5 deberia registrar un oyente de error en el cliente IMAP', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: un evento 'error' sin oyente tumbaria el proceso de Node.
      expect(client.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('2.6 no deberia sondear si la variable de la contrasena falta', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness({
        env: { IMAP_POLLING_ENABLED: 'true' },
      });

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(ImapFlow).not.toHaveBeenCalled();
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });
  });

  describe('3. Resiliencia del tick', () => {
    it('3.1 no deberia propagar un fallo de conexion', async () => {
      // 1. Arrange: una excepcion escapando del callback de `setInterval`
      //    terminaria el proceso entero.
      const { service, workflows } = buildHarness();
      ImapFlow.mockImplementation(() => ({
        connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        status: jest.fn(),
        logout: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }));

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });

    it('3.2 deberia volver a sondear tras un fallo (libera la guarda)', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();
      ImapFlow.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        status: jest.fn(),
        logout: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }));

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());
      const second = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: el `finally` limpia `inFlight`, asi que el ciclo siguiente
      //    vuelve a intentarlo.
      expect(second).toBe(true);
      expect(client.status).toHaveBeenCalledTimes(1);
    });

    it('3.3 deberia descartar un tick solapado del mismo flujo', async () => {
      // 1. Arrange: el primer sondeo se queda colgado a proposito.
      const { service } = buildHarness();
      let unblock: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        unblock = resolve;
      });

      ImapFlow.mockImplementation(() => ({
        connect: jest.fn().mockReturnValue(pending),
        status: jest.fn().mockResolvedValue({ unseen: 1 }),
        logout: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }));

      // 2. Act
      const first = service.pollInbox(FLOW_ID, buildParams());
      const second = await service.pollInbox(FLOW_ID, buildParams());
      unblock();
      await first;

      // 3. Assert: sin la guarda, un sondeo mas lento que su intervalo abriria
      //    conexiones IMAP en cascada contra el mismo buzon.
      expect(second).toBe(false);
      expect(ImapFlow).toHaveBeenCalledTimes(1);
    });

    it('3.4 deberia tratar el 409 de concurrencia como condicion normal', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new ConflictException('El flujo ya tiene una ejecucion EN_PROCESO.'),
      );

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: no lanza. El correo sigue sin leer y el proximo ciclo lo
      //    recogera; fallar aqui llenaria la traza por un solape esperado.
      expect(dispatched).toBe(false);
    });

    it('3.5 no deberia propagar un fallo inesperado del motor', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new Error('La base de datos se cayo'),
      );

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(false);
    });

    it('3.6 no deberia impedir el arranque si la consulta de flujos falla', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness();
      repository.find.mockRejectedValue(new Error('Sin conexion a PostgreSQL'));

      // 2. Act & 3. Assert: degradacion, no motivo para dejar la API sin
      //    arrancar.
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(registry.getIntervals()).toHaveLength(0);
    });
  });
});
