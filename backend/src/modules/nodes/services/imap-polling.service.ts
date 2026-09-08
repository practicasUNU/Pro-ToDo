import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ImapFlow } from 'imapflow';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  ImapTriggerConfigDto,
  resolveImapConfig,
} from '@modules/nodes/dto/imap-trigger-config.dto';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsService } from '@modules/workflows/workflows.service';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { Repository } from 'typeorm';

/** Prefijo de los intervalos que este servicio inscribe en `SchedulerRegistry`. */
const INTERVAL_PREFIX = 'imap-poll';

/**
 * Variable que habilita el sondeo automatico.
 *
 * Se exige el valor exacto `'true'` (y no `!== 'false'`) para que el fallo por
 * omision sea "no sondea". Arrancar el backend en un portatil de desarrollo NO
 * debe consumir el buzon real: la estrategia marca `\Seen` y los correos se
 * perderian para el entorno que si toca procesarlos.
 */
const POLLING_ENABLED_KEY = 'IMAP_POLLING_ENABLED';

/** Espera maxima para conectar y para el saludo del servidor, en el sondeo. */
const PROBE_TIMEOUT_MS = 15_000;

/** Nombre del intervalo de un flujo concreto. */
const intervalName = (flowId: string): string => `${INTERVAL_PREFIX}:${flowId}`;

/**
 * Nodo IMAP encontrado dentro del `pipeline_schema` de un flujo.
 *
 * Se guarda la configuracion ya resuelta para no revalidarla en cada tick.
 */
interface ImapTriggerNode {
  readonly flowId: string;
  readonly config: ResolvedImapConfig;
}

/**
 * Sondeo periodico de los buzones declarados por los nodos TRIGGER_IMAP.
 *
 * REPARTO DE RESPONSABILIDADES (un solo lector del buzon): este servicio solo
 * DETECTA. Pregunta al servidor cuantos mensajes sin leer hay (`STATUS`, que no
 * abre el buzon ni descarga nada ni toca banderas) y, si hay alguno, dispara el
 * flujo. El correo lo descarga, parsea y marca como leido `ImapTriggerStrategy`
 * ya dentro del pipeline.
 *
 * Si el sondeo leyera el mensaje, habria dos rutas compitiendo por marcar
 * `\Seen` y el nodo del pipeline encontraria el buzon vacio justo despues de que
 * el sondeo lo hubiera vaciado.
 *
 * Se usan intervalos dinamicos de `SchedulerRegistry` y NO el decorador `@Cron`:
 * `pollIntervalMs` es un parametro POR NODO, y un decorador se evalua una sola
 * vez en tiempo de clase, sin posibilidad de un periodo distinto por flujo.
 *
 * DEUDA TECNICA DECLARADA: `architecture-patterns.md` §5 pide que la ingesta
 * disparada por Cron/IMAP viaje por una cola de BullMQ. Aqui el disparo es en
 * proceso —bloquea el temporizador, nunca el hilo de peticiones HTTP— porque el
 * despliegue todavia no tiene Redis. El salto a la cola consiste en sustituir el
 * cuerpo de `dispatchFlow`, que es el unico punto que conoce el motor.
 */
@Injectable()
export class ImapPollingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImapPollingService.name);

  /**
   * Flujos con un tick en vuelo.
   *
   * Sin esta guarda, un sondeo mas lento que su propio `pollIntervalMs` se
   * solaparia consigo mismo y abriria conexiones IMAP en cascada contra el mismo
   * buzon.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly workflowsService: WorkflowsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {}

  public async onModuleInit(): Promise<void> {
    if (this.configService.get<string>(POLLING_ENABLED_KEY) !== 'true') {
      this.logger.warn(
        `Sondeo IMAP deshabilitado (${POLLING_ENABLED_KEY} != "true"): no se programara ningun buzon.`,
      );
      return;
    }

    // No relanza: no poder programar el sondeo es una degradacion, no un motivo
    // para impedir que la API arranque. `refreshSchedules` es invocable despues.
    try {
      await this.refreshSchedules();
    } catch (error) {
      this.logger.error(
        `No se pudo programar el sondeo IMAP al arrancar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  public onModuleDestroy(): void {
    this.clearSchedules();
  }

  /**
   * Recarga los intervalos a partir del estado actual de la tabla `flujos`.
   *
   * Publico y no solo interno: el `pipeline_schema` de un flujo puede cambiar en
   * caliente desde el asistente, y sin una recarga el sondeo seguiria usando el
   * host, el buzon o el periodo antiguos hasta el siguiente reinicio.
   */
  public async refreshSchedules(): Promise<void> {
    this.clearSchedules();

    const nodes = await this.findImapTriggerNodes();

    for (const node of nodes) {
      this.registerInterval(node);
    }

    this.logger.log(
      `Sondeo IMAP activo para ${nodes.length} flujo(s): [${nodes.map((node) => node.flowId).join(', ')}].`,
    );
  }

  /**
   * Comprueba el buzon de un flujo y lo dispara si hay correo sin leer.
   *
   * Es el metodo publico del servicio: lo invoca el temporizador y sirve tambien
   * para un disparo manual bajo demanda.
   *
   * @param flowId Flujo al que pertenece el nodo IMAP.
   * @param config Parametros del nodo. Se admite el DTO sin resolver para poder
   *        llamarlo con los `params` crudos del esquema.
   * @returns `true` si se disparo el flujo; `false` si el buzon estaba vacio o el
   *          sondeo no pudo completarse.
   */
  public async pollInbox(
    flowId: string,
    config: ImapTriggerConfigDto | ResolvedImapConfig,
  ): Promise<boolean> {
    // Guarda de reentrada: el tick anterior de este mismo flujo sigue vivo.
    if (this.inFlight.has(flowId)) {
      this.logger.warn(
        `El sondeo del flujo "${flowId}" todavia esta en curso; se omite este ciclo.`,
      );
      return false;
    }

    this.inFlight.add(flowId);

    try {
      const resolved = resolveImapConfig(config);
      const hasUnseen = await this.hasUnseenMessages(resolved);

      if (!hasUnseen) {
        return false;
      }

      return await this.dispatchFlow(flowId);
    } catch (error) {
      // Un fallo de sondeo NUNCA se propaga: este metodo corre dentro del
      // callback de un `setInterval`, y una excepcion escapando de ahi termina
      // el proceso de Node entero.
      this.logger.warn(
        `Fallo el sondeo IMAP del flujo "${flowId}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      this.inFlight.delete(flowId);
    }
  }

  /**
   * Pregunta al servidor si el buzon tiene mensajes sin leer.
   *
   * Usa `STATUS` en vez de `SEARCH`: no requiere seleccionar el buzon, no
   * descarga cuerpos y no altera ninguna bandera. Es la consulta mas barata que
   * responde a la unica pregunta que le importa al sondeo.
   */
  private async hasUnseenMessages(
    config: ResolvedImapConfig,
  ): Promise<boolean> {
    const password = this.configService.get<string>(config.passwordEnvKey);

    if (typeof password !== 'string' || password === '') {
      this.logger.warn(
        `La variable "${config.passwordEnvKey}" no esta definida: no se puede sondear ${config.host}.`,
      );
      return false;
    }

    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: password },
      // Sin logger: imapflow volcaria la conversacion IMAP completa al stdout.
      logger: false,
      emitLogs: false,
      disableAutoIdle: true,
      connectionTimeout: PROBE_TIMEOUT_MS,
      greetingTimeout: PROBE_TIMEOUT_MS,
      socketTimeout: PROBE_TIMEOUT_MS,
    });

    // OBLIGATORIO: un evento 'error' sin oyente en este EventEmitter es una
    // excepcion no capturada que tumba el proceso de Node.
    client.on('error', (error: Error) => {
      this.logger.warn(
        `Error de socket IMAP durante el sondeo de ${config.host}: ${error.message}`,
      );
    });

    try {
      await client.connect();
      const status = await client.status(config.mailbox, { unseen: true });

      return (status.unseen ?? 0) > 0;
    } finally {
      await this.logoutQuietly(client);
    }
  }

  /**
   * Arranca el flujo por el motor FSM.
   *
   * Unico punto que conoce el despacho: sustituir este cuerpo por un `queue.add`
   * es todo lo que hace falta para pasar a BullMQ.
   */
  private async dispatchFlow(flowId: string): Promise<boolean> {
    try {
      const executionId =
        await this.workflowsService.runAutomaticWorkflow(flowId);

      this.logger.log(
        `Correo nuevo detectado en el flujo "${flowId}" | ejecucion=${executionId}`,
      );
      return true;
    } catch (error) {
      // El 409 de RNF-09 es la condicion NORMAL del sondeo, no una averia: el
      // flujo ya tiene una instancia EN_PROCESO. El correo sigue sin leer porque
      // nadie lo ha consumido, asi que el siguiente ciclo lo recogera. Fallar
      // aqui llenaria la traza de alertas por un solapamiento esperado.
      if (error instanceof ConflictException) {
        this.logger.warn(
          `El flujo "${flowId}" ya tiene una ejecucion EN_PROCESO; el correo queda para el siguiente ciclo.`,
        );
        return false;
      }

      throw error;
    }
  }

  /**
   * Flujos habilitados que declaran un nodo TRIGGER_IMAP con parametros validos.
   *
   * El filtro por `activo` se aplica AQUI y no en `WorkflowsService`: esa columna
   * gobierna los disparadores automaticos, mientras que el despacho manual la
   * ignora a proposito (ver el TSDoc de `Workflow.active`).
   */
  private async findImapTriggerNodes(): Promise<ImapTriggerNode[]> {
    const workflows = await this.workflowRepository.find({
      where: { active: true },
    });
    const nodes: ImapTriggerNode[] = [];

    for (const workflow of workflows) {
      const config = await this.extractImapConfig(workflow);

      if (config !== null) {
        nodes.push({ flowId: workflow.id, config });
      }
    }

    return nodes;
  }

  /**
   * Localiza el nodo TRIGGER_IMAP de un flujo y valida sus `params`.
   *
   * Devuelve `null` —y no lanza— cuando el flujo no tiene ese nodo o su
   * configuracion es invalida: un esquema a medio escribir no debe impedir que
   * el resto de los flujos queden programados al arrancar la aplicacion.
   */
  private async extractImapConfig(
    workflow: Workflow,
  ): Promise<ResolvedImapConfig | null> {
    const schema = workflow.pipelineSchema;

    if (schema === null) {
      return null;
    }

    const imapNode = Object.values(schema.nodes ?? {}).find(
      (node) => node.nodeType === NodeType.TRIGGER_IMAP,
    );

    if (imapNode === undefined) {
      return null;
    }

    const dto = plainToInstance(ImapTriggerConfigDto, imapNode.params);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    if (errors.length > 0) {
      this.logger.warn(
        `El nodo IMAP del flujo "${workflow.id}" tiene parametros invalidos y no se programara: [${errors.map((error) => error.property).join(', ')}].`,
      );
      return null;
    }

    return resolveImapConfig(dto);
  }

  /** Inscribe el intervalo de un flujo con su propio periodo. */
  private registerInterval(node: ImapTriggerNode): void {
    const name = intervalName(node.flowId);

    // `addInterval` LANZA si el nombre ya esta tomado, asi que se borra primero
    // (el borrado hace el `clearInterval` por dentro).
    if (this.schedulerRegistry.doesExist('interval', name)) {
      this.schedulerRegistry.deleteInterval(name);
    }

    // `void`: el callback de `setInterval` es sincrono y no puede esperar la
    // promesa. Y `addInterval` NO envuelve el callback en try/catch, asi que
    // `pollInbox` tiene la obligacion de no rechazar nunca: una promesa
    // rechazada sin manejar termina el proceso en Node >= 18.
    const interval = setInterval(() => {
      void this.pollInbox(node.flowId, node.config);
    }, node.config.pollIntervalMs);

    this.schedulerRegistry.addInterval(name, interval);
  }

  /**
   * Borra todos los intervalos que este servicio tenga inscritos.
   *
   * Imprescindible en `onModuleDestroy`: sin esto, cada recarga del `--watch` de
   * Nest dejaria vivos los temporizadores de la instancia anterior y el mismo
   * buzon se sondearia varias veces por ciclo.
   */
  private clearSchedules(): void {
    for (const name of this.schedulerRegistry.getIntervals()) {
      if (name.startsWith(`${INTERVAL_PREFIX}:`)) {
        this.schedulerRegistry.deleteInterval(name);
      }
    }
  }

  /** Cierra la sesion IMAP sin dejar escapar errores de cierre. */
  private async logoutQuietly(client: ImapFlow): Promise<void> {
    try {
      await client.logout();
    } catch (error) {
      this.logger.warn(
        `No se pudo cerrar la sesion IMAP del sondeo: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
