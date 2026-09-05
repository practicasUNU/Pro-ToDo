import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { ExecutionState } from '@core/fsm/types/fsm.enums';

import type { PipelineNodeConfigDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { NodeResult } from '@core/fsm/types/node-strategy.types';
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

/** Intentos ya consumidos por nodo, indexados por `nodeId`. */
type RetryState = Record<string, number>;

/** Campos del checkpoint que el motor reescribe en cada transicion. */
interface CheckpointPatch {
  currentState: ExecutionState;
  activeCursor: string | null;
  contextPayload: Record<string, Record<string, unknown>>;
  retryState: RetryState;
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
   * @param initialPayload Datos del disparador; se cargan en `trigger`.
   * @returns La entidad con el estado final (EXITOSO, PAUSADO o FALLIDO).
   * @throws NotFoundException Si la ejecucion no existe.
   * @throws ConflictException Si ya hay un bucle atendiendola.
   */
  public async executeWorkflow(
    executionId: string,
    schema: PipelineSchemaDto,
    initialPayload?: Record<string, unknown>,
  ): Promise<FsmExecution> {
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
      initialPayload,
    );
    let retryState: RetryState = { ...(execution.retryState as RetryState) };

    await this.saveCheckpoint(execution, {
      currentState: ExecutionState.EN_PROCESO,
      activeCursor: cursor,
      contextPayload: context.getAllContext(),
      retryState,
    });

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

        // --- Bucle intra-nodo: reintentos SIN mover el cursor, de modo que no
        // consumen presupuesto de transiciones. El tope de vueltas lo impone el
        // `@Max(5)` de RetryPolicyDto (capa 1 de la defensa).
        let result: NodeResult;

        for (;;) {
          result = await this.runNode(node, context, executionId);

          if (result.success) {
            break;
          }

          const attempts = retryState[node.nodeId] ?? 0;

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
        `Fallo catastrofico en la ejecucion "${executionId}": ${this.describeError(error)}`,
        error instanceof Error ? error.stack : undefined,
      );

      // Defensivo: si lo que fallo fue la propia base de datos, este guardado
      // tambien fallara. No debe enmascarar el error original.
      try {
        await this.saveCheckpoint(execution, {
          currentState: ExecutionState.FALLIDO,
          activeCursor: cursor,
          contextPayload: context.getAllContext(),
          retryState,
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
  ): Promise<NodeResult> {
    try {
      const strategy = this.strategyFactory.getStrategy(node.nodeType);

      return await strategy.execute(context, node.params);
    } catch (error) {
      this.logger.error(
        `Excepcion no controlada en el nodo "${node.nodeId}" (ejecucion=${executionId}): ${this.describeError(error)}`,
        error instanceof Error ? error.stack : undefined,
      );

      return {
        success: false,
        error: {
          level: 'URGENTE',
          message: this.describeError(error),
          stackTrace: error instanceof Error ? error.stack : undefined,
        },
      };
    }
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
    Object.assign(execution, patch);

    // `QueryDeepPartialEntity` no acepta un Record con firma de indice: intenta
    // hacerlo parcial recursivamente y no cuadra con `Record<string, unknown>`.
    // El cast es seguro porque `CheckpointPatch` solo declara columnas reales.
    await this.fsmExecutionRepo.update(
      execution.executionId,
      patch as QueryDeepPartialEntity<FsmExecution>,
    );
  }

  /** Normaliza un `unknown` a texto sin caer en "[object Object]". */
  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : 'Error desconocido';
  }
}
