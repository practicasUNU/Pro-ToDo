import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';

import { HybridLoggerService } from '@common/services/hybrid-logger.service';
import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { StrategyNotFoundException } from '@core/fsm/exceptions/strategy-not-found.exception';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { ExecutionState } from '@core/fsm/types/fsm.enums';

import type { PipelineNodeConfigDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { NodeResult } from '@core/fsm/types/node-strategy.types';
import type { NodeType } from '@core/fsm/types/pipeline-schema.types';
import type { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

/** Namespace reservado donde aterriza el `initialPayload` del disparador. */
export const TRIGGER_NAMESPACE = 'trigger';

/**
 * Circuit breaker de grafo: tope de saltos ENTRE nodos en una misma ejecucion.
 *
 * PROT-07 permite deliberadamente que `onErrorStep` apunte hacia atras (patron
 * de recuperacion), asi que `A -> falla -> B -> A` es un esquema valido que
 * colgaria el worker para siempre. Los reintentos intra-nodo NO gastan de este
 * presupuesto: viven en un bucle anidado que no mueve el cursor.
 */
export const MAX_TRANSITIONS = 100;

/** Factor por defecto cuando el nodo declara `backoffMs` pero no `backoffFactor`. */
const DEFAULT_BACKOFF_FACTOR = 2;

/**
 * Instancias vivas por flujo cuando `MAX_CONCURRENT_EXECUTIONS_PER_FLOW` falta.
 *
 * Uno, y no un numero mayor, porque es lo que la base de datos impone de todos
 * modos con el indice unico parcial `idx_flujo_activo`: un valor por defecto mas
 * alto solo cambiaria un 409 limpio por un fallo de integridad referencial.
 */
const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 1;

/**
 * Nombre del indice unico parcial que hace de mutex de ejecucion.
 *
 * Se repite aqui, ademas de en la entidad, porque es la unica pista que trae el
 * error del driver para distinguir ESTA violacion de cualquier otra unicidad.
 */
const ACTIVE_FLOW_MUTEX_INDEX = 'idx_flujo_activo';

/** SQLSTATE de PostgreSQL para `unique_violation`. */
const PG_UNIQUE_VIOLATION = '23505';

/** Intentos ya consumidos por nodo, indexados por `nodeId`. */
type RetryState = Record<string, number>;

/**
 * Modificadores del recorrido para una invocacion concreta de `executeWorkflow`.
 *
 * Se agrupan en un objeto en vez de encadenar parametros posicionales: el motor
 * ya tenia `initialPayload` como tercer argumento y anadir un cuarto obligaria a
 * pasar `undefined` de relleno en cada llamada que solo quisiera el ultimo.
 */
export interface ExecuteWorkflowOptions {
  /** Datos del disparador; aterrizan en el namespace reservado `trigger`. */
  initialPayload?: Record<string, unknown>;

  /**
   * Tipos de nodo que el bucle NO despacha a su estrategia.
   *
   * Existe para el despacho manual de pruebas: un nodo disparador abriria una
   * conexion real por red (IMAP) y SOBRESCRIBIRIA con su resultado el namespace
   * que la prueba acaba de sembrar. Omitirlo deja intacto lo ya sembrado.
   *
   * Se declara por TIPO y no por `nodeId` para que el llamador no tenga que
   * inspeccionar el grafo, y para que un disparador nuevo quede cubierto sin
   * volver a tocar el motor.
   */
  skipNodeTypes?: readonly NodeType[];
}

/** Campos del checkpoint que el motor reescribe en cada transicion. */
interface CheckpointPatch {
  currentState: ExecutionState;
  activeCursor: string | null;
  contextPayload: Record<string, Record<string, unknown>>;
  retryState: RetryState;
  /** Solo lo escribe el desenlace catastrofico; las transiciones normales no. */
  logFilePath?: string | null;
}

/**
 * Desenlace de un nodo, con la clasificacion que el bucle necesita para decidir.
 *
 * `catastrophic` NO se deduce de `result.error.level`, y ese es el punto entero
 * del tipo. Una estrategia puede DEVOLVER `URGENTE` para decir "esto es grave y
 * no tiene sentido reintentar", y eso sigue siendo un desenlace del dominio: la
 * estrategia controlaba la situacion. Catastrofico es que la estrategia se rompa
 * —que LANCE— y el motor quede sin saber que dejo a medias.
 *
 * Fundir ambas cosas en el `level` haria que el primer caso pasara a marcar
 * FALLIDO, y un flujo que hoy se pausa y se reintenta con CU-09 dejaria de poder
 * reanudarse.
 */
interface NodeOutcome {
  readonly catastrophic: boolean;
  readonly result: NodeResult;
}

/**
 * Subconjunto del error del driver `pg` que el motor necesita leer.
 *
 * TypeORM tipa `driverError` como un `Error` generico, asi que sin esto no hay
 * forma de mirar el SQLSTATE sin un `any`. Las dos propiedades son OPCIONALES
 * porque asi llegan: el parser de `pg` solo las asigna si el servidor las envia.
 */
interface PostgresDriverError extends Error {
  code?: string;
  constraint?: string;
}

/** Espera pasiva; solo se invoca cuando el nodo declara un backoff real. */
const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Orquestador del motor FSM.
 *
 * Recorre el grafo declarado en el `pipeline_schema` paso a paso, despacha cada
 * nodo a su estrategia y escribe un checkpoint en `ejecuciones_flujo` tras cada
 * transicion, de modo que una ejecucion interrumpida pueda reanudarse desde el
 * punto exacto en que se detuvo sin repetir el trabajo previo.
 *
 * RESILIENCIA DE DOS NIVELES (`architecture-patterns.md` §4):
 *
 * - `try` INTERNO (`runNode`): aisla el fallo de un nodo. Una excepcion no
 *   controlada de una estrategia se normaliza a un `NodeResult` URGENTE en vez
 *   de propagarse, para que un nodo defectuoso no tumbe la ejecucion entera.
 * - `try` EXTERNO: atrapa el fallo catastrofico (la base de datos deja de
 *   responder), marca FALLIDO en la medida de lo posible y re-lanza.
 */
@Injectable()
export class FsmEngineService {
  private readonly logger = new Logger(FsmEngineService.name);

  constructor(
    @InjectRepository(FsmExecution)
    private readonly fsmExecutionRepo: Repository<FsmExecution>,
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly configService: ConfigService,
    private readonly hybridLogger: HybridLoggerService,
  ) {}

  /**
   * Da de alta una ejecucion INACTIVO lista para que `executeWorkflow` la tome.
   *
   * CONTROL DE CONCURRENCIA (RNF-09): antes de insertar nada se cuentan las
   * instancias EN_PROCESO del flujo. Rechazar aqui, y no dejar que reviente el
   * indice `idx_flujo_activo`, es lo que convierte el limite en un 409 con un
   * mensaje que el operador entiende en vez de un 500 por violacion de unicidad.
   * No hay bandera de forzado a proposito: dos bucles sobre el mismo flujo se
   * pisarian el checkpoint, y el segundo publicaria con un contexto a medias.
   *
   * La guarda NO es atomica —hay una ventana entre el `count` y el `UPDATE` a
   * EN_PROCESO de `executeWorkflow`—, pero no necesita serlo: el indice unico
   * parcial es la barrera real y cierra la carrera desde la base de datos. Esto
   * es la capa que da el diagnostico.
   *
   * @param flowId Flujo de `flujos` al que pertenece la ejecucion.
   * @param initialContext Namespaces con los que se siembra `contexto_acumulado`,
   *        para que `buildContext()` los restaure de forma inmutable.
   * @returns La fila persistida, con su `executionId` ya asignado.
   * @throws ConflictException Si el flujo agota su cupo de instancias activas.
   */
  public async createExecution(
    flowId: string,
    initialContext: Record<string, Record<string, unknown>> = {},
  ): Promise<FsmExecution> {
    const maxAllowed =
      Number(
        this.configService.get<string>('MAX_CONCURRENT_EXECUTIONS_PER_FLOW'),
      ) || DEFAULT_MAX_CONCURRENT_EXECUTIONS;

    const activeCount = await this.fsmExecutionRepo.count({
      where: { flowId, currentState: ExecutionState.EN_PROCESO },
    });

    if (activeCount >= maxAllowed) {
      throw new ConflictException(
        `Conflicto de concurrencia (RNF-09): el flujo "${flowId}" ya tiene ${activeCount}/${maxAllowed} ejecucion(es) EN_PROCESO.`,
      );
    }

    const execution = this.fsmExecutionRepo.create({
      flowId,
      currentState: ExecutionState.INACTIVO,
      activeCursor: null,
      contextPayload: initialContext,
      retryState: {},
    });

    return this.fsmExecutionRepo.save(execution);
  }

  /**
   * Ejecuta un flujo de principio a fin, o hasta que un nodo lo detenga.
   *
   * @param executionId Fila de `ejecuciones_flujo` que sostiene el checkpoint.
   * @param schema Esquema ya validado por `PipelineValidatorService`.
   * @param options Modificadores del recorrido: payload del disparador y
   *        tipos de nodo a omitir (ver `ExecuteWorkflowOptions`).
   * @returns La entidad con el estado final (EXITOSO, PAUSADO o FALLIDO).
   * @throws NotFoundException Si la ejecucion no existe.
   * @throws ConflictException Si ya hay un bucle atendiendola, o si otro
   *         despacho gana la carrera por el mutex `idx_flujo_activo` (RNF-09).
   */
  public async executeWorkflow(
    executionId: string,
    schema: PipelineSchemaDto,
    options: ExecuteWorkflowOptions = {},
  ): Promise<FsmExecution> {
    const skippedNodeTypes = new Set<NodeType>(options.skipNodeTypes ?? []);

    // --- Validacion previa. Deliberadamente FUERA del try externo: si marcar
    // EN_PROCESO choca contra el mutex `idx_flujo_activo`, la excepcion debe
    // propagarse sin marcar FALLIDO. No ha fallado el flujo; no le tocaba turno.
    const execution = await this.fsmExecutionRepo.findOne({
      where: { executionId },
    });

    if (execution === null) {
      throw new NotFoundException(
        `No existe la ejecucion "${executionId}" en ejecuciones_flujo.`,
      );
    }

    if (execution.currentState === ExecutionState.EN_PROCESO) {
      throw new ConflictException(
        `La ejecucion "${executionId}" ya esta EN_PROCESO: hay un bucle atendiendola.`,
      );
    }

    let cursor: string | null = execution.activeCursor ?? schema.entrypoint;
    const context = this.buildContext(
      executionId,
      schema,
      cursor,
      execution,
      options.initialPayload,
    );
    let retryState: RetryState = { ...(execution.retryState as RetryState) };

    // Unica escritura que puede chocar contra el mutex `idx_flujo_activo`: es la
    // transicion que RESERVA el turno del flujo. Las demas del bucle no pueden
    // violarlo, porque el indice es PARCIAL sobre `WHERE estado = 'EN_PROCESO'`
    // y, una vez dentro, esta fila ya es la unica entrada del indice para su
    // `id_flujo`.
    //
    // El try es local y NO el externo, a proposito: perder la carrera no es un
    // fallo del flujo y no debe marcar FALLIDO (mismo criterio que la
    // validacion previa de arriba).
    try {
      await this.saveCheckpoint(execution, {
        currentState: ExecutionState.EN_PROCESO,
        activeCursor: cursor,
        contextPayload: context.getAllContext(),
        retryState,
      });
    } catch (error: unknown) {
      if (this.isActiveFlowMutexViolation(error)) {
        this.logger.warn(
          `Conflicto de concurrencia (RNF-09): la ejecucion "${executionId}" no arranca; el flujo "${execution.flowId}" ya tiene otra EN_PROCESO.`,
        );

        throw new ConflictException(
          `Conflicto de concurrencia (RNF-09): el flujo "${execution.flowId}" ya tiene una ejecucion EN_PROCESO. La ejecucion "${executionId}" no ha arrancado.`,
        );
      }

      throw error;
    }

    try {
      let transitions = 0;

      while (cursor !== null) {
        // Capa 2 de la defensa contra ciclos (ver MAX_TRANSITIONS).
        if (++transitions > MAX_TRANSITIONS) {
          this.logger.error(
            `URGENTE | ejecucion=${executionId} | Circuit breaker: se superaron ${MAX_TRANSITIONS} transiciones. Posible ciclo en el grafo. Se pausa en "${cursor}".`,
          );
          await this.pauseAt(execution, cursor, context, retryState);
          break;
        }

        const node: PipelineNodeConfigDto | undefined = schema.nodes[cursor];

        // El validador topologico lo impide, pero el motor recibe un DTO que
        // pudo no pasar por el: sin esta guarda seria un TypeError opaco.
        if (node === undefined) {
          this.logger.error(
            `URGENTE | ejecucion=${executionId} | El cursor "${cursor}" no existe en el mapa de nodos.`,
          );
          await this.pauseAt(execution, cursor, context, retryState);
          break;
        }

        // --- Omision en modo prueba. Va ANTES del bucle de reintentos porque un
        // nodo omitido no se ejecuta en absoluto: no hay `NodeResult` que
        // evaluar ni intento que contabilizar.
        //
        // NO se llama a `setNamespace`: el namespace que este nodo produciria
        // viene sembrado en `contexto_acumulado` y sobrescribirlo con un objeto
        // vacio destruiria justo el dato simulado que motiva la omision.
        if (skippedNodeTypes.has(node.nodeType)) {
          this.logger.log(
            `Modo prueba | ejecucion=${executionId} | Se omite el nodo "${node.nodeId}" (${node.nodeType}); se conserva el namespace "${node.outputNamespace}" ya sembrado.`,
          );

          cursor = node.nextStep;

          // Mismo criterio que la transicion exitosa: con el cursor ya nulo no
          // se persiste un `EN_PROCESO` intermedio sin significado; se deja
          // pasar a la finalizacion EXITOSO de abajo.
          if (cursor === null) {
            break;
          }

          context.setCursor(cursor);
          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.EN_PROCESO,
            activeCursor: cursor,
            contextPayload: context.getAllContext(),
            retryState,
          });
          continue;
        }

        // --- Bucle intra-nodo: reintentos SIN mover el cursor, de modo que no
        // consumen presupuesto de transiciones. El tope de vueltas lo impone el
        // `@Max(5)` de RetryPolicyDto (capa 1 de la defensa).
        let outcome: NodeOutcome;

        for (;;) {
          outcome = await this.runNode(node, context, executionId);

          // Corte inmediato: una estrategia que se rompio no admite reintento.
          // No se sabe que dejo a medias, asi que volver a invocarla es apostar
          // sobre un estado desconocido.
          if (outcome.catastrophic || outcome.result.success) {
            break;
          }

          const attempts = retryState[node.nodeId] ?? 0;
          const result = outcome.result;

          if (!this.canRetry(node, result, attempts)) {
            break;
          }

          retryState = { ...retryState, [node.nodeId]: attempts + 1 };
          this.logger.warn(
            `Reintento ${attempts + 1}/${node.retryPolicy?.maxRetries ?? 0} del nodo "${node.nodeId}" (ejecucion=${executionId}).`,
          );

          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.EN_PROCESO,
            activeCursor: cursor,
            contextPayload: context.getAllContext(),
            retryState,
          });

          await this.waitBackoff(node, attempts + 1);
        }

        // --- Desenlace CATASTROFICO. Va antes que cualquier otra rama, incluida
        // `onErrorStep`: la ruta de recuperacion es una decision del diseñador
        // del flujo sobre fallos PREVISTOS, y aqui lo que se rompio es el propio
        // ejecutor. Encaminar a otro nodo prolongaria el bucle sobre un proceso
        // en estado desconocido, que es justo lo que hay que evitar.
        if (outcome.catastrophic) {
          await this.failCatastrophically(
            execution,
            cursor,
            context,
            retryState,
            node.nodeId,
            outcome.result,
          );
          break;
        }

        const result = outcome.result;

        if (result.success) {
          context.setNamespace(node.outputNamespace, result.data ?? {});
          cursor = node.nextStep;

          // Con el cursor ya nulo no se persiste nada aqui: el nodo terminal
          // deja paso a la finalizacion EXITOSO y escribir antes un
          // `EN_PROCESO` con cursor nulo seria un estado sin significado, y un
          // viaje de ida y vuelta a la base de datos de mas.
          if (cursor === null) {
            break;
          }

          context.setCursor(cursor);
          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.EN_PROCESO,
            activeCursor: cursor,
            contextPayload: context.getAllContext(),
            retryState,
          });
          continue;
        }

        this.logger.warn(
          `${result.error?.level ?? 'URGENTE'} | ejecucion=${executionId} | Nodo "${node.nodeId}": ${result.error?.message ?? 'fallo sin detalle'}`,
        );

        if (node.onErrorStep !== null) {
          cursor = node.onErrorStep;
          context.setCursor(cursor);

          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.EN_PROCESO,
            activeCursor: cursor,
            contextPayload: context.getAllContext(),
            retryState,
          });
          continue;
        }

        // Sin ruta de recuperacion: se detiene conservando el cursor culpable,
        // que es lo que permite el reintento manual de CU-09.
        await this.pauseAt(execution, cursor, context, retryState);
        break;
      }

      if (cursor === null) {
        await this.saveCheckpoint(execution, {
          currentState: ExecutionState.EXITOSO,
          activeCursor: null,
          contextPayload: context.getAllContext(),
          retryState,
        });
      }
    } catch (error) {
      this.logger.error(
        `URGENTE | ejecucion=${executionId} | Fallo catastrofico del bucle: ${this.describeError(error)}`,
        error instanceof Error ? error.stack : undefined,
      );

      // El volcado a disco va PRIMERO y fuera del try de persistencia: este
      // manejador cubre justamente el caso de que PostgreSQL no responda, y
      // entonces el archivo es el unico rastro que va a quedar del incidente.
      const logFilePath = this.hybridLogger.logCatastrophicFailure({
        executionId,
        flowId: execution.flowId,
        nodeId: cursor,
        level: 'URGENTE',
        message: this.describeError(error),
        stackTrace: error instanceof Error ? error.stack : undefined,
        payload: context.getAllContext(),
      });

      // Defensivo: si lo que fallo fue la propia base de datos, este guardado
      // tambien fallara. No debe enmascarar el error original.
      try {
        await this.saveCheckpoint(execution, {
          currentState: ExecutionState.FALLIDO,
          activeCursor: cursor,
          contextPayload: context.getAllContext(),
          retryState,
          logFilePath,
        });
      } catch (persistError) {
        this.logger.error(
          `Tampoco se pudo marcar FALLIDO la ejecucion "${executionId}": ${this.describeError(persistError)}`,
        );
      }

      throw error;
    }

    return execution;
  }

  /**
   * Reconstruye el contexto de la ejecucion.
   *
   * Restaura primero los namespaces persistidos (reanudacion) y despues el
   * payload del disparador, de modo que un reintento no repita el trabajo de
   * los nodos que ya completaron.
   */
  private buildContext(
    executionId: string,
    schema: PipelineSchemaDto,
    cursorStart: string,
    execution: FsmExecution,
    initialPayload?: Record<string, unknown>,
  ): StatePayloadContext {
    const context = new StatePayloadContext(
      executionId,
      schema.flowId,
      cursorStart,
    );

    for (const [namespace, data] of Object.entries(
      execution.contextPayload ?? {},
    )) {
      context.setNamespace(namespace, data);
    }

    if (initialPayload !== undefined) {
      context.setNamespace(TRIGGER_NAMESPACE, initialPayload);
    }

    return context;
  }

  /**
   * Ejecuta un nodo aislando cualquier excepcion no controlada (`try` interno).
   *
   * Incluye la resolucion de la estrategia: una `StrategyNotFoundException` es
   * un error de configuracion que debe pausar el flujo, no derribar el proceso.
   */
  private async runNode(
    node: PipelineNodeConfigDto,
    context: StatePayloadContext,
    executionId: string,
  ): Promise<NodeOutcome> {
    try {
      const strategy = this.strategyFactory.getStrategy(node.nodeType);

      // Camino del DOMINIO: la estrategia decidio el desenlace y lo devolvio.
      // Su `level` es un diagnostico suyo, no una senal de que el motor este en
      // peligro, asi que se respeta tal cual.
      return {
        catastrophic: false,
        result: await strategy.execute(context, node.params),
      };
    } catch (error) {
      // Camino EXCEPCIONAL. Se discrimina por el TIPO de la excepcion y no por
      // el `level` de un `NodeResult`, porque son dos cosas distintas: una
      // estrategia que DEVUELVE `URGENTE` esta informando de un fallo grave del
      // dominio; una que LANZA se ha roto, y el motor no puede saber en que
      // estado dejo lo que tocaba.
      const domainFailure = this.toDomainFailure(error);

      if (domainFailure !== null) {
        this.logger.warn(
          `${domainFailure.error?.level ?? 'GRAVE'} | ejecucion=${executionId} | Nodo "${node.nodeId}": ${this.describeError(error)}`,
        );

        return { catastrophic: false, result: domainFailure };
      }

      this.logger.error(
        `URGENTE | ejecucion=${executionId} | Excepcion no controlada en el nodo "${node.nodeId}": ${this.describeError(error)}`,
        error instanceof Error ? error.stack : undefined,
      );

      return {
        catastrophic: true,
        result: {
          success: false,
          error: {
            level: 'URGENTE',
            message: this.describeError(error),
            stackTrace: error instanceof Error ? error.stack : undefined,
          },
        },
      };
    }
  }

  /**
   * Clasifica una excepcion como fallo del DOMINIO de los nodos, o `null` si es
   * catastrofica.
   *
   * La frontera no es cosmetica: decide entre PAUSADO (reanudable con CU-09) y
   * FALLIDO (terminal). Se pone del lado del dominio lo que un operador puede
   * arreglar sin tocar codigo:
   *
   * - `StrategyNotFoundException`: falta la estrategia de un tipo de nodo. Es un
   *   error de CONFIGURACION del esquema; marcar FALLIDO obligaria a relanzar el
   *   flujo desde cero despues de corregirlo, cuando el trabajo de los nodos
   *   anteriores sigue siendo valido.
   * - `HttpException`: la familia que usan las estrategias para los timeouts y
   *   los fallos de validacion de sus `params` —los dos ejemplos que el propio
   *   contrato del motor cita como errores de dominio.
   *
   * Todo lo demas —`TypeError`, `QueryFailedError`, un `Error` pelado— es un
   * defecto de programacion o una averia de infraestructura: nadie lo arregla
   * reintentando, y seguir el bucle sobre un proceso en estado desconocido es
   * peor que abortarlo.
   */
  private toDomainFailure(error: unknown): NodeResult | null {
    if (error instanceof StrategyNotFoundException) {
      return {
        success: false,
        error: { level: 'GRAVE', message: this.describeError(error) },
      };
    }

    if (error instanceof HttpException) {
      return {
        success: false,
        error: { level: 'GRAVE', message: this.describeError(error) },
      };
    }

    return null;
  }

  /**
   * Decide si el fallo admite otro intento en el mismo nodo.
   *
   * Solo los `GRAVE` reintentan: un `URGENTE` es irrecuperable y un `LEVE` no
   * justifica insistir. El tope de `maxRetries` ya viene acotado a 5 por el DTO.
   */
  private canRetry(
    node: PipelineNodeConfigDto,
    result: NodeResult,
    attempts: number,
  ): boolean {
    if (result.error?.level !== 'GRAVE' || node.retryPolicy === undefined) {
      return false;
    }

    return attempts < node.retryPolicy.maxRetries;
  }

  /** Backoff exponencial. Sin `backoffMs` declarado no hay espera alguna. */
  private async waitBackoff(
    node: PipelineNodeConfigDto,
    attempt: number,
  ): Promise<void> {
    const base = node.retryPolicy?.backoffMs ?? 0;

    if (base <= 0) {
      return;
    }

    const factor = node.retryPolicy?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;

    await sleep(base * factor ** (attempt - 1));
  }

  /**
   * Cierra la ejecucion como FALLIDO tras un fallo catastrofico.
   *
   * Ejecuta el orden que fija `architecture-patterns.md` §4, y el orden importa:
   *
   * 1. **Disco primero.** El volcado forense se escribe ANTES de tocar la base
   *    de datos, porque el escenario tipico de un fallo catastrofico es
   *    precisamente que PostgreSQL no responda. Al reves, un fallo de base de
   *    datos se llevaria por delante tambien el stack trace, y no quedaria
   *    ningun rastro del incidente en ninguna parte.
   * 2. **PostgreSQL despues**, con la severidad, la ruta del volcado y el
   *    checkpoint. El cursor se CONSERVA aunque el estado sea terminal: saber en
   *    que nodo se rompio es la mitad del diagnostico, y perderlo por dejarlo en
   *    `null` no ahorra nada.
   *
   * FALLIDO y no PAUSADO: PAUSADO significa "reanudable con CU-09", y reanudar
   * sobre un ejecutor que lanzo una excepcion no controlada repetiria el fallo.
   * El operador tiene que corregir el codigo y lanzar una ejecucion nueva.
   */
  private async failCatastrophically(
    execution: FsmExecution,
    cursor: string | null,
    context: StatePayloadContext,
    retryState: RetryState,
    nodeId: string | null,
    result: NodeResult,
  ): Promise<void> {
    const logFilePath = this.hybridLogger.logCatastrophicFailure({
      executionId: execution.executionId,
      flowId: execution.flowId,
      nodeId,
      level: result.error?.level ?? 'URGENTE',
      message: result.error?.message ?? 'Fallo catastrofico sin detalle',
      stackTrace: result.error?.stackTrace,
      payload: context.getAllContext(),
    });

    this.logger.error(
      `URGENTE | ejecucion=${execution.executionId} | Fallo catastrofico en "${nodeId ?? 'desconocido'}". Ejecucion marcada FALLIDO. Volcado: ${logFilePath ?? 'no se pudo escribir'}.`,
    );

    await this.saveCheckpoint(execution, {
      currentState: ExecutionState.FALLIDO,
      activeCursor: cursor,
      contextPayload: context.getAllContext(),
      retryState,
      logFilePath,
    });
  }

  /** Detiene la ejecucion conservando el cursor del nodo que la bloqueo. */
  private async pauseAt(
    execution: FsmExecution,
    cursor: string,
    context: StatePayloadContext,
    retryState: RetryState,
  ): Promise<void> {
    await this.saveCheckpoint(execution, {
      currentState: ExecutionState.PAUSADO,
      activeCursor: cursor,
      contextPayload: context.getAllContext(),
      retryState,
    });
  }

  /**
   * Persiste el checkpoint y mantiene al dia la entidad en memoria.
   *
   * El `Object.assign` evita un `findOne` extra al final: la instancia que se
   * devuelve al llamante ya refleja el estado final.
   */
  private async saveCheckpoint(
    execution: FsmExecution,
    patch: CheckpointPatch,
  ): Promise<void> {
    // `QueryDeepPartialEntity` no acepta un Record con firma de indice: intenta
    // hacerlo parcial recursivamente y no cuadra con `Record<string, unknown>`.
    // El cast es seguro porque `CheckpointPatch` solo declara columnas reales.
    await this.fsmExecutionRepo.update(
      execution.executionId,
      patch as QueryDeepPartialEntity<FsmExecution>,
    );

    // DESPUES del UPDATE, nunca antes: si la escritura falla —y con el mutex
    // `idx_flujo_activo` ahora es un desenlace esperado, no una rareza— la
    // entidad en memoria no debe anunciar un estado que la fila jamas tuvo.
    Object.assign(execution, patch);
  }

  /**
   * Distingue el choque contra el mutex `idx_flujo_activo` de otro fallo de BD.
   *
   * Exige el SQLSTATE de `unique_violation` y, CUANDO el driver informa el
   * nombre de la restriccion, que sea el del mutex: asi un 23505 de otra
   * unicidad sigue subiendo crudo en vez de disfrazarse de un 409 que mentiria.
   * Si el nombre no viene se acepta igual, porque la unica sentencia protegida
   * es el UPDATE que marca EN_PROCESO y la unica unicidad que puede violar en
   * `ejecuciones_flujo` es la del mutex: la clave primaria ni se toca.
   */
  private isActiveFlowMutexViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }

    const driverError = error.driverError as PostgresDriverError | undefined;

    if (driverError?.code !== PG_UNIQUE_VIOLATION) {
      return false;
    }

    return (
      driverError.constraint === undefined ||
      driverError.constraint === ACTIVE_FLOW_MUTEX_INDEX
    );
  }

  /** Normaliza un `unknown` a texto sin caer en "[object Object]". */
  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Error desconocido';
  }
}
