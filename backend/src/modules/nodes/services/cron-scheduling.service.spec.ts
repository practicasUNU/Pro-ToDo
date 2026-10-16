import { BadRequestException, ConflictException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { SystemCapacityExceededException } from '@core/fsm/exceptions/system-capacity-exceeded.exception';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { CronSchedulingService } from './cron-scheduling.service';

import type { ConfigService } from '@nestjs/config';
import type { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import type { CronTriggerConfigDto } from '@modules/nodes/dto/cron-trigger-config.dto';
import { WorkflowStatus } from '@modules/workflows/enums/workflow-status.enum';
import type { Workflow } from '@modules/workflows/entities/workflow.entity';
import type { WorkflowsService } from '@modules/workflows/workflows.service';
import type { Repository } from 'typeorm';

const FLOW_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const OTHER_FLOW_ID = 'c4a2d3e5-6f7b-4c8d-9e0f-1a2b3c4d5e6f';
const EXECUTION_ID = 'd5b3e4f6-7a8c-4d9e-8f0a-1b2c3d4e5f60';

/** Cada minuto: el vencimiento mas corto que el DTO admite. */
const EVERY_MINUTE = '* * * * *';
const MINUTE_MS = 60_000;
const RECONCILE_MS = 60_000;

const jobNameOf = (flowId: string): string => `cron-trigger:${flowId}`;

type WorkflowsMock = jest.Mocked<
  Pick<WorkflowsService, 'runAutomaticWorkflow'>
>;
type RepositoryMock = jest.Mocked<Pick<Repository<Workflow>, 'find'>>;

const buildParams = (
  overrides: Partial<CronTriggerConfigDto> = {},
): CronTriggerConfigDto => ({
  cronExpression: EVERY_MINUTE,
  timeZone: 'UTC',
  ...overrides,
});

/** Flujo con un nodo CRON como entrypoint. */
const buildWorkflow = (
  overrides: Partial<Workflow> = {},
  params: Record<string, unknown> = buildParams(),
): Workflow =>
  ({
    id: FLOW_ID,
    name: 'Boletin diario',
    description: null,
    status: WorkflowStatus.ACTIVO,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    pipelineSchema: {
      flowId: FLOW_ID,
      name: 'Boletin diario',
      version: '1.0.0',
      entrypoint: 'trigger_cron',
      nodes: {
        trigger_cron: {
          nodeId: 'trigger_cron',
          nodeType: NodeType.TRIGGER_CRON,
          outputNamespace: 'cron_trigger',
          nextStep: null,
          onErrorStep: null,
          params,
        },
      },
    },
    ...overrides,
  }) as Workflow;

interface Harness {
  service: CronSchedulingService;
  workflows: WorkflowsMock;
  repository: RepositoryMock;
  registry: SchedulerRegistry;
  coordinator: FlowPollingCoordinator;
  /** Doble del logger hibrido, para aseverar el escalado a `alertas_error`. */
  hybridLogger: { logWorkerFailure: jest.Mock };
  warnSpy: jest.SpyInstance;
  errorSpy: jest.SpyInstance;
}

/**
 * Monta el servicio con dobles.
 *
 * `SchedulerRegistry` y `FlowPollingCoordinator` van REALES: son clases puras en
 * memoria, sin E/S, y su comportamiento —lanzar ante un nombre duplicado, no
 * arrancar el job al inscribirlo, despachar a todos los puertos— es justo parte
 * del contrato que este servicio debe respetar. Un doble convertiria las
 * aserciones en tautologias.
 */
const buildHarness = (
  options: {
    workflowRows?: Workflow[];
    env?: Record<string, string>;
  } = {},
): Harness => {
  const {
    workflowRows = [buildWorkflow()],
    env = { CRON_SCHEDULING_ENABLED: 'true' },
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

  const coordinator = new FlowPollingCoordinator();
  jest
    .spyOn(coordinator['logger'], 'error')
    .mockImplementation(() => undefined);

  // Doble y no el servicio real: el real abriria transportes de winston y
  // necesitaria dos repositorios. Lo que aqui interesa es CUANDO se le llama.
  const hybridLogger = {
    logWorkerFailure: jest.fn().mockResolvedValue(undefined),
  };

  const service = new CronSchedulingService(
    repository as unknown as Repository<Workflow>,
    workflows as unknown as WorkflowsService,
    registry,
    configService,
    coordinator,
    hybridLogger as unknown as HybridLoggerService,
  );

  jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  const warnSpy = jest
    .spyOn(service['logger'], 'warn')
    .mockImplementation(() => undefined);
  const errorSpy = jest
    .spyOn(service['logger'], 'error')
    .mockImplementation(() => undefined);

  return {
    service,
    workflows,
    repository,
    registry,
    coordinator,
    hybridLogger,
    warnSpy,
    errorSpy,
  };
};

/** Nombres de cron job inscritos por ESTE servicio. */
const cronJobsOf = (registry: SchedulerRegistry): string[] =>
  [...registry.getCronJobs().keys()].filter((name) =>
    name.startsWith('cron-trigger:'),
  );

describe('CronSchedulingService · planificacion de nodos TRIGGER_CRON', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('1. Programacion al arrancar', () => {
    it('1.1 deberia inscribir un cron job por flujo elegible', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toEqual([jobNameOf(FLOW_ID)]);
      service.onModuleDestroy();
    });

    it('1.2 no deberia programar nada con la bandera apagada', async () => {
      // 1. Arrange: el fallo por omision es NO disparar, para que una maquina
      //    de desarrollo no publique por su cuenta.
      const { service, registry, repository } = buildHarness({ env: {} });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('1.3 deberia consultar solo los flujos activos', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: `status` gobierna los disparadores automaticos, y solo el
      //    valor ACTIVO los habilita.
      expect(repository.find).toHaveBeenCalledWith({
        where: { status: WorkflowStatus.ACTIVO },
      });
      service.onModuleDestroy();
    });

    it('1.4 no deberia programar un flujo sin configuracion_pipeline', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness({
        workflowRows: [buildWorkflow({ pipelineSchema: null })],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('1.5 no deberia programar un flujo sin nodo TRIGGER_CRON', async () => {
      // 1. Arrange
      const workflow = buildWorkflow();
      const schema = workflow.pipelineSchema;
      if (schema !== null) {
        schema.nodes.trigger_cron.nodeType = NodeType.TRIGGER_IMAP;
      }

      const { service, registry } = buildHarness({
        workflowRows: [workflow],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('1.5.1 no deberia programar un nodo CRON que NO es el entrypoint, y avisar', async () => {
      // 1. Arrange: el disparador existe pero el flujo arranca en otro nodo, asi
      //    que el motor nunca lo ejecutaria. Antes se programaba igual.
      const workflow = buildWorkflow();
      const schema = workflow.pipelineSchema;

      if (schema !== null) {
        schema.nodes.nodo_previo = {
          nodeId: 'nodo_previo',
          nodeType: NodeType.MAPEADOR_PLANTILLA,
          outputNamespace: 'rendered_html',
          nextStep: 'trigger_cron',
          onErrorStep: null,
          params: {},
        };
        schema.entrypoint = 'nodo_previo';
      }

      const { service, registry, warnSpy } = buildHarness({
        workflowRows: [workflow],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('entrypoint'),
      );
      service.onModuleDestroy();
    });

    it('1.5.2 no deberia avisar de un flujo que simplemente no es CRON', async () => {
      // 1. Arrange: un flujo IMAP pasando por el planificador Cron es el caso
      //    NORMAL, y avisarlo taparia los avisos reales con ruido.
      const workflow = buildWorkflow();
      const schema = workflow.pipelineSchema;

      if (schema !== null) {
        schema.nodes.trigger_cron.nodeType = NodeType.TRIGGER_IMAP;
      }

      const { service, registry, warnSpy } = buildHarness({
        workflowRows: [workflow],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      expect(warnSpy).not.toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('1.6 no deberia programar un flujo con params invalidos', async () => {
      // 1. Arrange: un esquema a medio escribir no puede impedir que el resto
      //    de los flujos queden programados al arrancar.
      const { service, registry, warnSpy } = buildHarness({
        workflowRows: [
          buildWorkflow({}, { cronExpression: 'todos los lunes' }),
        ],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });

    it('1.7 no deberia impedir el arranque si el repositorio falla', async () => {
      // 1. Arrange
      const { service, repository, errorSpy } = buildHarness();
      repository.find.mockRejectedValue(new Error('PostgreSQL no responde'));

      // 2. Act & 3. Assert
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  describe('2. Disparo al vencer la programacion', () => {
    it('2.1 deberia despachar el flujo cuando vence su expresion', async () => {
      // 1. Arrange
      const { service, workflows } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      await jest.advanceTimersByTimeAsync(MINUTE_MS);

      // 3. Assert
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledWith(FLOW_ID);
      service.onModuleDestroy();
    });

    it('2.2 deberia arrancar el job al inscribirlo', async () => {
      // 1. Arrange: `addCronJob` inscribe pero NO arranca; sin el `start()`
      //    explicito el job no venceria nunca.
      const { service, registry } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.getCronJob(jobNameOf(FLOW_ID)).isActive).toBe(true);
      service.onModuleDestroy();
    });

    it('2.3 deberia omitir el vencimiento si el anterior sigue en curso', async () => {
      // 1. Arrange: un pipeline mas lento que su propia expresion.
      const { service, workflows, warnSpy } = buildHarness();
      let release = (): void => undefined;
      workflows.runAutomaticWorkflow.mockImplementation(
        async () =>
          new Promise<string>((resolve) => {
            release = () => {
              resolve(EXECUTION_ID);
            };
          }),
      );

      // 2. Act
      const first = service.runScheduledFlow(FLOW_ID);
      const second = await service.runScheduledFlow(FLOW_ID);
      release();
      await first;

      // 3. Assert
      expect(second).toBe(false);
      expect(workflows.runAutomaticWorkflow).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('3. Resiliencia del despacho', () => {
    it('3.1 deberia tratar el conflicto de RNF-09 como aviso y no propagarlo', async () => {
      // 1. Arrange: el flujo ya tiene una instancia EN_PROCESO.
      const { service, workflows, warnSpy, errorSpy } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new ConflictException('Ya hay una ejecucion EN_PROCESO'),
      );

      // 2. Act
      const dispatched = await service.runScheduledFlow(FLOW_ID);

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('3.2 deberia tratar el rechazo del motor como aviso', async () => {
      // 1. Arrange: el caso real es un vencimiento en vuelo cuando alguien
      //    desactiva el flujo. No es una averia de este servicio.
      const { service, workflows, warnSpy, errorSpy } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new BadRequestException('El flujo esta desactivado'),
      );

      // 2. Act
      const dispatched = await service.runScheduledFlow(FLOW_ID);

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('3.3 no deberia propagar un fallo inesperado', async () => {
      // 1. Arrange: esto corre dentro del callback de un CronJob; una excepcion
      //    escapando de ahi terminaria el proceso de Node.
      const { service, workflows, errorSpy } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new Error('El motor exploto'),
      );

      // 2. Act
      const dispatched = await service.runScheduledFlow(FLOW_ID);

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('3.4 no deberia abortar la reconciliacion si un flujo tiene una zona que CronTime rechaza', async () => {
      // 1. Arrange: `Intl` acepta zonas que luxon no, asi que el DTO deja pasar
      //    algunas que hacen lanzar al constructor de CronJob.
      const broken = buildWorkflow({ id: OTHER_FLOW_ID }, buildParams());
      const brokenSchema = broken.pipelineSchema;
      if (brokenSchema !== null) {
        brokenSchema.nodes.trigger_cron.params = {
          cronExpression: EVERY_MINUTE,
          timeZone: 'Zona/Inexistente',
        };
      }

      const { service, registry, warnSpy } = buildHarness({
        workflowRows: [broken, buildWorkflow()],
      });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: el flujo sano queda programado pese al roto.
      expect(cronJobsOf(registry)).toEqual([jobNameOf(FLOW_ID)]);
      expect(warnSpy).toHaveBeenCalled();
      service.onModuleDestroy();
    });
  });

  describe('4. Reconciliacion periodica', () => {
    it('4.1 deberia inscribir el intervalo de reconciliacion', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();

      // 2. Act
      await service.onModuleInit();

      // 3. Assert: como INTERVALO y no como cron job, para que el barrido por
      //    prefijo de `clearSchedules` no pueda cancelarlo.
      expect(registry.doesExist('interval', 'cron-reconcile')).toBe(true);
      service.onModuleDestroy();
    });

    it('4.2 no deberia inscribirlo con la bandera apagada', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness({ env: {} });

      // 2. Act
      await service.onModuleInit();

      // 3. Assert
      expect(registry.doesExist('interval', 'cron-reconcile')).toBe(false);
    });

    it('4.3 deberia dar de alta un flujo nuevo en el siguiente ciclo', async () => {
      // 1. Arrange
      const { service, registry, repository } = buildHarness({
        workflowRows: [],
      });
      await service.onModuleInit();
      repository.find.mockResolvedValue([buildWorkflow()]);

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(cronJobsOf(registry)).toEqual([jobNameOf(FLOW_ID)]);
      service.onModuleDestroy();
    });

    it('4.4 deberia dar de baja un flujo desactivado', async () => {
      // 1. Arrange
      const { service, registry, repository } = buildHarness();
      await service.onModuleInit();
      repository.find.mockResolvedValue([]);

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('4.5 deberia conservar intacto el job de un flujo sin cambios', async () => {
      // 1. Arrange: destruir y recrear reiniciaria la cuenta atras, y un flujo
      //    "cada hora" reconciliado cada minuto no venceria NUNCA.
      const { service, registry } = buildHarness();
      await service.onModuleInit();
      const before = registry.getCronJob(jobNameOf(FLOW_ID));

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(registry.getCronJob(jobNameOf(FLOW_ID))).toBe(before);
      service.onModuleDestroy();
    });

    it('4.6 deberia reinscribir el job si cambia la expresion', async () => {
      // 1. Arrange
      const { service, registry, repository } = buildHarness();
      await service.onModuleInit();
      const before = registry.getCronJob(jobNameOf(FLOW_ID));
      repository.find.mockResolvedValue([
        buildWorkflow({}, buildParams({ cronExpression: '*/5 * * * *' })),
      ]);

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(registry.getCronJob(jobNameOf(FLOW_ID))).not.toBe(before);
      service.onModuleDestroy();
    });

    it('4.7 deberia reinscribir el job si cambia la zona horaria', async () => {
      // 1. Arrange
      const { service, registry, repository } = buildHarness();
      await service.onModuleInit();
      const before = registry.getCronJob(jobNameOf(FLOW_ID));
      repository.find.mockResolvedValue([
        buildWorkflow({}, buildParams({ timeZone: 'Europe/Madrid' })),
      ]);

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(registry.getCronJob(jobNameOf(FLOW_ID))).not.toBe(before);
      service.onModuleDestroy();
    });

    it('4.8 deberia borrar todos sus temporizadores en onModuleDestroy', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      service.onModuleDestroy();

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      expect(registry.doesExist('interval', 'cron-reconcile')).toBe(false);
    });
  });

  describe('5. Convivencia con el sondeo IMAP', () => {
    it('5.1 no deberia tocar los temporizadores del sondeo IMAP al destruirse', async () => {
      // 1. Arrange: `SchedulerRegistry` es compartido; un barrido sin filtrar
      //    por prefijo dejaria los buzones sin sondear.
      const { service, registry } = buildHarness();
      await service.onModuleInit();
      registry.addInterval(
        `imap-poll:${OTHER_FLOW_ID}`,
        setInterval(() => undefined, MINUTE_MS),
      );

      // 2. Act
      service.onModuleDestroy();

      // 3. Assert
      expect(registry.doesExist('interval', `imap-poll:${OTHER_FLOW_ID}`)).toBe(
        true,
      );
      registry.deleteInterval(`imap-poll:${OTHER_FLOW_ID}`);
    });

    it('5.2 deberia registrarse en el coordinador al arrancar', async () => {
      // 1. Arrange
      const { service, registry, coordinator } = buildHarness();

      // 2. Act
      await service.onModuleInit();
      coordinator.stopPollingForFlow(FLOW_ID);

      // 3. Assert: es lo que permite a `WorkflowsService` pararlo sin inyectar
      //    este servicio, que cerraria un ciclo de modulos.
      expect(cronJobsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('5.3 no deberia registrarse con la bandera apagada', async () => {
      // 1. Arrange: sin esta guarda, un `refreshPolling()` externo inscribiria
      //    temporizadores que ningun ciclo de reconciliacion mantiene.
      const { service, coordinator, repository } = buildHarness({ env: {} });
      await service.onModuleInit();

      // 2. Act
      await coordinator.refreshPolling();

      // 3. Assert
      expect(repository.find).not.toHaveBeenCalled();
    });

    it('5.4 deberia dejar de recibir despachos tras onModuleDestroy', async () => {
      // 1. Arrange
      const { service, coordinator } = buildHarness();
      await service.onModuleInit();
      const stopSpy = jest.spyOn(service, 'stopSchedulingForFlow');

      // 2. Act
      service.onModuleDestroy();
      coordinator.stopPollingForFlow(FLOW_ID);

      // 3. Assert
      expect(stopSpy).not.toHaveBeenCalled();
    });
  });

  describe('6. Parada bajo demanda al desactivar un flujo', () => {
    it('6.1 deberia borrar el job del flujo indicado', async () => {
      // 1. Arrange
      const { service, registry } = buildHarness();
      await service.onModuleInit();

      // 2. Act
      service.stopSchedulingForFlow(FLOW_ID);

      // 3. Assert
      expect(cronJobsOf(registry)).toHaveLength(0);
      service.onModuleDestroy();
    });

    it('6.2 no deberia lanzar si el flujo no estaba programado', async () => {
      // 1. Arrange: es el caso normal al desactivar un flujo sin nodo CRON.
      const { service } = buildHarness();
      await service.onModuleInit();

      // 2. Act & 3. Assert
      expect(() => {
        service.stopSchedulingForFlow(OTHER_FLOW_ID);
      }).not.toThrow();
      service.onModuleDestroy();
    });

    it('6.3 deberia permitir que la reconciliacion reinscriba el flujo reactivado', async () => {
      // 1. Arrange: si la parada no limpiara el registro paralelo, el diffing lo
      //    daria por "intacto" y el flujo quedaria activo y mudo para siempre.
      const { service, registry } = buildHarness();
      await service.onModuleInit();
      service.stopSchedulingForFlow(FLOW_ID);

      // 2. Act
      await jest.advanceTimersByTimeAsync(RECONCILE_MS);

      // 3. Assert
      expect(cronJobsOf(registry)).toEqual([jobNameOf(FLOW_ID)]);
      service.onModuleDestroy();
    });
  });

  describe('7. Contrapresion ante la saturacion global del motor', () => {
    it('7.1 deberia absorber la saturacion sin propagarla ni acusar al planificador', async () => {
      // 1. Arrange: esto corre dentro del callback de un `CronJob`. Una
      //    excepcion que escapara terminaria el proceso de Node entero.
      const { service, workflows, warnSpy, errorSpy } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new SystemCapacityExceededException(5, 5),
      );

      // 2. Act
      const dispatched = await service.runScheduledFlow(FLOW_ID);

      // 3. Assert
      expect(dispatched).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Motor saturado'),
      );
      // A nivel `warn` y nunca `error`: el motor va lleno, no se ha roto nada.
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('7.2 no deberia repetir la alerta mientras la saturacion se mantenga', async () => {
      // 1. Arrange: con una expresion `* * * * *`, sin la marca en memoria esto
      //    dejaria una fila GRAVE por minuto describiendo lo mismo.
      const { service, workflows, hybridLogger } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new SystemCapacityExceededException(5, 5),
      );

      // 2. Act: tres vencimientos consecutivos saturados
      await service.runScheduledFlow(FLOW_ID);
      await service.runScheduledFlow(FLOW_ID);
      await service.runScheduledFlow(FLOW_ID);

      // 3. Assert
      expect(hybridLogger.logWorkerFailure).toHaveBeenCalledTimes(1);
    });

    it('7.3 deberia volver a alertar si el motor se libera y vuelve a saturarse', async () => {
      // 1. Arrange
      const { service, workflows, hybridLogger } = buildHarness();
      workflows.runAutomaticWorkflow
        .mockRejectedValueOnce(new SystemCapacityExceededException(5, 5))
        .mockResolvedValueOnce(EXECUTION_ID)
        .mockRejectedValueOnce(new SystemCapacityExceededException(5, 5));

      // 2. Act: saturado, recuperado, saturado otra vez
      await service.runScheduledFlow(FLOW_ID);
      await service.runScheduledFlow(FLOW_ID);
      await service.runScheduledFlow(FLOW_ID);

      // 3. Assert: sin rearmar en la recuperacion, una saturacion posterior
      // quedaria muda para siempre.
      expect(hybridLogger.logWorkerFailure).toHaveBeenCalledTimes(2);
    });

    it('7.4 no deberia propagar un fallo del registro de la alerta', async () => {
      // 1. Arrange
      const { service, workflows, hybridLogger } = buildHarness();
      workflows.runAutomaticWorkflow.mockRejectedValue(
        new SystemCapacityExceededException(5, 5),
      );
      hybridLogger.logWorkerFailure.mockRejectedValue(
        new Error('connection terminated'),
      );

      // 2. Act & 3. Assert
      await expect(service.runScheduledFlow(FLOW_ID)).resolves.toBe(false);
    });
  });
});
