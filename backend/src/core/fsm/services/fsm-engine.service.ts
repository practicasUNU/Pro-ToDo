import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError } from 'typeorm';

import { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import { StrategyNotFoundException } from '@core/fsm/exceptions/strategy-not-found.exception';
import { NodeStrategyFactory } from '@core/fsm/factories/node-strategy.factory';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import {
  ERR_NODE_CRASHED,
  ERR_NODE_HTTP_FAILURE,
  ERR_STRATEGY_NOT_FOUND,
} from '@core/fsm/types/node-strategy.types';
import { resolveErrorRoute } from '@core/fsm/utils/pipeline-topology.util';
import { NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';

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
  /** Motivo legible del cierre. Lo escribe el desenlace por severidad LEVE. */
  failureReason?: string | null;
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

/** Longitud de `ejecuciones_flujo.motivo_fallo`. */
/**
 * Namespace del correo crudo cuyo binario libera el motor.
 *
 * Va como literal y no importando el tipo del nodo IMAP a proposito: `@core` no
 * puede depender de `@modules` sin invertir la direccion de las dependencias, y
 * el motor no tiene por que conocer el formato de un correo. La purga es
 * ESTRUCTURAL: opera sobre el nombre de una clave, no sobre una interfaz.
 */
const RAW_EMAIL_NAMESPACE = 'raw_email';

/** Clave, dentro de ese namespace, que guarda el inventario de adjuntos. */
const ATTACHMENTS_KEY = 'attachments';

/** Clave del binario en base64 que se libera. */
const BINARY_CONTENT_KEY = 'contentBase64';

/**
 * Claves con las que un nodo declara haber extraido texto aprovechable.
 *
 * Son el disparador de la liberacion de memoria: mientras ningun nodo haya
 * sacado texto, el binario sigue siendo la UNICA fuente de datos del correo
 * —un PDF escaneado, un `multipart/alternative` sin parte de texto— y tirarlo
 * dejaria al flujo sin nada que procesar. En cuanto alguien produce texto, el
 * binario pasa a ser peso muerto.
 *
 * `extracted_documents_text` es el texto NATIVO que `PARSER_PRE_IA` saca de los
 * adjuntos legibles (.pdf, .docx, .xlsx, .csv, .txt). Sin ella en esta lista, el
 * caso que mas pesa —el correo de cuerpo vacio cuyo contenido entero viaja en un
 * PDF— dejaba `clean_body` vacio, `hasUsefulText` daba `false` y los megabytes
 * se quedaban en `contexto_acumulado` para siempre, aun habiendose extraido ya
 * todo su texto.
 *
 * La lista es ESTRUCTURAL, por nombre de clave: es lo que permite al motor
 * decidir sin importar ni una interfaz de `@modules`.
 */
const EXTRACTED_TEXT_KEYS = [
  'clean_body',
  'text',
  'extracted_text',
  'extracted_documents_text',
] as const;

/** Marca que sustituye al base64 en la traza de disco. */
const REDACTED_BINARY_PLACEHOLDER = '[base64 omitido]';

/**
 * Claves con las que un nodo declara que el binario TODAVIA hace falta.
 *
 * Es el contrapeso de `EXTRACTED_TEXT_KEYS` y vive en el mismo plano: un
 * vocabulario de NOMBRES DE CLAVE, no de nodos. El motor sigue sin saber que
 * existe un `PARSER_PRE_IA`, igual que ya no sabia quien escribe `clean_body`.
 * Cualquier nodo futuro —un OCR, un transcriptor de audio— puede levantar la
 * misma bandera para conservar sus bytes sin tocar una linea de `@core`.
 *
 * Va como arreglo y no como literal suelto por la misma razon que aquel: el
 * vocabulario crece, la regla no.
 */
const BINARY_RETENTION_KEYS = ['requires_multimodal_fallback'] as const;

/** Variable de entorno que ajusta el listado de "texto util". */
const MIN_USEFUL_TEXT_LENGTH_KEY = 'FSM_MIN_USEFUL_TEXT_LENGTH';

/**
 * Longitud minima, en caracteres, para que el texto de un nodo libere el binario.
 *
 * Calibrado contra el `minBodyLength` del nodo PARSER_PRE_IA, que usa el mismo
 * 50 para decidir si el cuerpo alcanza para un modelo de lenguaje. Los dos
 * numeros tienen que moverse juntos: si el motor purgase con menos texto del que
 * el parser considera suficiente, quedaria abierta la ventana en la que un
 * correo declara texto bastante para tirar los bytes y a la vez insuficiente
 * para el modelo, que es justo el caso del PDF escaneado con un "Ver adjunto"
 * por cuerpo.
 */
const DEFAULT_MIN_USEFUL_TEXT_LENGTH = 50;

/**
 * Un nodo produjo texto util si alguna de las claves acordadas trae contenido
 * real POR ENCIMA del listado.
 *
 * El umbral llega por parametro y no se lee aqui dentro para que la funcion siga
 * siendo pura: quien la llama ya resolvio la configuracion una sola vez.
 *
 * Una cadena en blanco nunca cuenta —es ausencia de texto con otra forma— y
 * desde el recalibrado tampoco cuenta un "Ver adjunto" de doce caracteres: no es
 * prosa aprovechable, y mientras no la haya el binario sigue siendo la UNICA
 * fuente de datos del correo.
 */
const hasUsefulText = (
  data: Record<string, unknown> | undefined,
  minLength: number,
): boolean =>
  data !== undefined &&
  EXTRACTED_TEXT_KEYS.some((key) => {
    const value = data[key];

    return typeof value === 'string' && value.trim().length >= minLength;
  });

/**
 * Un nodo veto la liberacion si declaro alguna de esas claves con el booleano
 * `true` EXACTO.
 *
 * La comparacion estricta no es celo: el `data` se rehidrata desde una columna
 * jsonb, donde la cadena `"false"` es truthy. Un veto que se pudiera levantar
 * por accidente desactivaria en silencio la politica de memoria de toda la
 * plataforma, y nadie lo notaria hasta ver crecer `contexto_acumulado`.
 */
const vetoesBinaryRelease = (
  data: Record<string, unknown> | undefined,
): boolean =>
  data !== undefined && BINARY_RETENTION_KEYS.some((key) => data[key] === true);

/** Un adjunto todavia por liberar: objeto con `contentBase64` de tipo cadena. */
const holdsBinaryContent = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Record<string, unknown>)[BINARY_CONTENT_KEY] === 'string';

/**
 * Clona el adjunto sustituyendo SOLO `contentBase64`; el resto viaja intacto.
 *
 * Se reemplaza la clave en vez de borrarla para que `filename`, `contentType` y
 * `size` sigan describiendo que venia en el correo: quien audite una ejecucion
 * necesita saber que hubo un adjunto, aunque sus bytes ya no esten.
 */
const withReplacedBinaryContent = (
  value: unknown,
  replacement: string | null,
): unknown => {
  if (!holdsBinaryContent(value)) {
    return value;
  }

  return {
    ...(value as Record<string, unknown>),
    [BINARY_CONTENT_KEY]: replacement,
  };
};

/**
 * Devuelve el inventario de adjuntos de un namespace, o `null` si no hay ninguno
 * pendiente de liberar. `null` significa "no hay nada que hacer aqui".
 */
const pendingAttachmentsOf = (
  namespace: Record<string, unknown> | undefined,
): unknown[] | null => {
  if (namespace === undefined) {
    return null;
  }

  const attachments = namespace[ATTACHMENTS_KEY];

  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  // Si ninguno conserva base64 ya se libero antes. Cortar aqui evita reescribir
  // el namespace —y con el, clonar el contexto entero dos veces— en cada uno de
  // los nodos que queden por delante.
  return attachments.some(holdsBinaryContent) ? attachments : null;
};

const FAILURE_REASON_MAX_LENGTH = 255;

/**
 * Recorta el motivo al ancho de su columna.
 *
 * El texto puede interpolar el nombre de un flujo, que lo escribe un usuario:
 * sin este recorte, un nombre largo convertiria una desactivacion legitima en
 * un `value too long for type character varying(255)`.
 */
const truncateFailureReason = (reason: string): string =>
  reason.length <= FAILURE_REASON_MAX_LENGTH
    ? reason
    : `${reason.slice(0, FAILURE_REASON_MAX_LENGTH - 1)}…`;

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

  /**
   * Ejecuciones que deben abandonar su bucle en la proxima transicion.
   *
   * Es el enlace entre `abortExecutionsForFlow` —que cierra las filas por SQL— y
   * el `while` de `executeWorkflow`, que puede seguir vivo en este mismo
   * proceso. Sin el, el UPDATE seria puramente cosmetico: el siguiente
   * `saveCheckpoint` del bucle sobrescribiria el FALLIDO recien escrito y la
   * ejecucion resucitaria como EN_PROCESO.
   *
   * En memoria y no en la base de datos a proposito: solo tiene sentido para el
   * proceso que sostiene el bucle. Una ejecucion EN_PROCESO huerfana de otro
   * proceso no tiene bucle que avisar, y de esa ya se ocupa la reconciliacion de
   * arranque de `FsmModule`.
   */
  private readonly abortedExecutions = new Map<string, string>();

  /**
   * Umbral de `FSM_MIN_USEFUL_TEXT_LENGTH`, resuelto en la primera lectura.
   *
   * Perezoso y no resuelto en el constructor para que construir el motor no
   * tenga efectos: un valor mal escrito avisa por el log la primera vez que
   * importa, no al arrancar el modulo.
   */
  private cachedMinUsefulTextLength: number | null = null;

  constructor(
    @InjectRepository(FsmExecution)
    private readonly fsmExecutionRepo: Repository<FsmExecution>,
    private readonly strategyFactory: NodeStrategyFactory,
    private readonly configService: ConfigService,
    private readonly hybridLogger: HybridLoggerService,
  ) {}

  /**
   * Cierra como FALLIDO todas las ejecuciones vivas de un flujo.
   *
   * Se invoca cuando el flujo padre deja de estar operativo. Una fila que sigue
   * EN_PROCESO despues de eso no solo es ruido en la trazabilidad: reserva el
   * mutex parcial `idx_flujo_activo`, de modo que si el flujo vuelve a
   * activarse NUNCA podra arrancar otra ejecucion. Las PAUSADO se cierran por el
   * motivo simetrico: conservan su `activeCursor` para un reintento que ya no
   * puede ocurrir, porque el flujo del que colgaban ya no dispara.
   *
   * DOS MITADES, Y LAS DOS HACEN FALTA. El UPDATE cierra las filas, pero un
   * bucle vivo en este proceso volveria a escribir sobre la suya en el siguiente
   * checkpoint. Por eso los identificadores se marcan ademas en
   * `abortedExecutions`, que es lo que el `while` de `executeWorkflow` consulta
   * antes de cada transicion para abandonar sin persistir nada.
   *
   * El metodo vive en el motor y no en `WorkflowsService` porque `FsmModule` no
   * exporta `Repository<FsmExecution>`: este servicio es su unico dueño, y ya lo
   * inyecta quien necesita llamar aqui.
   *
   * @param flowId Flujo cuyas ejecuciones vivas deben cerrarse.
   * @param reason Motivo legible que queda en `motivo_fallo`.
   * @returns Cuantas filas se cerraron.
   */
  public async abortExecutionsForFlow(
    flowId: string,
    reason: string,
  ): Promise<number> {
    const liveStates = [ExecutionState.EN_PROCESO, ExecutionState.PAUSADO];
    const trimmedReason = truncateFailureReason(reason);

    // Se leen ANTES del UPDATE: despues ya no cumplen el filtro y no habria
    // forma de saber a que bucles hay que avisar. Solo hacen falta los
    // EN_PROCESO —ver el marcado de abajo—, pero el estado se pide igualmente
    // para no tener que hacer dos consultas.
    const live = await this.fsmExecutionRepo.find({
      where: { flowId, currentState: In(liveStates) },
      select: { executionId: true, currentState: true },
    });

    if (live.length === 0) {
      return 0;
    }

    // Se marcan SOLO las EN_PROCESO. Una PAUSADO es, por definicion, una
    // ejecucion cuyo bucle ya termino: no hay a quien avisar, y dejar su
    // identificador en el mapa seria una fuga que nadie limpiaria nunca.
    for (const { executionId, currentState } of live) {
      if (currentState === ExecutionState.EN_PROCESO) {
        this.abortedExecutions.set(executionId, trimmedReason);
      }
    }

    const { affected } = await this.fsmExecutionRepo.update(
      { flowId, currentState: In(liveStates) },
      { currentState: ExecutionState.FALLIDO, failureReason: trimmedReason },
    );

    const closed = affected ?? live.length;

    this.logger.warn(
      `Flujo "${flowId}": ${closed} ejecucion(es) viva(s) cerradas como FALLIDO. Motivo: ${trimmedReason}.`,
    );

    return closed;
  }

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

    // Una marca superviviente de un aborto ANTERIOR envenenaria este arranque:
    // el reintento manual de CU-09 reutiliza el mismo `executionId`, y sin esta
    // limpieza moriria en su primera transicion por una desactivacion que ya se
    // resolvio. Si el aborto es para ESTA vuelta, llegara despues.
    this.abortedExecutions.delete(executionId);

    try {
      let transitions = 0;

      while (cursor !== null) {
        // Aborto llegado mientras se escribia el checkpoint anterior. Va antes
        // que el circuit breaker para no consumir presupuesto de transiciones
        // ni disparar el `pauseAt` de un bucle que ya no debe continuar.
        if (this.consumeAbortMark(execution, cursor)) {
          break;
        }

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
          const startedAt = Date.now();

          outcome = await this.runNode(node, context, executionId);

          // La traza va DENTRO del bucle y no fuera: una fila por invocacion
          // real de la estrategia. Con una sola fila final, los reintentos
          // fallidos desaparecerian, y son a menudo el dato que explica la
          // incidencia —"tardo en estabilizarse" frente a "fallo a la primera".
          await this.logNodeOutcome(
            executionId,
            node,
            outcome,
            Date.now() - startedAt,
          );

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

        // Aborto llegado MIENTRAS el nodo corria: el caso frecuente, porque es
        // donde el bucle pasa casi todo su tiempo. Comprobarlo solo arriba no
        // basta —la rama de exito de mas abajo escribiria EN_PROCESO y la fila
        // volveria a reservar el mutex `idx_flujo_activo` de un flujo que
        // deberia estar quieto—, asi que se corta aqui, antes de la primera
        // sentencia que persiste algo.
        if (this.consumeAbortMark(execution, cursor)) {
          break;
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

          // Liberacion de binarios. Va JUSTO aqui, y no repetida en cada rama de
          // salida, porque este punto domina las tres que siguen —`halt`, nodo
          // terminal y transicion normal— y todas ellas persisten el checkpoint
          // leyendo `context.getAllContext()`. Una sola sentencia y ninguna ruta
          // se escapa.
          this.releaseAttachmentBinaries(context, result);

          // --- Parada ordenada pedida por el propio nodo. Va ANTES de mirar
          // `nextStep`: el disparador no encontro nada que procesar, asi que los
          // pasos siguientes no tienen entrada y ejecutarlos solo produciria un
          // fallo de interpolacion sobre un namespace incompleto.
          //
          // Anular el cursor en vez de terminar aqui reutiliza el cierre EXITOSO
          // de la salida del bucle, que es el mismo punto donde termina un flujo
          // que agota su grafo: una sola escritura del checkpoint final.
          //
          // El namespace ya escrito se conserva a proposito —lleva el motivo que
          // devolvio la estrategia— para que la trazabilidad explique por que la
          // ejecucion termino en un unico paso.
          if (result.halt !== undefined) {
            this.logger.log(
              `ejecucion=${executionId} | Nodo "${node.nodeId}" detiene el flujo: ${result.halt.reason}`,
            );
            // Marca TRANSITORIA, no columna: es lo unico que distingue esta
            // salida de la del nodo terminal, porque ambas dejan la fila en
            // EXITOSO con el cursor nulo. Quien despacha la lee para no tratar
            // un "no habia nada que hacer" como un trabajo completado.
            execution.haltReason = result.halt.reason;
            cursor = null;
            break;
          }

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

        const errorCode = result.error?.code ?? ERR_NODE_CRASHED;

        this.logger.warn(
          `${result.error?.level ?? 'URGENTE'} | ${errorCode} | ejecucion=${executionId} | Nodo "${node.nodeId}": ${result.error?.message ?? 'fallo sin detalle'}`,
        );

        // --- 1. Ruta de recuperacion declarada. Va PRIMERO, incluso antes del
        // cierre por LEVE de abajo: un `catchErrors` que menciona este codigo es
        // una decision explicita del disenador del flujo, y el cierre por
        // severidad es solo el comportamiento por defecto. Al reves, una ruta
        // declarada para un codigo LEVE no se dispararia jamas, y el sintoma
        // —un nodo de respaldo que nunca corre— seria mudo.
        const errorRoute = resolveErrorRoute(node.onErrorStep, errorCode);

        if (errorRoute !== null) {
          cursor = errorRoute.targetNode;
          context.setCursor(cursor);

          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.EN_PROCESO,
            activeCursor: cursor,
            contextPayload: context.getAllContext(),
            retryState,
          });
          continue;
        }

        // --- 2. Un LEVE no pausa: cierra.
        //
        // Pausar reserva el cursor para el reintento manual de CU-09, y una
        // incidencia transitoria no necesita a nadie: el sondeo vuelve en un
        // minuto. Sin esto, media hora de red caida deja treinta filas PAUSADO
        // —una por tick, porque PAUSADO no reserva el mutex `idx_flujo_activo`—
        // todas reclamando atencion humana que no hace falta.
        //
        // FALLIDO y no EXITOSO porque la ejecucion fallo de verdad, y la columna
        // `estado` es lo que lee despues la trazabilidad. Sin volcado forense:
        // eso lo reserva `failCatastrophically` para cuando se rompe el propio
        // ejecutor, y escribir un `.log` por minuto durante una caida seria
        // ruido que enterraria los incidentes reales.
        if (result.error?.level === 'LEVE') {
          await this.saveCheckpoint(execution, {
            currentState: ExecutionState.FALLIDO,
            // Sin cursor: no hay nada que reanudar, y dejarlo puesto ofreceria
            // un reintento manual sobre un fallo que se reintenta solo.
            activeCursor: null,
            contextPayload: context.getAllContext(),
            retryState,
            failureReason: truncateFailureReason(result.error.message),
          });
          break;
        }

        // --- 3. Sin ruta de recuperacion: se detiene conservando el cursor
        // culpable, que es lo que permite el reintento manual de CU-09.
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
    } finally {
      // El bucle ya no existe: mantener la marca solo serviria para abortar por
      // sorpresa un reintento futuro de esta misma ejecucion.
      this.abortedExecutions.delete(executionId);
    }

    return execution;
  }

  /**
   * Comprueba si esta ejecucion fue abortada y, de serlo, deja la entidad en
   * memoria coherente con la fila que ya escribio `abortExecutionsForFlow`.
   *
   * NO persiste nada, y ese es el punto entero: la fila ya dice FALLIDO, asi que
   * cualquier escritura desde aqui solo podria estropearlo. Lo que si hace falta
   * es el `Object.assign` implicito —`update()` masivo no refresca la instancia
   * cargada—, o el llamante recibiria una entidad que sigue anunciando
   * EN_PROCESO sobre una fila que ya no lo esta.
   *
   * @returns `true` si el bucle debe abandonar.
   */
  private consumeAbortMark(execution: FsmExecution, cursor: string): boolean {
    const reason = this.abortedExecutions.get(execution.executionId);

    if (reason === undefined) {
      return false;
    }

    this.abortedExecutions.delete(execution.executionId);

    // Sin `saveCheckpoint`: `abortExecutionsForFlow` ya dejo la fila en FALLIDO
    // y escribir aqui solo podria estropearlo. Esto replica en memoria lo que la
    // base de datos ya sabe, porque un `update()` masivo no refresca la
    // instancia cargada y el llamante recibiria una entidad que miente.
    execution.currentState = ExecutionState.FALLIDO;
    execution.failureReason = reason;
    execution.activeCursor = cursor;

    this.logger.warn(
      `Ejecucion "${execution.executionId}" abortada en "${cursor}": ${reason}. El bucle se detiene sin escribir checkpoint.`,
    );

    return true;
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
   * Registra el desenlace de una invocacion de nodo en el logger hibrido.
   *
   * Traduce el vocabulario del motor al de la tabla: `enum_estado_nodo` tiene
   * tres valores y el motor maneja severidades. `ADVERTENCIA` para el LEVE no es
   * cosmetico —es el fallo que cierra sin pausar porque se reintenta solo—, y
   * quien lea la traza tiene que poder distinguirlo de un `ERROR` que espera a
   * alguien.
   *
   * El `await` es deliberado aunque anada un viaje por nodo: el metodo no lanza
   * nunca, asi que esperar no arriesga nada, y lanzarlo sin esperar dejaria
   * rechazos sin manejar y filas escritas fuera de orden.
   */
  /**
   * Libera el base64 de los adjuntos en cuanto hay texto que los sustituya.
   *
   * REGLA: el binario se conserva si y solo si sigue siendo la unica fuente de
   * datos. Mientras ningun nodo haya extraido texto —el caso del PDF escaneado,
   * que espera a un nodo multimodal— los bytes se quedan. En cuanto alguno
   * produce `clean_body`, `text` o `extracted_text` con contenido, el binario es
   * peso muerto que se arrastraria por el heap de V8 y, sobre todo, se
   * reserializaria ENTERO en cada checkpoint posterior.
   *
   * Vive en el motor y no en los nodos por dos razones. La primera es que un
   * nodo que escribe en un namespace ajeno rompe "un nodo, un namespace" y
   * obliga a cada estrategia futura a acordarse de purgar. La segunda es que asi
   * la regla se aplica aunque el flujo no tenga un `PARSER_PRE_IA`: basta con
   * que CUALQUIER nodo declare texto.
   *
   * Efecto util en el caso comun: el propio `TRIGGER_IMAP` emite `text`, asi que
   * un correo con cuerpo textual ve sus adjuntos liberados en el MISMO
   * checkpoint que los escribio por primera vez, y el base64 no llega a tocar
   * PostgreSQL.
   */
  /** Umbral de texto util, resuelto una sola vez por instancia. */
  private get minUsefulTextLength(): number {
    this.cachedMinUsefulTextLength ??= this.resolveMinUsefulTextLength();

    return this.cachedMinUsefulTextLength;
  }

  /**
   * Lee `FSM_MIN_USEFUL_TEXT_LENGTH` y cae al valor por defecto si no sirve.
   *
   * Se admite el `0` explicito —restaura el comportamiento anterior, en el que
   * cualquier texto no vacio purgaba— pero se rechaza lo que no sea un entero no
   * negativo. Un valor absurdo no puede decidir en silencio si se destruye el
   * unico contenido de un correo.
   */
  private resolveMinUsefulTextLength(): number {
    const raw = this.configService.get<string>(MIN_USEFUL_TEXT_LENGTH_KEY);

    if (raw === undefined || raw === '') {
      return DEFAULT_MIN_USEFUL_TEXT_LENGTH;
    }

    const parsed = Number(raw);

    if (!Number.isInteger(parsed) || parsed < 0) {
      this.logger.warn(
        `${MIN_USEFUL_TEXT_LENGTH_KEY}="${raw}" no es un entero no negativo; se usara ${DEFAULT_MIN_USEFUL_TEXT_LENGTH}.`,
      );

      return DEFAULT_MIN_USEFUL_TEXT_LENGTH;
    }

    return parsed;
  }

  private releaseAttachmentBinaries(
    context: StatePayloadContext,
    result: NodeResult,
  ): void {
    // El veto va PRIMERO y gana sobre el texto. La asimetria es deliberada: el
    // texto es la afirmacion "el binario ya sobra"; la bandera es la afirmacion
    // contraria, y cuando llegan juntas manda la conservadora. El coste de
    // equivocarse no es simetrico —un binario no liberado pesa unos bytes en una
    // fila; uno liberado de mas destruye la UNICA copia del dato, y el
    // checkpoint ya esta escrito: no hay vuelta atras.
    if (vetoesBinaryRelease(result.data)) {
      return;
    }

    if (!hasUsefulText(result.data, this.minUsefulTextLength)) {
      return;
    }

    const attachments = pendingAttachmentsOf(
      context.getNamespace(RAW_EMAIL_NAMESPACE),
    );

    if (attachments === null) {
      return;
    }

    // `setNamespace` fusiona por clave de primer nivel, de modo que reescribir
    // `attachments` reemplaza el arreglo entero y deja intactas las claves
    // planas del correo (`message_id`, `from`, `subject`, `text`, `html`,
    // `date`). Es la razon por la que ese payload tenia que quedarse plano.
    context.setNamespace(RAW_EMAIL_NAMESPACE, {
      [ATTACHMENTS_KEY]: attachments.map((attachment) =>
        withReplacedBinaryContent(attachment, null),
      ),
    });
  }

  /**
   * Sustituye el base64 de los adjuntos por una marca antes de trazar el nodo.
   *
   * `payloadSnapshot` se vuelca al archivo `execution-*.log`, que rota por
   * tamano: sin esto, una sola ejecucion con un adjunto de 5 MiB escribiria
   * ~6,8 MB de una sola linea y agotaria la rotacion de golpe, llevandose por
   * delante la traza de todo lo demas.
   *
   * Se sustituye por una marca legible en vez de `null` porque en un log
   * forense importa distinguir "aqui habia bytes que no se han escrito" de "este
   * adjunto ya venia sin contenido".
   */
  private redactSnapshotBinaries(
    data: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (data === undefined) {
      return undefined;
    }

    const attachments = data[ATTACHMENTS_KEY];

    if (!Array.isArray(attachments) || !attachments.some(holdsBinaryContent)) {
      return data;
    }

    return {
      ...data,
      [ATTACHMENTS_KEY]: attachments.map((attachment) =>
        withReplacedBinaryContent(attachment, REDACTED_BINARY_PLACEHOLDER),
      ),
    };
  }

  private async logNodeOutcome(
    executionId: string,
    node: PipelineNodeConfigDto,
    outcome: NodeOutcome,
    durationMs: number,
  ): Promise<void> {
    const { result } = outcome;
    const failure = result.error;

    const status = result.success
      ? NodeLogStatus.OK
      : failure?.level === 'LEVE'
        ? NodeLogStatus.ADVERTENCIA
        : NodeLogStatus.ERROR;

    // El mensaje personalizado de la ruta de error gana al del fallo cuando esa
    // ruta atrapa ESTE codigo. Se resuelve por codigo y no por intento: describe
    // una CLASE de error, asi que aplicarlo solo al ultimo intento dejaria una
    // serie ilegible, con el texto real en los cinco primeros y el personalizado
    // en el sexto.
    const customMessage =
      failure === undefined
        ? null
        : (resolveErrorRoute(node.onErrorStep, failure.code)?.customMessage ??
          null);

    // Guarda de contingencia, ADEMAS de la que el propio logger ya tiene. No es
    // redundancia ociosa: la traza es best-effort por definicion, y un flujo no
    // puede caerse porque no se pudo anotar que funciono. Sin esto, cualquier
    // cambio futuro que hiciera lanzar al logger convertiria el registro en un
    // punto unico de fallo del motor.
    try {
      await this.hybridLogger.logNodeExecution({
        executionId,
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status,
        severity: failure?.level,
        errorCode: failure?.code,
        message: customMessage ?? failure?.message,
        stackTrace: failure?.stackTrace,
        durationMs,
        payloadSnapshot: this.redactSnapshotBinaries(result.data),
      });
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo registrar la traza del nodo "${node.nodeId}" (ejecucion=${executionId}): ${this.describeError(error)}`,
      );
    }
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
            code: ERR_NODE_CRASHED,
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
        error: {
          level: 'GRAVE',
          code: ERR_STRATEGY_NOT_FOUND,
          message: this.describeError(error),
        },
      };
    }

    if (error instanceof HttpException) {
      return {
        success: false,
        error: {
          level: 'GRAVE',
          code: ERR_NODE_HTTP_FAILURE,
          message: this.describeError(error),
        },
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
