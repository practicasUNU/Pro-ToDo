import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
// Import de VALOR y no `import type`: `ConfigService` se inyecta por constructor, y
// con `emitDecoratorMetadata` un `import type` se borra al transpilar, dejando
// `design:paramtypes` en `Object`. Nest no podria resolver la dependencia.
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import {
  DEFAULT_POLL_INTERVAL_MS,
  ImapTriggerConfigDto,
  MIN_POLL_INTERVAL_MS,
  resolveImapConfig,
} from '@modules/nodes/dto/imap-trigger-config.dto';
import { createImapClient } from '@modules/nodes/services/imap-client.factory';
import { buildImapSearchQuery } from '@modules/nodes/strategies/imap-trigger.strategy';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsService } from '@modules/workflows/workflows.service';

import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ResolvedImapConfig } from '@modules/nodes/dto/imap-trigger-config.dto';
import type { ImapFlow, MailboxLockObject } from 'imapflow';
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

/**
 * Nombre del intervalo de reconciliacion.
 *
 * No lleva el prefijo de los intervalos por flujo a proposito: `clearSchedules`
 * borra solo `imap-poll:*`, asi que una recarga de la tabla no se cancela a si
 * misma a mitad de ejecucion.
 */
const RECONCILE_INTERVAL_NAME = 'imap-reconcile';

/** Cada cuanto se rearma la tabla de intervalos contra `flujos`. */
const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/** Variable que permite ajustar el periodo de reconciliacion. */
const RECONCILE_INTERVAL_KEY = 'IMAP_RECONCILE_INTERVAL_MS';

/**
 * Variable con el periodo de sondeo POR DEFECTO.
 *
 * Es el valor de reserva para los nodos que NO declaran `pollIntervalMs` en su
 * `pipeline_schema`, no un techo global: el periodo sigue siendo un parametro por
 * nodo, y un flujo que lo fije manda sobre esta variable. Permite mover de golpe
 * el ritmo de todos los buzones que no lo hayan fijado sin editar cada esquema.
 */
const POLLING_INTERVAL_KEY = 'IMAP_POLLING_INTERVAL_MS';

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

  /**
   * Configuracion con la que cada flujo quedo programado, indexada por `flowId`.
   *
   * `SchedulerRegistry` solo guarda el `Timeout`, no CON QUE se creo, asi que sin
   * este registro paralelo la reconciliacion no puede distinguir "este flujo ya
   * esta programado igual" de "esta programado con el buzon antiguo". Es lo que
   * hace posible el diffing de `refreshSchedules`.
   */
  private readonly scheduled = new Map<string, ResolvedImapConfig>();

  /**
   * Periodo de sondeo por defecto, resuelto UNA vez al arrancar.
   *
   * Se cachea en un campo en lugar de leer `ConfigService` en cada
   * `extractImapConfig`: el valor no cambia en caliente y la reconciliacion
   * recorre todos los flujos en cada ciclo.
   */
  private defaultPollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly workflowsService: WorkflowsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
    private readonly flowPollingCoordinator: FlowPollingCoordinator,
  ) {}

  public async onModuleInit(): Promise<void> {
    this.defaultPollIntervalMs = this.resolveDefaultPollInterval();

    if (this.configService.get<string>(POLLING_ENABLED_KEY) !== 'true') {
      this.logger.warn(
        `Sondeo IMAP deshabilitado (${POLLING_ENABLED_KEY} != "true"): no se programara ningun buzon.`,
      );
      return;
    }

    // El registro va DESPUES de la guarda, no antes: si el sondeo esta
    // deshabilitado no hay nada que parar, y sobre todo no debe poder
    // reconciliarse desde fuera. Un `refreshPolling()` disparado por la
    // activacion de un flujo empezaria a inscribir temporizadores que ningun
    // ciclo de reconciliacion mantiene, saltandose la decision de que el fallo
    // por omision sea NO sondear.
    this.flowPollingCoordinator.register({
      stopPollingForFlow: (flowId: string) => this.stopPollingForFlow(flowId),
      refreshPolling: () => this.refreshSchedules(),
    });

    // No relanza: no poder programar el sondeo es una degradacion, no un motivo
    // para impedir que la API arranque. La reconciliacion periodica que se
    // registra debajo lo reintentara por su cuenta.
    try {
      await this.refreshSchedules();
    } catch (error) {
      this.logger.error(
        `No se pudo programar el sondeo IMAP al arrancar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.registerReconcileInterval();
  }

  public onModuleDestroy(): void {
    this.clearSchedules();
    this.deleteIntervalIfExists(RECONCILE_INTERVAL_NAME);

    // El coordinador vive en `CommonModule`, que es global y sobrevive a este
    // servicio. Sin esta baja, una recarga del `--watch` dejaria al dominio
    // hablando con la instancia muerta —cuyo `scheduled` esta vacio, asi que
    // toda parada seria un no-op silencioso— mientras la nueva no recibe nada.
    this.flowPollingCoordinator.unregister();
  }

  /**
   * Lee `IMAP_POLLING_INTERVAL_MS` y lo valida contra el suelo del DTO.
   *
   * Se rechaza —y se cae al valor por defecto— todo lo que no sea un entero por
   * encima de `MIN_POLL_INTERVAL_MS`. La razon no es purismo: un `0` o un valor
   * de dos digitos escrito por error en el `.env` martillearia el servidor IMAP
   * hasta que el proveedor cortase la cuenta por exceso de tasa, y eso ocurriria
   * en silencio. El DTO ya impone ese mismo suelo a los nodos que declaran su
   * periodo; la variable de entorno no puede ser la puerta trasera que lo evita.
   */
  private resolveDefaultPollInterval(): number {
    const raw = this.configService.get<string>(POLLING_INTERVAL_KEY);

    if (raw === undefined || raw === '') {
      return DEFAULT_POLL_INTERVAL_MS;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < MIN_POLL_INTERVAL_MS) {
      this.logger.warn(
        `${POLLING_INTERVAL_KEY}="${raw}" no es un entero valido de al menos ${MIN_POLL_INTERVAL_MS} ms; se usara ${DEFAULT_POLL_INTERVAL_MS} ms.`,
      );
      return DEFAULT_POLL_INTERVAL_MS;
    }

    return parsed;
  }

  /**
   * Destruye el temporizador de un flujo AHORA, sin esperar a la reconciliacion.
   *
   * El diffing de `refreshSchedules` ya retira los intervalos de los flujos
   * desactivados, pero solo en su siguiente ciclo: hasta un minuto entero
   * abriendo conexiones IMAP contra el buzon de un flujo que ya nadie deberia
   * disparar. Este es el camino rapido para el caso en que sabemos, en el
   * instante exacto, que un flujo deja de estar operativo.
   *
   * NO sustituye a la reconciliacion, que sigue siendo la red de seguridad: un
   * `activo` cambiado por SQL directo o una fila borrada a mano no pasan por
   * aqui.
   *
   * Idempotente: parar un flujo que no estaba programado no es un error, y de
   * hecho es el caso normal cuando se desactiva un flujo sin nodo IMAP.
   */
  public stopPollingForFlow(flowId: string): void {
    const name = intervalName(flowId);

    try {
      this.deleteIntervalIfExists(name);
    } finally {
      // En el `finally` a proposito. El Map es la FUENTE DE VERDAD del diffing,
      // y dejarlo sucio es peor que un intervalo huerfano: al reactivar el flujo
      // antes del siguiente ciclo, la fase de altas lo veria "ya programado e
      // intacto" y no volveria a inscribirlo nunca.
      this.scheduled.delete(flowId);
    }

    // A nivel `log` y no `debug`: sin esta linea el camino rapido es invisible
    // —la siguiente reconciliacion reportara `bajas=0` porque el Map ya esta
    // limpio— mientras que el lento es verboso, y en mitad de un incidente esa
    // asimetria cuesta cara.
    this.logger.log(
      `Sondeo IMAP detenido bajo demanda para el flujo "${flowId}".`,
    );
  }

  /**
   * Reconcilia los intervalos con el estado actual de la tabla `flujos`.
   *
   * Publico y no solo interno: el `pipeline_schema` de un flujo puede cambiar en
   * caliente desde el asistente, y sin una recarga el sondeo seguiria usando el
   * host, el buzon o el periodo antiguos hasta el siguiente reinicio.
   *
   * DIFFING, y no barrido y recreacion. Antes este metodo borraba TODOS los
   * intervalos y los volvia a crear en cada ciclo, lo que provocaba INANICION:
   * un flujo con `pollIntervalMs` mayor que el periodo de reconciliacion veia su
   * temporizador destruido y recreado desde cero antes de llegar a cumplirse, de
   * modo que no sondeaba NUNCA. Con los valores por defecto (sondeo 60 s,
   * reconciliacion 60 s) la carrera se decidia por milisegundos.
   *
   * Ahora un flujo cuya configuracion no ha cambiado conserva su temporizador
   * intacto, y solo se tocan las altas, las bajas y los cambios reales.
   */
  public async refreshSchedules(): Promise<void> {
    this.logger.debug('Sondeo IMAP disparado. Buscando flujos activos...');

    const nodes = await this.findImapTriggerNodes();

    this.logger.debug(`Flujos IMAP activos encontrados: ${nodes.length}`);

    const desired = new Map<string, ResolvedImapConfig>(
      nodes.map((node) => [node.flowId, node.config]),
    );

    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    // 1. Bajas: programados que la base de datos ya no devuelve. Cubre tanto el
    //    flujo desactivado como el borrado o el que perdio su nodo IMAP.
    for (const flowId of [...this.scheduled.keys()]) {
      if (!desired.has(flowId)) {
        this.deleteIntervalIfExists(intervalName(flowId));
        this.scheduled.delete(flowId);
        removed.push(flowId);
      }
    }

    // 2. Altas y cambios. Un flujo intacto NO se toca: ese es el punto entero.
    for (const [flowId, config] of desired) {
      const current = this.scheduled.get(flowId);

      // La segunda condicion repara la invariante "esta en `scheduled` <=>
      // existe su intervalo" en vez de darla por supuesta. Desde que
      // `stopPollingForFlow` es un segundo escritor del par, darla por buena
      // dejaria un flujo activo y mudo si alguna vez se desincronizan.
      if (
        current === undefined ||
        !this.schedulerRegistry.doesExist('interval', intervalName(flowId))
      ) {
        this.registerInterval({ flowId, config });
        added.push(flowId);
        continue;
      }

      if (this.hasConfigChanged(current, config)) {
        this.registerInterval({ flowId, config });
        updated.push(flowId);
      }
    }

    this.logger.log(
      `Sondeo IMAP reconciliado: ${this.scheduled.size} flujo(s) programados | altas=${added.length} bajas=${removed.length} cambios=${updated.length} intactos=${this.scheduled.size - added.length - updated.length}.`,
    );
  }

  /**
   * Compara dos configuraciones ya resueltas del mismo flujo.
   *
   * Se comparan TODOS los campos y no solo `pollIntervalMs`: el callback del
   * temporizador captura la configuracion en su clausura, asi que un cambio de
   * buzon o de filtro tambien exige reinscribirlo para que el worker deje de
   * usar el valor viejo.
   *
   * `JSON.stringify` basta porque `ResolvedImapConfig` es un objeto plano de
   * primitivas y `null`, construido siempre por el mismo literal de
   * `resolveImapConfig`: el orden de las claves es estable por construccion.
   */
  private hasConfigChanged(
    current: ResolvedImapConfig,
    next: ResolvedImapConfig,
  ): boolean {
    return JSON.stringify(current) !== JSON.stringify(next);
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
      const hasMatch = await this.hasMatchingMessages(resolved);

      if (!hasMatch) {
        return false;
      }

      return await this.dispatchFlow(flowId);
    } catch (error) {
      // Un fallo de sondeo NUNCA se propaga: este metodo corre dentro del
      // callback de un `setInterval`, y una excepcion escapando de ahi termina
      // el proceso de Node entero.
      //
      // Se registra con el STACK como segundo argumento, y no solo el mensaje:
      // este es el punto donde el disparador falla en silencio (el flujo no
      // arranca y nadie se entera), asi que sin la traza no hay forma de
      // distinguir un buzon caido de unas credenciales caducadas o de un error
      // de programacion en la resolucion de la configuracion.
      this.logger.error(
        `[Worker] Falla critica de conexion IMAP en el flujo "${flowId}": ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    } finally {
      this.inFlight.delete(flowId);
    }
  }

  /**
   * Pregunta al servidor si el buzon tiene algun mensaje que case con el nodo.
   *
   * Usa `SEARCH` con la MISMA consulta que la estrategia
   * (`buildImapSearchQuery`), y no el `STATUS` mas barato que usaba antes. Con
   * filtros de remitente o asunto, `STATUS unseen` respondia por cualquier
   * correo no leido: el flujo arrancaba, la estrategia no encontraba
   * coincidencia y la ejecucion moria en el mapeador sin datos. Detectar y
   * extraer tienen que compartir criterio o el sondeo miente.
   *
   * El precio es seleccionar el buzon (`SEARCH` lo exige y `STATUS` no), asi que
   * se toma el lock y se libera en el `finally`. Se sigue sin descargar cuerpos
   * y sin tocar ninguna bandera: eso es trabajo de la estrategia.
   */
  private async hasMatchingMessages(
    config: ResolvedImapConfig,
  ): Promise<boolean> {
    const password = this.configService.get<string>(config.passwordEnvKey);

    if (typeof password !== 'string' || password === '') {
      this.logger.warn(
        `La variable "${config.passwordEnvKey}" no esta definida: no se puede sondear ${config.host}.`,
      );
      return false;
    }

    const client = createImapClient(config, password, (error: Error) => {
      this.logger.warn(
        `Error de socket IMAP durante el sondeo de ${config.host}: ${error.message}`,
      );
    });

    let lock: MailboxLockObject | undefined;
    const searchQuery = buildImapSearchQuery(config);

    try {
      // Antes de `connect()` y no despues: si el saludo TLS se cuelga, esta es
      // la ultima linea que queda en el registro, y con host, puerto y usuario
      // basta para distinguir un cortafuegos de unas credenciales rechazadas.
      this.logger.debug(
        `[Worker] Negociando TLS con ${config.host}:${config.port} para ${config.user}...`,
      );

      await client.connect();
      lock = await client.getMailboxLock(config.mailbox);

      // La consulta se registra ENTERA: un filtro mal escrito en el asistente no
      // produce ningun error, solo un buzon que "nunca tiene correo". Ver la
      // query es lo unico que distingue ese caso de una bandeja realmente vacia.
      this.logger.debug(
        `Ejecutando SEARCH en buzon con query: ${JSON.stringify(searchQuery)}`,
      );

      const uids = await client.search(searchQuery, {
        uid: true,
      });

      return uids !== false && Array.isArray(uids) && uids.length > 0;
    } finally {
      this.releaseQuietly(lock);
      await this.logoutQuietly(client);
    }
  }

  /** Libera el lock del buzon sin dejar que su fallo tape el error original. */
  private releaseQuietly(lock: MailboxLockObject | undefined): void {
    if (lock === undefined) {
      return;
    }

    try {
      lock.release();
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo liberar el buzon tras el sondeo: ${error instanceof Error ? error.message : String(error)}`,
      );
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

      // Cualquier otro rechazo DEL MOTOR tampoco es una averia de este servicio.
      // El caso que lo motiva: un tick que ya estaba en vuelo cuando alguien
      // desactivo el flujo llega aqui y `runAutomaticWorkflow` lo rechaza con un
      // 400. Sin esta rama, `pollInbox` lo registraria como "falla critica de
      // conexion IMAP" —a nivel `error` y con stack—, acusando al buzon de algo
      // que no ha pasado.
      //
      // Se conserva el MENSAJE REAL en vez de uno generico: por esta misma via
      // llega tambien el esquema corrupto, y ese si tiene que quedar legible en
      // la traza aunque deje de disfrazarse de caida IMAP.
      if (error instanceof HttpException) {
        this.logger.warn(
          `El motor rechazo el despacho del flujo "${flowId}": ${error.message}`,
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

    // Se registran los dos recuentos por separado a proposito: la diferencia
    // entre ellos es el diagnostico. "5 activos, 0 sondeables" apunta al esquema
    // de los flujos; "0 activos" apunta a que nadie los ha habilitado todavia,
    // que es un problema distinto y en otra pantalla.
    this.logger.debug(
      `Flujos activos en base de datos: ${workflows.length} (los inactivos no se sondean).`,
    );

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

    // Los dos descartes de abajo eran las fugas silenciosas del servicio: un
    // flujo activo se quedaba fuera del sondeo sin dejar rastro, y desde fuera
    // era indistinguible de un buzon vacio. Van en `debug` y no en `warn` porque
    // ninguno de los dos casos es un error: un flujo sin nodo IMAP simplemente
    // no se dispara por correo.
    if (schema === null) {
      this.logger.debug(
        `El flujo "${workflow.id}" esta activo pero no tiene configuracion_pipeline: no se sondea.`,
      );
      return null;
    }

    const imapNode = Object.values(schema.nodes ?? {}).find(
      (node) => node.nodeType === NodeType.TRIGGER_IMAP,
    );

    if (imapNode === undefined) {
      this.logger.debug(
        `El flujo "${workflow.id}" no declara ningun nodo ${NodeType.TRIGGER_IMAP}: no se sondea.`,
      );
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

    const resolved = resolveImapConfig(dto);

    // El default del DTO es un literal de modulo; el de la instalacion vive en
    // `IMAP_POLLING_INTERVAL_MS`. Solo se sustituye cuando el NODO no fijo el
    // suyo: un `pollIntervalMs` explicito en el esquema manda siempre, porque el
    // periodo es un parametro por nodo y no una politica global.
    if (dto.pollIntervalMs === undefined) {
      return { ...resolved, pollIntervalMs: this.defaultPollIntervalMs };
    }

    return resolved;
  }

  /**
   * Inscribe (o reinscribe) el intervalo de un flujo con su propio periodo.
   *
   * Solo debe llamarse desde el diffing de `refreshSchedules`, para un alta o un
   * cambio real de configuracion: invocarlo sobre un flujo intacto reinicia su
   * cuenta atras y reintroduce la inanicion que el diffing existe para evitar.
   */
  private registerInterval(node: ImapTriggerNode): void {
    const name = intervalName(node.flowId);

    // `addInterval` LANZA si el nombre ya esta tomado, asi que se borra primero
    // (el borrado hace el `clearInterval` por dentro).
    this.deleteIntervalIfExists(name);

    // `void`: el callback de `setInterval` es sincrono y no puede esperar la
    // promesa. Y `addInterval` NO envuelve el callback en try/catch, asi que
    // `pollInbox` tiene la obligacion de no rechazar nunca: una promesa
    // rechazada sin manejar termina el proceso en Node >= 18.
    const interval = setInterval(() => {
      this.logger.debug(
        `[Worker] Disparando conexion IMAP para flujo: ${node.flowId}`,
      );
      void this.pollInbox(node.flowId, node.config);
    }, node.config.pollIntervalMs);

    this.schedulerRegistry.addInterval(name, interval);

    // El registro paralelo se actualiza AQUI y no en el llamador para que no
    // pueda quedar desincronizado del temporizador real que acaba de crearse.
    this.scheduled.set(node.flowId, node.config);
  }

  /**
   * Inscribe la recarga periodica de la tabla de intervalos.
   *
   * Es la via por la que el sondeo descubre los flujos que el asistente acaba de
   * crear, y NO una llamada desde `WorkflowsService`: `NodesModule` ya importa
   * `WorkflowsModule` para despachar los flujos detectados, asi que la
   * dependencia inversa crearia un ciclo de modulos.
   *
   * Reconciliar tambien cubre lo que una notificacion puntual no veria: un
   * esquema editado despues de guardarse, un `activo` cambiado por SQL directo o
   * un flujo borrado. La latencia maxima es un ciclo.
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
          `Fallo la reconciliacion del sondeo IMAP: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, periodMs);

    this.schedulerRegistry.addInterval(RECONCILE_INTERVAL_NAME, interval);
    this.logger.log(
      `Reconciliacion del sondeo IMAP cada ${periodMs} ms; los flujos nuevos se recogeran en el siguiente ciclo.`,
    );
  }

  /** Borra un intervalo solo si esta inscrito: `deleteInterval` lanza si no. */
  private deleteIntervalIfExists(name: string): void {
    if (this.schedulerRegistry.doesExist('interval', name)) {
      this.schedulerRegistry.deleteInterval(name);
    }
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

    // Sin esto, el registro paralelo afirmaria que hay flujos programados cuyos
    // temporizadores ya no existen, y la siguiente reconciliacion los daria por
    // intactos y no volveria a inscribirlos.
    this.scheduled.clear();
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
