import { ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
} from '@modules/nodes/dto/imap-trigger-config.dto';

import { ImapPollingService } from './imap-polling.service';

import type { ConfigService } from '@nestjs/config';
import type { ImapTriggerConfigDto } from '@modules/nodes/dto/imap-trigger-config.dto';
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
  overrides: Partial<ImapTriggerConfigDto> = {},
): ImapTriggerConfigDto => ({
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

/**
 * Flujo con un nodo IMAP como entrypoint.
 *
 * Los `params` del nodo entran por parametro y no por `overrides` para no tener
 * que repetir el `pipeline_schema` entero solo por cambiar un campo. El `as
 * Workflow` del final es el que absorbe la varianza entre el DTO y el
 * `Record<string, unknown>` de `PipelineNodeConfig.params`.
 */
const buildWorkflow = (
  overrides: Partial<Workflow> = {},
  params: ImapTriggerConfigDto = buildParams(),
): Workflow =>
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
      entrypoint: 'trigger_imap',
      nodes: {
        trigger_imap: {
          nodeId: 'trigger_imap',
          nodeType: NodeType.TRIGGER_IMAP,
          outputNamespace: 'raw_email',
          nextStep: null,
          onErrorStep: null,
          params,
        },
      },
    },
    ...overrides,
  }) as Workflow;

/**
 * Doble del cliente IMAP: el sondeo usa connect, getMailboxLock, search y logout.
 *
 * `search` y no `status`: el sondeo debe aplicar los mismos filtros que la
 * estrategia, y `STATUS` no admite criterios. El coste es seleccionar el buzon,
 * de ahi el `getMailboxLock`.
 *
 * @param matches Cuantos UID devuelve la busqueda; 0 simula "nada que disparar".
 */
const buildClient = (matches = 3): Record<string, jest.Mock> => {
  const release = jest.fn();

  return {
    connect: jest.fn().mockResolvedValue(undefined),
    getMailboxLock: jest.fn().mockResolvedValue({ path: 'INBOX', release }),
    search: jest
      .fn()
      .mockResolvedValue(Array.from({ length: matches }, (_, index) => index + 1)),
    logout: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    release,
  };
};

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
    matches?: number;
  } = {},
): Harness => {
  const {
    workflowRows = [buildWorkflow()],
    env = {
      IMAP_POLLING_ENABLED: 'true',
      [PASSWORD_ENV_KEY]: IMAP_PASSWORD,
    },
    matches = 3,
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

  const client = buildClient(matches);
  ImapFlow.mockImplementation(() => client);

  const service = new ImapPollingService(
    repository as unknown as Repository<Workflow>,
    workflows as unknown as WorkflowsService,
    registry,
    configService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, workflows, repository, registry, client };
};

const intervalNameOf = (flowId: string): string => `imap-poll:${flowId}`;

/**
 * Intervalos de SONDEO inscritos, excluyendo el de reconciliacion.
 *
 * `getIntervals()` devuelve tambien `imap-reconcile`, que no es un buzon
 * vigilado sino la recarga periodica de la tabla: contarlo como uno mas haria
 * que "ningun flujo programado" pareciera "un flujo programado".
 */
const pollIntervalsOf = (registry: SchedulerRegistry): string[] =>
  registry.getIntervals().filter((name) => name.startsWith('imap-poll:'));

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
      expect(pollIntervalsOf(registry)).toHaveLength(0);
    });

    it('1.5 deberia ignorar un flujo sin nodo TRIGGER_IMAP', async () => {
      // 1. Arrange
      const workflow = buildWorkflow();
      const schema = workflow.pipelineSchema;

      if (schema !== null) {
        schema.nodes.trigger_imap.nodeType = NodeType.MAPEADOR_PLANTILLA;
      }

      const { service, registry } = buildHarness({
        workflowRows: [workflow],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(pollIntervalsOf(registry)).toHaveLength(0);
    });

    it('1.6 deberia ignorar un flujo cuyo nodo IMAP tiene params invalidos', async () => {
      // 1. Arrange: un esquema a medio escribir no debe impedir que el resto
      //    de los flujos queden programados.
      const broken = buildWorkflow();
      const brokenSchema = broken.pipelineSchema;

      if (brokenSchema !== null) {
        brokenSchema.nodes.trigger_imap.params = { host: '' };
      }

      const healthy = buildWorkflow({ id: OTHER_FLOW_ID });
      const { service, registry } = buildHarness({
        workflowRows: [broken, healthy],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(pollIntervalsOf(registry)).toEqual([
        intervalNameOf(OTHER_FLOW_ID),
      ]);
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
      expect(pollIntervalsOf(registry)).toEqual([intervalNameOf(FLOW_ID)]);
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
      const { service, workflows } = buildHarness({ matches: 2 });

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(true);
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledWith(FLOW_ID);
    });

    it('2.2 no deberia disparar el flujo con el buzon vacio', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness({ matches: 0 });

      // 2. Act
      const dispatched = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });

    it('2.3 deberia detectar con SEARCH y no descargar ni marcar nada', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: un solo lector del buzon. El sondeo detecta; la estrategia
      //    descarga y marca `\Seen`.
      expect(client.search).toHaveBeenCalledWith({ seen: false }, { uid: true });
      expect(client.download).toBeUndefined();
      expect(client.messageFlagsAdd).toBeUndefined();
    });

    it('2.5 deberia sondear con los MISMOS filtros que usara la estrategia', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(
        FLOW_ID,
        buildParams({
          fromFilter: 'redaccion@noticias.es',
          subjectFilter: 'Notiweb',
        }),
      );

      // 3. Assert: si detectase con un criterio y la estrategia extrajese con
      //    otro, cada correo no leido ajeno al filtro arrancaria una ejecucion
      //    que muere sin datos en el mapeador.
      expect(client.search).toHaveBeenCalledWith(
        {
          seen: false,
          from: 'redaccion@noticias.es',
          subject: 'Notiweb',
        },
        { uid: true },
      );
    });

    it('2.6 NO deberia disparar el flujo si ningun correo casa con los filtros', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness({ matches: 0 });

      // 2. Act
      const dispatched = await service.pollInbox(
        FLOW_ID,
        buildParams({ fromFilter: 'nadie@ejemplo.com' }),
      );

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(workflows.runAutomaticWorkflow).not.toHaveBeenCalled();
    });

    it('2.7 deberia liberar el buzon tras sondear', async () => {
      // 1. Arrange
      const { service, client } = buildHarness();

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: SEARCH exige seleccionar el buzon; no liberarlo dejaria la
      //    conexion bloqueada para el siguiente ciclo.
      expect(client.release).toHaveBeenCalledTimes(1);
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
        getMailboxLock: jest.fn(),
        search: jest.fn(),
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
        getMailboxLock: jest.fn(),
        search: jest.fn(),
        logout: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
      }));

      // 2. Act
      await service.pollInbox(FLOW_ID, buildParams());
      const second = await service.pollInbox(FLOW_ID, buildParams());

      // 3. Assert: el `finally` limpia `inFlight`, asi que el ciclo siguiente
      //    vuelve a intentarlo.
      expect(second).toBe(true);
      expect(client.search).toHaveBeenCalledTimes(1);
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
        getMailboxLock: jest
          .fn()
          .mockResolvedValue({ path: 'INBOX', release: jest.fn() }),
        search: jest.fn().mockResolvedValue([1]),
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
      expect(pollIntervalsOf(registry)).toHaveLength(0);

      // La reconciliacion SI queda armada: es lo que reintentara la consulta
      // cuando PostgreSQL vuelva, sin necesidad de reiniciar el proceso.
      expect(registry.doesExist('interval', 'imap-reconcile')).toBe(true);
      service.onModuleDestroy();
    });
  });

  describe('4. Reconciliacion periodica', () => {
    it('4.1 deberia inscribir el intervalo de reconciliacion al arrancar', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: es la via por la que el sondeo descubre los flujos que el
      //    asistente crea, sin que `WorkflowsService` tenga que notificar nada
      //    (eso crearia un ciclo de modulos).
      expect(registry.doesExist('interval', 'imap-reconcile')).toBe(true);
      service.onModuleDestroy();
    });

    it('4.2 no deberia inscribirla si el sondeo esta deshabilitado', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness({ env: {} });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getIntervals()).toHaveLength(0);
    });

    it('4.3 deberia recoger un flujo nuevo en el siguiente ciclo', async () => {
      // 1. Arrange: al arrancar no hay ningun flujo con nodo IMAP.
      const { service, repository, registry } = buildHarness({
        workflowRows: [],
      });
      await service.onModuleInit();
      expect(pollIntervalsOf(registry)).toHaveLength(0);

      // 2. Act: el asistente crea uno y vence la reconciliacion.
      repository.find.mockResolvedValue([buildWorkflow()]);
      await jest.advanceTimersByTimeAsync(60_000);

      // 3. Assert: queda programado sin que nadie haya notificado el alta.
      expect(pollIntervalsOf(registry)).toEqual([intervalNameOf(FLOW_ID)]);
      service.onModuleDestroy();
    });

    it('4.4 deberia dejar de sondear un flujo que se desactiva', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness();
      await service.onModuleInit();
      expect(pollIntervalsOf(registry)).toHaveLength(1);

      // 2. Act: el flujo deja de estar activo y vence la reconciliacion.
      repository.find.mockResolvedValue([]);
      await jest.advanceTimersByTimeAsync(60_000);

      // 3. Assert: cubre un caso que una notificacion puntual del alta no veria.
      expect(pollIntervalsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('4.5 no deberia propagar un fallo de la reconciliacion', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness();
      await service.onModuleInit();
      repository.find.mockRejectedValue(new Error('Sin conexion a PostgreSQL'));

      // 2. Act & 3. Assert: corre dentro de un `setInterval`, asi que una
      //    promesa rechazada sin manejar terminaria el proceso de Node.
      await expect(
        jest.advanceTimersByTimeAsync(60_000),
      ).resolves.toBeUndefined();
      expect(registry.doesExist('interval', 'imap-reconcile')).toBe(true);
      service.onModuleDestroy();
    });

    it('4.7 deberia CONSERVAR el temporizador de un flujo que no ha cambiado', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();
      await service.onModuleInit();
      const before = registry.getInterval(intervalNameOf(FLOW_ID));

      // 2. Act: la reconciliacion vence y la base de datos devuelve lo mismo.
      await jest.advanceTimersByTimeAsync(60_000);

      // 3. Assert: EL MISMO objeto Timeout, no uno equivalente. Recrearlo
      //    reiniciaria su cuenta atras (ver 4.10).
      expect(registry.getInterval(intervalNameOf(FLOW_ID))).toBe(before);
      service.onModuleDestroy();
    });

    it('4.8 deberia reinscribir el temporizador si cambia la configuracion', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness();
      await service.onModuleInit();
      const before = registry.getInterval(intervalNameOf(FLOW_ID));

      // 2. Act: el asistente cambia el buzon del nodo.
      repository.find.mockResolvedValue([
        buildWorkflow({}, buildParams({ mailbox: 'Archivo' })),
      ]);
      await jest.advanceTimersByTimeAsync(60_000);

      // 3. Assert: el callback captura la config en su clausura, asi que un
      //    cambio EXIGE un temporizador nuevo o el worker seguiria con el
      //    buzon viejo.
      expect(registry.getInterval(intervalNameOf(FLOW_ID))).not.toBe(before);
      service.onModuleDestroy();
    });

    it('4.9 deberia reinscribirlo si cambia el pollIntervalMs', async () => {
      // 1. Arrange
      const { service, repository, registry } = buildHarness();
      await service.onModuleInit();
      const before = registry.getInterval(intervalNameOf(FLOW_ID));

      // 2. Act
      repository.find.mockResolvedValue([
        buildWorkflow({}, buildParams({ pollIntervalMs: 45_000 })),
      ]);
      await jest.advanceTimersByTimeAsync(60_000);

      // 3. Assert: el periodo vive en el propio `setInterval`; sin recrearlo el
      //    cambio no tendria ningun efecto.
      expect(registry.getInterval(intervalNameOf(FLOW_ID))).not.toBe(before);
      service.onModuleDestroy();
    });

    it('4.10 deberia sondear un flujo cuyo periodo supera al de reconciliacion', async () => {
      // 1. Arrange: sondeo cada 120 s, reconciliacion cada 60 s. Es el caso que
      //    el barrido y recreacion rompia: al reinscribirse el temporizador en
      //    cada ciclo de reconciliacion, su cuenta atras volvia a empezar y NUNCA
      //    llegaba a cumplirse. Con los valores por defecto (60 s y 60 s) la
      //    carrera se decidia por milisegundos.
      const { service, workflows, repository } = buildHarness({
        workflowRows: [
          buildWorkflow({}, buildParams({ pollIntervalMs: 120_000 })),
        ],
      });
      await service.onModuleInit();

      // 2. Act: dos ciclos de reconciliacion y uno de sondeo.
      await jest.advanceTimersByTimeAsync(120_000);

      // 3. Assert: el flujo llego a sondearse pese a las reconciliaciones
      //    intermedias, que es justo lo que antes no ocurria.
      expect(repository.find).toHaveBeenCalledTimes(3);
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledWith(FLOW_ID);
      service.onModuleDestroy();
    });

    it('4.6 deberia borrar la reconciliacion en onModuleDestroy', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      service.onModuleDestroy();

      // 3. Assert: sin esto, cada recarga del `--watch` acumularia una recarga
      //    periodica de la generacion anterior del proceso.
      expect(registry.getIntervals()).toHaveLength(0);
    });
  });

  describe('5. Periodo por defecto via IMAP_POLLING_INTERVAL_MS', () => {
    /** Periodo con el que quedo inscrito el flujo, leido del registro paralelo. */
    const scheduledIntervalOf = (service: ImapPollingService): number | undefined =>
      service['scheduled'].get(FLOW_ID)?.pollIntervalMs;

    const envWith = (interval?: string): Record<string, string> => ({
      IMAP_POLLING_ENABLED: 'true',
      [PASSWORD_ENV_KEY]: IMAP_PASSWORD,
      ...(interval === undefined ? {} : { IMAP_POLLING_INTERVAL_MS: interval }),
    });

    /** Nodo que NO declara periodo, para que aplique el de la instalacion. */
    const workflowWithoutInterval = (): Workflow[] => {
      const params = buildParams();
      delete params.pollIntervalMs;

      return [buildWorkflow({}, params)];
    };

    it('5.1 deberia aplicar la variable a un nodo que no declara pollIntervalMs', async () => {
      // 1. Arrange
      const { service } = buildHarness({
        env: envWith('120000'),
        workflowRows: workflowWithoutInterval(),
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(scheduledIntervalOf(service)).toBe(120_000);
      service.onModuleDestroy();
    });

    it('5.2 NO deberia pisar el pollIntervalMs que declara el nodo', async () => {
      // 1. Arrange: el esquema fija su propio periodo
      const { service } = buildHarness({ env: envWith('120000') });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: el periodo es un parametro POR NODO; la variable es solo el
      //    valor de reserva para quien no lo fija.
      expect(scheduledIntervalOf(service)).toBe(POLL_INTERVAL_MS);
      service.onModuleDestroy();
    });

    it('5.3 deberia caer al valor por defecto sin la variable', async () => {
      // 1. Arrange
      const { service } = buildHarness({
        env: envWith(),
        workflowRows: workflowWithoutInterval(),
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(scheduledIntervalOf(service)).toBe(DEFAULT_POLL_INTERVAL_MS);
      service.onModuleDestroy();
    });

    // Un `0` o un valor de dos digitos escrito por error martillearia el
    // servidor IMAP hasta que el proveedor cortase la cuenta, y en silencio. El
    // DTO ya impone este suelo a los nodos; la variable no puede ser la puerta
    // trasera que lo evita.
    it.each(['0', '1000', 'sesenta-mil', '', '60000.5'])(
      '5.4 deberia rechazar el valor %p y usar el de por defecto',
      async (rawValue: string) => {
        // 1. Arrange
        const { service } = buildHarness({
          env: envWith(rawValue),
          workflowRows: workflowWithoutInterval(),
        });

        // 2. Act
        await service.onModuleInit();

        // 3. Assert
        expect(scheduledIntervalOf(service)).toBe(DEFAULT_POLL_INTERVAL_MS);
        service.onModuleDestroy();
      },
    );

    it('5.5 deberia aceptar exactamente el suelo permitido', async () => {
      // 1. Arrange
      const { service } = buildHarness({
        env: envWith(String(MIN_POLL_INTERVAL_MS)),
        workflowRows: workflowWithoutInterval(),
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(scheduledIntervalOf(service)).toBe(MIN_POLL_INTERVAL_MS);
      service.onModuleDestroy();
    });
  });
});
