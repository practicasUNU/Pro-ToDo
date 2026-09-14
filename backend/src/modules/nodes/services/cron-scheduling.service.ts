import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
// Import de VALOR y no `import type`: `ConfigService` y `SchedulerRegistry` se
// inyectan por constructor, y con `emitDecoratorMetadata` un `import type` se
// borra al transpilar, dejando a Nest sin el token que necesita para resolver.
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';

import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  CronTriggerConfigDto,
  resolveCronConfig,
} from '@modules/nodes/dto/cron-trigger-config.dto';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsService } from '@modules/workflows/workflows.service';

import type { FlowPollingPort } from '@common/services/flow-polling.coordinator';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ResolvedCronTriggerConfig } from '@modules/nodes/dto/cron-trigger-config.dto';

const CRON_JOB_PREFIX = 'cron-trigger';
const SCHEDULING_ENABLED_KEY = 'CRON_SCHEDULING_ENABLED';
const RECONCILE_INTERVAL_NAME = 'cron-reconcile';
const RECONCILE_INTERVAL_KEY = 'CRON_RECONCILE_INTERVAL_MS';
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/** Nombre con el que el `CronJob` de un flujo queda inscrito en el registro. */
const jobName = (flowId: string): string => `${CRON_JOB_PREFIX}:${flowId}`;

/** Un flujo programado y la configuracion con la que se programo. */
interface CronTriggerNode {
  readonly flowId: string;
  readonly config: ResolvedCronTriggerConfig;
}

/**
 * Planificador de los nodos TRIGGER_CRON (PROT-13).
 *
 * Mantiene un `CronJob` por flujo activo que declare un nodo TRIGGER_CRON y lo
 * despacha via `WorkflowsService.runAutomaticWorkflow` cuando vence, igual que
 * `ImapPollingService` hace con los buzones. Comparte con el toda la estructura
 * —bandera de entorno, reconciliacion periodica por diffing, guarda de
 * reentrada y registro en `FlowPollingCoordinator`— y se diferencia solo en el
 * temporizador: aqui el periodo no es un numero de milisegundos sino una
 * expresion cron con zona horaria, asi que se usa `addCronJob` y no
 * `addInterval`.
 *
 * NO se usa el decorador `@Cron`, por el mismo motivo que alli: la programacion
 * la declara cada nodo en su `params`, y un decorador la fijaria en el codigo.
 *
 * DEUDA TECNICA declarada: `architecture-patterns.md` §5 pide que la ingesta
 * disparada por Cron viaje por una cola de BullMQ. Aqui el despacho es en
 * proceso, asi que un flujo largo ocupa el hilo del worker. El salto a la cola
 * consiste en sustituir el cuerpo de `dispatchFlow`.
 *
 * Con varias replicas del backend, cada una programaria el mismo flujo y
 * dispararia a la vez; el indice `idx_flujo_activo` (RNF-09) evita la ejecucion
 * duplicada, pero la solucion real es la misma cola.
 */
@Injectable()
export class CronSchedulingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronSchedulingService.name);

  /**
   * Flujos con un despacho en curso.
   *
   * Sin esta guarda, un flujo mas lento que su propia expresion —"cada minuto"
   * sobre un pipeline que tarda tres— se solaparia consigo mismo y acumularia
   * despachos que el mutex de ejecucion rechazaria uno tras otro.
   */
  private readonly inFlight = new Set<string>();

  /**
   * Configuracion con la que cada flujo quedo programado, indexada por `flowId`.
   *
   * `SchedulerRegistry` guarda el `CronJob` pero no CON QUE se creo, asi que sin
   * este registro paralelo la reconciliacion no puede distinguir "este flujo ya
   * esta programado igual" de "esta programado con la expresion antigua".
   */
  private readonly scheduled = new Map<string, ResolvedCronTriggerConfig>();

  /**
   * Puerto inscrito en el coordinador, retenido para poder darse de baja.
   *
   * El coordinador guarda un `Set`, asi que la baja necesita LA MISMA
   * referencia que se dio de alta.
   */
  private registeredPort: FlowPollingPort | null = null;

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly workflowsService: WorkflowsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
    private readonly flowPollingCoordinator: FlowPollingCoordinator,
  ) {}

  public async onModuleInit(): Promise<void> {
    if (this.configService.get<string>(SCHEDULING_ENABLED_KEY) !== 'true') {
      this.logger.warn(
        `Planificacion CRON deshabilitada (${SCHEDULING_ENABLED_KEY} != "true"): no se programara ningun flujo.`,
      );
      return;
    }

    // El registro va DESPUES de la guarda, no antes: con la planificacion
    // apagada no hay nada que parar, y sobre todo no debe poder reconciliarse
    // desde fuera. Un `refreshPolling()` disparado por la activacion de un flujo
    // empezaria a inscribir temporizadores que ningun ciclo de reconciliacion
    // mantiene, saltandose la decision de que el fallo por omision sea NO
    // disparar.
    this.registeredPort = {
      stopPollingForFlow: (flowId: string) =>
        this.stopSchedulingForFlow(flowId),
      refreshPolling: () => this.refreshSchedules(),
    };
    this.flowPollingCoordinator.register(this.registeredPort);

    // No relanza: no poder programar los flujos es una degradacion, no un motivo
    // para impedir que la API arranque. La reconciliacion periodica que se
    // registra debajo lo reintentara por su cuenta.
    try {
      await this.refreshSchedules();
    } catch (error) {
      this.logger.error(
        `No se pudo programar la planificacion CRON al arrancar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.registerReconcileInterval();
  }

  public onModuleDestroy(): void {
    this.clearSchedules();
    this.deleteIntervalIfExists(RECONCILE_INTERVAL_NAME);

    if (this.registeredPort !== null) {
      this.flowPollingCoordinator.unregister(this.registeredPort);
      this.registeredPort = null;
    }
  }

  /**
   * Destruye el temporizador de un flujo AHORA, sin esperar a la reconciliacion.
   *
   * El diffing ya retira los flujos desactivados, pero solo en su siguiente
   * ciclo: hasta un minuto entero durante el cual un flujo que nadie deberia
   * disparar puede vencer y ejecutarse. Este es el camino rapido para cuando
   * sabemos, en el instante exacto, que deja de estar operativo.
   *
   * Idempotente: parar un flujo que no estaba programado no es un error, y es de
   * hecho el caso normal al desactivar un flujo sin nodo CRON.
   */
  public stopSchedulingForFlow(flowId: string): void {
    try {
      this.deleteCronJobIfExists(jobName(flowId));
    } finally {
      // En el `finally` a proposito. El Map es la FUENTE DE VERDAD del diffing,
      // y dejarlo sucio es peor que un job huerfano: al reactivar el flujo antes
      // del siguiente ciclo, la fase de altas lo veria "ya programado e intacto"
      // y no volveria a inscribirlo nunca.
      this.scheduled.delete(flowId);
    }

    this.logger.log(
      `Planificacion CRON detenida bajo demanda para el flujo "${flowId}".`,
    );
  }

  /**
   * Reconcilia los temporizadores con el estado actual de la tabla `flujos`.
   *
   * Publico y no solo interno: el `pipeline_schema` puede cambiar en caliente
   * desde el asistente, y sin una recarga el planificador seguiria usando la
   * expresion antigua hasta el siguiente reinicio.
   *
   * DIFFING y no barrido y recreacion, por el mismo motivo que en el sondeo
   * IMAP, y aqui todavia mas grave: destruir y recrear un `CronJob` reinicia su
   * cuenta atras, de modo que un flujo programado "cada hora" reconciliado cada
   * minuto no llegaria a dispararse NUNCA.
   */
  public async refreshSchedules(): Promise<void> {
    const nodes = await this.findCronTriggerNodes();

    const desired = new Map<string, ResolvedCronTriggerConfig>(
      nodes.map((node) => [node.flowId, node.config]),
    );

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // 1. Bajas: programados que la base de datos ya no devuelve. Cubre el flujo
    //    desactivado, el borrado y el que perdio su nodo CRON.
    for (const flowId of [...this.scheduled.keys()]) {
      if (!desired.has(flowId)) {
        this.deleteCronJobIfExists(jobName(flowId));
        this.scheduled.delete(flowId);
        removed.push(flowId);
      }
    }

    // 2. Altas y cambios. Un flujo intacto NO se toca: ese es el punto entero.
    for (const [flowId, config] of desired) {
      const current = this.scheduled.get(flowId);

      // La segunda condicion repara la invariante "esta en `scheduled` <=>
      // existe su job" en vez de darla por supuesta: `stopSchedulingForFlow` es
      // un segundo escritor del par, y si alguna vez se desincronizan un flujo
      // activo quedaria mudo para siempre.
      if (
        current === undefined ||
        !this.schedulerRegistry.doesExist('cron', jobName(flowId))
      ) {
        this.registerJob({ flowId, config });
        added.push(flowId);
        continue;
      }

      if (this.hasConfigChanged(current, config)) {
        this.registerJob({ flowId, config });
        updated.push(flowId);
      }
    }

    this.logger.log(
      `Planificacion CRON reconciliada: ${this.scheduled.size} flujo(s) programados | altas=${added.length} bajas=${removed.length} cambios=${updated.length}.`,
    );
  }

  /**
   * Compara dos configuraciones ya resueltas del mismo flujo.
   *
   * `JSON.stringify` basta porque `ResolvedCronTriggerConfig` es un objeto plano
   * de primitivas construido siempre por el mismo literal de
   * `resolveCronConfig`: el orden de las claves es estable por construccion.
   */
  private hasConfigChanged(
    current: ResolvedCronTriggerConfig,
    next: ResolvedCronTriggerConfig,
  ): boolean {
    return JSON.stringify(current) !== JSON.stringify(next);
  }

  /**
   * Inscribe el `CronJob` de un flujo, sustituyendo el que hubiera.
   *
   * Un fallo de construccion NO se propaga: `CronTime` lanza `CronError` ante
   * una zona horaria que `Intl` acepta pero luxon no, y dejar escapar esa
   * excepcion abortaria la reconciliacion entera, castigando a todos los demas
   * flujos por la configuracion de uno.
   */
  private registerJob(node: CronTriggerNode): void {
    const name = jobName(node.flowId);

    // `addCronJob` lanza si el nombre ya existe.
    this.deleteCronJobIfExists(name);

    let job: CronJob;

    try {
      job = new CronJob(
        node.config.cronExpression,
        () => {
          void this.runScheduledFlow(node.flowId);
        },
        null,
        // Sin arrancar aqui: `addCronJob` envuelve el tick en su propio
        // try/catch al inscribirlo, y arrancar antes dejaria una ventana en la
        // que un vencimiento correria sin esa red.
        false,
        node.config.timeZone,
      );
    } catch (error) {
      this.logger.warn(
        `El nodo CRON del flujo "${node.flowId}" no se pudo programar con "${node.config.cronExpression}" (${node.config.timeZone}): ${error instanceof Error ? error.message : String(error)}`,
      );
      this.scheduled.delete(node.flowId);
      return;
    }

    this.schedulerRegistry.addCronJob(name, job);

    // `addCronJob` inscribe pero NO arranca; sin esto el job no vence nunca.
    job.start();

    this.scheduled.set(node.flowId, node.config);
  }

  /**
   * Despacha un flujo al vencer su programacion.
   *
   * Publico para poder forzar un disparo bajo demanda y para que las pruebas no
   * dependan de avanzar el reloj hasta el proximo vencimiento.
   *
   * @returns `true` si se disparo el flujo; `false` si se omitio o fue rechazado.
   */
  public async runScheduledFlow(flowId: string): Promise<boolean> {
    if (this.inFlight.has(flowId)) {
      this.logger.warn(
        `El disparo anterior del flujo "${flowId}" sigue en curso; se omite este vencimiento.`,
      );
      return false;
    }

    this.inFlight.add(flowId);

    try {
      return await this.dispatchFlow(flowId);
    } catch (error) {
      // Nunca se propaga: esto corre dentro del callback de un `CronJob`, y una
      // excepcion escapando de ahi terminaria el proceso de Node. Se registra
      // con el stack porque este es el punto donde el disparador falla en
      // silencio —el flujo no arranca y nadie se entera—.
      this.logger.error(
        `[Worker] Fallo critico al disparar el flujo programado "${flowId}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    } finally {
      this.inFlight.delete(flowId);
    }
  }

  /** Lanza la ejecucion automatica y traduce los rechazos esperados del motor. */
  private async dispatchFlow(flowId: string): Promise<boolean> {
    try {
      const executionId =
        await this.workflowsService.runAutomaticWorkflow(flowId);

      this.logger.log(
        `Vencimiento CRON del flujo "${flowId}" | ejecucion=${executionId}`,
      );
      return true;
    } catch (error) {
      // El 409 de RNF-09 no es una averia: el flujo ya tiene una instancia
      // EN_PROCESO, normalmente la del vencimiento anterior. Se pierde ESTE
      // disparo —a diferencia del sondeo IMAP, donde el correo sin leer sigue
      // ahi para el siguiente ciclo—, pero fallar aqui llenaria la traza de
      // alertas por un solapamiento que la propia expresion cron provoca.
      if (error instanceof ConflictException) {
        this.logger.warn(
          `El flujo "${flowId}" ya tiene una ejecucion EN_PROCESO; se omite este vencimiento.`,
        );
        return false;
      }

      // Cualquier otro rechazo DEL MOTOR tampoco es una averia de este servicio.
      // El caso que lo motiva: un vencimiento que ya estaba en vuelo cuando
      // alguien desactivo el flujo llega aqui y `runAutomaticWorkflow` lo
      // rechaza con un 400. Se conserva el mensaje real porque por esta misma
      // via llega tambien el esquema corrupto, que si debe quedar legible.
      if (error instanceof HttpException) {
        this.logger.warn(
          `El motor rechazo el despacho programado del flujo "${flowId}": ${error.message}`,
        );
        return false;
      }

      throw error;
    }
  }

  /** Flujos habilitados que declaran un nodo TRIGGER_CRON con parametros validos. */
  private async findCronTriggerNodes(): Promise<CronTriggerNode[]> {
    const workflows = await this.workflowRepository.find({
      where: { active: true },
    });

    const nodes: CronTriggerNode[] = [];

    for (const workflow of workflows) {
      const config = await this.extractCronConfig(workflow);

      if (config !== null) {
        nodes.push({ flowId: workflow.id, config });
      }
    }

    return nodes;
  }

  /**
   * Resuelve el nodo de ENTRADA del flujo y valida sus `params` como CRON.
   *
   * Mira exclusivamente `schema.nodes[schema.entrypoint]`, igual que su gemelo
   * `ImapPollingService.extractImapConfig` y por los mismos motivos: buscar por
   * tipo programaba flujos cuyo nodo Cron era intermedio y por tanto nunca
   * arrancaba el recorrido, elegia uno no determinista si habia dos, y dejaba
   * que un flujo con un nodo Cron y otro IMAP fuese programado por los DOS
   * servicios de sondeo a la vez.
   *
   * Quien decide que dispara un flujo es el `entrypoint`, que es lo que el motor
   * usa para arrancar el cursor.
   *
   * Devuelve `null` —y no lanza— cuando el flujo no arranca por un nodo CRON o
   * su configuracion es invalida: un esquema a medio escribir no debe impedir
   * que el resto de los flujos queden programados al arrancar la aplicacion.
   */
  private async extractCronConfig(
    workflow: Workflow,
  ): Promise<ResolvedCronTriggerConfig | null> {
    const schema = workflow.pipelineSchema;

    // En `debug` y no en `warn`: un flujo sin nodo CRON simplemente no se
    // dispara por tiempo, y eso no es ningun error. Pero se registra, porque sin
    // esta linea un flujo activo se quedaba fuera sin dejar rastro alguno.
    if (schema === null) {
      this.logger.debug(
        `El flujo "${workflow.id}" esta activo pero no tiene configuracion_pipeline: no se programa.`,
      );
      return null;
    }

    const entryNode = schema.nodes?.[schema.entrypoint];

    if (entryNode?.nodeType !== NodeType.TRIGGER_CRON) {
      // Un nodo CRON que existe pero NO es el punto de entrada nunca llegara a
      // disparar nada: el motor arranca el cursor en otro sitio. `warn` porque
      // antes SI se programaba, y sin el aviso el flujo dejaria de ejecutarse
      // sin que nada lo explique.
      const hasOrphanTrigger = Object.values(schema.nodes ?? {}).some(
        (node) => node.nodeType === NodeType.TRIGGER_CRON,
      );

      if (hasOrphanTrigger) {
        this.logger.warn(
          `El flujo "${workflow.id}" declara un nodo ${NodeType.TRIGGER_CRON} que NO es su entrypoint ("${schema.entrypoint}"): no se programa. Reordena el flujo para que el disparador sea el primer paso.`,
        );

        return null;
      }

      // Sin nodo CRON en ninguna parte no hay nada que advertir: un flujo IMAP
      // pasando por aqui es el caso NORMAL.
      this.logger.debug(
        `El flujo "${workflow.id}" no arranca por un nodo ${NodeType.TRIGGER_CRON}: no se programa.`,
      );

      return null;
    }

    const dto = plainToInstance(CronTriggerConfigDto, entryNode.params);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      this.logger.warn(
        `El nodo CRON del flujo "${workflow.id}" tiene parametros invalidos y no se programara: [${errors.map((error) => error.property).join(', ')}].`,
      );
      return null;
    }

    return resolveCronConfig(dto);
  }

  /**
   * Inscribe la reconciliacion periodica.
   *
   * Como INTERVALO y no como `CronJob`: asi el barrido de `clearSchedules`, que
   * recorre los cron jobs por prefijo, no puede cancelar por accidente el propio
   * mecanismo que lo repara.
   */
  private registerReconcileInterval(): void {
    this.deleteIntervalIfExists(RECONCILE_INTERVAL_NAME);

    const periodMs =
      Number(this.configService.get<string>(RECONCILE_INTERVAL_KEY)) ||
      DEFAULT_RECONCILE_INTERVAL_MS;

    const interval = setInterval(() => {
      // `refreshSchedules` puede rechazar si PostgreSQL no responde, y esto
      // corre dentro de un `setInterval`: sin el `catch`, la promesa sin manejar
      // terminaria el proceso.
      void this.refreshSchedules().catch((error: unknown) => {
        this.logger.warn(
          `Fallo la reconciliacion de la planificacion CRON: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, periodMs);

    this.schedulerRegistry.addInterval(RECONCILE_INTERVAL_NAME, interval);
    this.logger.log(
      `Reconciliacion de la planificacion CRON cada ${periodMs} ms; los flujos nuevos se recogeran en el siguiente ciclo.`,
    );
  }

  /** Borra un cron job solo si esta inscrito: `deleteCronJob` lanza si no. */
  private deleteCronJobIfExists(name: string): void {
    if (this.schedulerRegistry.doesExist('cron', name)) {
      this.schedulerRegistry.deleteCronJob(name);
    }
  }

  /** Borra un intervalo solo si esta inscrito: `deleteInterval` lanza si no. */
  private deleteIntervalIfExists(name: string): void {
    if (this.schedulerRegistry.doesExist('interval', name)) {
      this.schedulerRegistry.deleteInterval(name);
    }
  }

  /**
   * Borra todos los cron jobs que este servicio tenga inscritos.
   *
   * El filtro por prefijo no es cosmetico: `SchedulerRegistry` es compartido con
   * `ImapPollingService`, y un barrido sin filtrar dejaria los buzones sin
   * sondear cada vez que este modulo se destruye.
   */
  private clearSchedules(): void {
    for (const name of this.schedulerRegistry.getCronJobs().keys()) {
      if (name.startsWith(`${CRON_JOB_PREFIX}:`)) {
        this.schedulerRegistry.deleteCronJob(name);
      }
    }

    // Sin esto, el registro paralelo afirmaria que hay flujos programados cuyos
    // temporizadores ya no existen, y la siguiente reconciliacion los daria por
    // intactos y no volveria a inscribirlos.
    this.scheduled.clear();
  }
}
