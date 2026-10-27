import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CACHED_EXTRACTION_NODE_TYPES,
  FsmEngineService,
} from '@core/fsm/services/fsm-engine.service';
import { ExecutionEventsCoordinator } from '@common/services/execution-events.coordinator';
import { resolveSort } from '@common/utils/sort-whitelist.util';
import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { AlertQueryService } from '@modules/logs/services/alert-query.service';
import { HybridLoggerService } from '@modules/logs/services/hybrid-logger.service';
import { NodeLogStatus } from '@modules/logs/entities/log-nodo.entity';
import { Workflow } from '@modules/workflows/entities/workflow.entity';
import { WorkflowsService } from '@modules/workflows/workflows.service';

import {
  DEFAULT_PAGE_LIMIT,
  EXECUTION_SORT_COLUMNS,
  ListExecutionsQueryDto,
} from './dto/list-executions-query.dto';
import { requirePipelineSchema } from './validators/require-pipeline-schema.validator';

import type { DiscardExecutionResponseDto } from './dto/discard-execution-response.dto';
import type { ExecutionDetailResponseDto } from './dto/execution-detail-response.dto';
import type {
  ExecutionPageResponseDto,
  ExecutionSummaryResponseDto,
} from './dto/execution-summary-response.dto';
import type { ResumeExecutionDto } from './dto/resume-execution.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { AuthenticatedUser } from '@modules/auth/interfaces/jwt-payload.interface';
import type { PipelineSchemaDto } from '@core/fsm/dto/pipeline-schema.dto';
import type { Repository } from 'typeorm';
import type { DiscardAuditContext } from '@modules/workflows/workflows.service';

/** Lo que el controlador aporta al evento `FLUJO_DESCARTADO`. */
type DiscardAuditInput = Pick<DiscardAuditContext, 'reason' | 'sourceIp'>;

/**
 * Consulta de ejecuciones y reintento manual (CU-09).
 *
 * Vive en `WorkflowsModule` y no en `FsmModule` porque reanudar necesita la fila
 * de `flujos` —su esquema y su nombre— y `@core` no puede importar de
 * `@modules`. Este modulo ya posee el repositorio de `Workflow` y ya importa el
 * motor, asi que no hay nada que cablear.
 *
 * Servicio aparte de `WorkflowsService`: aquel ronda las 600 lineas y mezcla
 * alta, edicion, asistente y despacho. Leer ejecuciones y desatascar una es un
 * dominio distinto.
 */
@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    private readonly fsmExecutionQueryService: FsmExecutionQueryService,
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly pipelineValidatorService: PipelineValidatorService,
    private readonly fsmEngineService: FsmEngineService,
    private readonly executionEvents: ExecutionEventsCoordinator,
    private readonly workflowsService: WorkflowsService,
    private readonly hybridLoggerService: HybridLoggerService,
    // Marca `hasAlerts` del listado: una consulta por pagina, no por fila.
    private readonly alertQueryService: AlertQueryService,
  ) {}

  /**
   * Pagina de ejecuciones. Por defecto, de la mas reciente a la mas antigua;
   * `sortBy`/`sortOrder` reordenan el historial ENTERO en el servidor, no solo
   * la pagina visible.
   */
  public async findAll(
    query: ListExecutionsQueryDto,
  ): Promise<ExecutionPageResponseDto> {
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = query.offset ?? 0;

    const { items, total } = await this.fsmExecutionQueryService.findPage({
      flowId: query.flowId,
      state: query.state,
      limit,
      offset,
      sort: resolveSort(EXECUTION_SORT_COLUMNS, query.sortBy, query.sortOrder, {
        key: 'startedAt',
        order: 'DESC',
      }),
    });

    const withAlerts = await this.alertQueryService.findExecutionIdsWithAlerts(
      items.map((execution) => execution.executionId),
    );

    return {
      items: items.map((execution) =>
        this.toSummary(execution, withAlerts.has(execution.executionId)),
      ),
      total,
      limit,
      offset,
    };
  }

  /**
   * Ejecucion completa, con su checkpoint.
   *
   * @throws NotFoundException Si no existe.
   */
  public async findOne(
    executionId: string,
  ): Promise<ExecutionDetailResponseDto> {
    const execution = await this.requireExecution(executionId);

    return {
      ...(await this.toSummaryWithAlerts(execution)),
      context: execution.contextPayload,
      retryState: execution.retryState,
    };
  }

  /**
   * Reintento manual de una ejecucion detenida (CU-09).
   *
   * Reutiliza la MISMA fila: el motor arranca en `execution.activeCursor` y
   * `buildContext` restaura los namespaces ya publicados, de modo que los nodos
   * que completaron no se repiten. Por eso no se llama a `createExecution` y el
   * historico no crece con cada intento.
   *
   * NO EXIGE `workflow.active`, y la asimetria con `runAutomaticWorkflow` es
   * deliberada: esa columna gobierna los DISPARADORES automaticos, mientras que
   * esto es una accion manual sobre una ejecucion que ya existe. Es el mismo
   * criterio que aplica el banco de pruebas, y lo refrenda la decision de
   * `updateWorkflow` de no abortar las PAUSADO al desactivar un flujo: son la
   * cola de reintento y sobreviven a proposito. Quien «arregle» esto algun dia
   * dejara sin salida a las ejecuciones de todo flujo apagado.
   *
   * TAMPOCO comprueba los modelos de pago. El control de
   * `assertModelPermissions` vive en el alta y la edicion del flujo, que es
   * donde se ELIGE el modelo; el despacho automatico tampoco lo repite, asi que
   * aplicarlo solo aqui dejaria a un EDITOR sin poder desatascar un flujo que
   * configuro un ADMIN.
   *
   * ADMITE TAMBIEN `FALLIDO`, y es un cambio de criterio deliberado. Hasta
   * ahora solo se reanudaba una PAUSADO porque FALLIDO significaba "el ejecutor
   * lanzo una excepcion no controlada y repetirlo dara lo mismo". Eso dejaba sin
   * salida a las dos vias que llevan ahi sin que el nodo sea irreparable: el
   * cierre en cascada de `abortExecutionsForFlow` al desactivar un flujo, y un
   * fallo catastrofico cuya causa era del entorno —PostgreSQL caido, un binario
   * de OCR ausente— y no del codigo. Ahora el operador decide: si la causa
   * persiste, la reanudacion volvera a fallar y la fila lo dira igual.
   *
   * El estado se limpia al entrar: `prepareResume` borra `error_context` y
   * `motivo_fallo`, y `executeWorkflow` marca la fila EN_PROCESO.
   *
   * @throws NotFoundException Si no existe la ejecucion o su flujo.
   * @throws ConflictException Si no esta PAUSADO ni FALLIDO, o perdio el cursor.
   * @throws BadRequestException Si el esquema ya no es valido o el cursor
   *         apunta a un nodo que se borro.
   * @throws SystemCapacityExceededException Si el motor esta saturado (429).
   */
  public async resumeExecution(
    executionId: string,
    resumeExecutionDto: ResumeExecutionDto,
    user: AuthenticatedUser,
    options: {
      readonly isEmailResume?: boolean;
      /** IP de la peticion HTTP; ausente cuando la orden llega por correo. */
      readonly sourceIp?: string | null;
    } = {},
  ): Promise<WorkflowExecutionResponseDto> {
    const execution = await this.requireExecution(executionId);

    // Un 409 y no un 400: la peticion esta bien formada y el recurso existe; lo
    // que no encaja es su estado. El estado real va en el mensaje porque es la
    // unica forma de que el operador sepa si llego tarde (ya se reanudo) o si
    // esta mirando la ejecucion equivocada.
    if (
      execution.currentState !== ExecutionState.PAUSADO &&
      execution.currentState !== ExecutionState.FALLIDO
    ) {
      throw new ConflictException(
        `La ejecucion "${executionId}" esta en estado ${execution.currentState} y solo se puede reanudar una PAUSADO o FALLIDO.`,
      );
    }

    // Defensivo: tanto `pauseAt` como `failCatastrophically` escriben el cursor
    // —aquella por diseno de CU-09, esta porque saber donde se rompio es la
    // mitad del diagnostico—, asi que llegar aqui sin el significa que alguien
    // toco la fila por SQL. Sin cursor no hay desde donde reanudar, y dejarlo
    // pasar arrancaria el flujo desde el principio repitiendo trabajo ya hecho.
    if (execution.activeCursor === null) {
      throw new ConflictException(
        `La ejecucion "${executionId}" esta en estado ${execution.currentState} pero no conserva el paso en el que se detuvo: no hay desde donde reanudarla.`,
      );
    }

    const workflow = await this.workflowRepository.findOne({
      where: { id: execution.flowId },
    });

    if (workflow === null) {
      throw new NotFoundException(
        `El flujo "${execution.flowId}" que origino la ejecucion "${executionId}" ya no existe.`,
      );
    }

    // Se revalida en cada reanudacion por el mismo motivo que en el despacho:
    // la columna JSONB se puede haber escrito por SQL directo, y el motor
    // recorre el grafo sin defensas en cada paso.
    const schema = await this.pipelineValidatorService.validateSchema(
      requirePipelineSchema(workflow),
    );

    // GUARDA CRITICA Y NADA OBVIA. Si alguien edito el flujo mientras la
    // ejecucion estaba pausada, el cursor puede apuntar a un nodo que ya no
    // existe. Sin esto, `executeWorkflow` cae en su propia guarda de "cursor
    // inexistente", vuelve a pausar en el mismo sitio y devuelve un 200 que no
    // ha hecho absolutamente nada: el operador pulsaria Reanudar diez veces sin
    // entender por que no avanza.
    if (schema.nodes[execution.activeCursor] === undefined) {
      throw new BadRequestException(
        `El nodo "${execution.activeCursor}" en el que se detuvo la ejecucion "${executionId}" ya no existe en el esquema del flujo "${workflow.name}": lanza una ejecucion nueva en su lugar.`,
      );
    }

    // Reanudacion SELECTIVA (CU-09 extendido): el operador eligio otro paso en
    // el canvas. Se valida aqui y no en el motor porque es aqui donde estan a
    // la vez el esquema y el contexto acumulado, que son las dos cosas que hay
    // que cruzar para responder "ese paso llego a ejecutarse".
    const resumeCursor = this.resolveResumeCursor(
      execution,
      schema,
      workflow,
      resumeExecutionDto.targetStepId,
    );

    // La reanudacion entra al motor por `executeWorkflow` y no por
    // `createExecution`, asi que la guarda de saturacion no se aplicaria sola.
    // Sin esta llamada, cada reintento manual sumaria una ejecucion por encima
    // del techo global y la barrera dejaria de significar lo que dice.
    await this.fsmEngineService.assertGlobalCapacityAvailable();

    // El nodo de reanudacion ANTES de que el motor purgue: hace falta saber si
    // conserva una extraccion cara para decidir si ademas se omite su
    // reejecucion, y despues de `prepareResume` el contexto ya esta reescrito.
    const resumeNode = schema.nodes[resumeCursor];
    const preservesCachedExtraction =
      resumeNode !== undefined &&
      CACHED_EXTRACTION_NODE_TYPES.has(resumeNode.nodeType) &&
      Object.keys(
        (execution.contextPayload ?? {})[resumeNode.outputNamespace] ?? {},
      ).length > 0;

    await this.fsmEngineService.prepareResume(
      executionId,
      resumeExecutionDto.contextPatch,
      resumeExecutionDto.resetRetries ?? true,
      resumeCursor,
      // Habilita la purga selectiva: sin el grafo el motor no sabe que pasos
      // vienen despues del cursor y conserva el contexto entero.
      schema,
    );

    // Marca de demarcacion en la trazabilidad. Reanudar NO borra ni invalida
    // las filas del intento anterior —son la evidencia que CU-09 existe para
    // conservar—, asi que los nodos que se reejecuten van a dejar filas nuevas
    // junto a las viejas. Sin esta linea, las dos tandas quedarian mezcladas y
    // solo las separaria la marca de tiempo; con ella, el historial dice donde
    // empieza cada intento.
    //
    // Es ADVERTENCIA y no OK: no describe un nodo que funciono, sino una
    // intervencion manual sobre una ejecucion detenida, que es justo lo que un
    // auditor querria ver resaltado.
    await this.hybridLoggerService.logNodeExecution({
      executionId,
      nodeId: resumeCursor,
      nodeType: schema.nodes[resumeCursor]?.nodeType ?? null,
      status: NodeLogStatus.ADVERTENCIA,
      message:
        resumeCursor === execution.activeCursor
          ? `Reanudacion manual (CU-09) desde el paso en que se detuvo: "${resumeCursor}".`
          : `Reanudacion manual (CU-09) desde un paso elegido por el operador: "${resumeCursor}" (se habia detenido en "${execution.activeCursor}").`,
    });

    // El flujo vuelve a estar armado: la pausa que lo saco de los disparadores
    // la escribio el motor al detener ESTA ejecucion, y reanudarla la deshace.
    //
    // SOLO desde PAUSADO. Un flujo INACTIVO se queda INACTIVO: reanudar no
    // exige el flujo armado —asi lo declara el TSDoc de este metodo— y
    // activarlo aqui habilitaria sus disparadores sin que nadie lo pidiera,
    // justo en el flujo que alguien habia retirado a mano.
    await this.workflowsService.reactivateAfterResume(workflow.id, {
      actorId: user.id,
      executionId,
      sourceIp: options.sourceIp ?? null,
    });

    this.logger.log(
      `Reanudacion manual (CU-09) del flujo "${workflow.name}" (${workflow.id}) desde el nodo "${resumeCursor}" | ejecucion=${executionId} | usuario=${user.email} (${user.id})${options.isEmailResume === true ? ' | via correo entrante' : ''}`,
    );

    // ANTES de entrar al motor, y el orden es observable: `executeWorkflow` es
    // bloqueante hasta que el flujo termina o vuelve a pausarse. Emitido
    // despues, el cliente recibiria "reanudado" DETRAS del "pausado" del
    // siguiente fallo, y la interfaz pintaria como viva una ejecucion que
    // acaba de detenerse otra vez.
    this.executionEvents.emitFlowResumed({
      executionId,
      flowId: execution.flowId,
      emittedAt: new Date().toISOString(),
      // El cursor EFECTIVO, que con una reanudacion selectiva no es el que
      // detuvo la ejecucion: el cliente pinta el nodo activo leyendo esto.
      activeCursor: resumeCursor,
      resumedBy: { id: user.id, email: user.email },
      // El nodo donde estaba detenida. El cliente lo necesita para borrar su
      // marca de pausa: con una reanudacion selectiva deja de ser el cursor, y
      // nadie mas volveria a tocarlo.
      previousCursor: execution.activeCursor,
      ...(resumeExecutionDto.targetStepId !== undefined
        ? { targetStepId: resumeCursor }
        : {}),
      ...(options.isEmailResume === true ? { isEmailResume: true } : {}),
    });

    // Sin `initialPayload`: el disparador ya corrio en el intento original y su
    // salida esta en el contexto acumulado. Volver a sembrar el namespace
    // `trigger` pisaria datos reales con un fixture.
    //
    // `skipNodeTypes` SOLO para cerrar la excepcion de extraccion cara. El
    // motor acaba de conservar el namespace de este nodo en vez de purgarlo,
    // pero conservarlo no ahorra nada por si solo: el bucle arranca en el
    // cursor y volveria a ejecutarlo, sobrescribiendo con un resultado
    // identico tras pagar otra vez el MIME o la pasada multimodal. Omitirlo es
    // lo que convierte la reanudacion en el salto de uno o dos segundos hasta
    // el paso que de verdad hay que repetir.
    //
    // Es seguro porque las dos condiciones se miran juntas: el tipo esta en
    // `CACHED_EXTRACTION_NODE_TYPES` —cuya salida solo depende del correo de
    // entrada, que no cambia entre intentos— y su namespace ya trae datos. Si
    // el operador quiere rehacer la extraccion, reanuda desde el disparador.
    const finished = await this.fsmEngineService.executeWorkflow(
      executionId,
      schema,
      {
        flowName: workflow.name,
        ...(preservesCachedExtraction && resumeNode !== undefined
          ? { skipNodeTypes: [resumeNode.nodeType] }
          : {}),
      },
    );

    // La politica de corrida unica tambien alcanza a las reanudaciones. Sin
    // esta llamada, un flujo que se atasca, se reanuda y termina bien se queda
    // ACTIVO con su sondeo vivo: la autodesactivacion solo corria por el
    // despacho automatico, de modo que bastaba una intervencion manual para
    // que el flujo siguiera disparando ejecuciones que ya no debia disparar.
    //
    // Va DESPUES del motor y no antes por lo obvio —hasta que `executeWorkflow`
    // no devuelve no se sabe como termino—, y el propio metodo vuelve a leer
    // las cuatro condiciones, asi que una reanudacion que acaba PAUSADA otra
    // vez, OMITIDA o desviada por contingencia no apaga nada.
    await this.workflowsService.applyStopOnFirstSuccess(
      workflow,
      schema,
      finished,
    );

    // La reanudacion publico la fila "En proceso"; sin esta segunda foto la
    // tabla de flujos se quedaba con ese estado aunque la ejecucion ya hubiera
    // cerrado, porque el motor no difunde mutaciones CRUD al terminar.
    await this.workflowsService.publishWorkflowSnapshot(workflow.id);

    return {
      executionId: finished.executionId,
      workflowId: workflow.id,
      status: finished.currentState,
      activeCursor: finished.activeCursor,
      context: finished.contextPayload,
    };
  }

  /**
   * Decide desde que paso se reanuda, y rechaza los saltos imposibles.
   *
   * Sin `targetStepId` devuelve el cursor persistido, que es la reanudacion de
   * siempre. Con el, admite exactamente dos casos:
   *
   * 1. El propio cursor. Redundante pero legitimo: es lo que manda el canvas
   *    cuando el operador pulsa sobre el nodo que ya estaba detenido.
   * 2. Un nodo que YA SE EJECUTO, probado porque su `outputNamespace` esta
   *    escrito en el contexto acumulado.
   *
   * Lo que se rechaza, y el motivo: saltar a un paso POSTERIOR dejaria sin
   * escribir los namespaces de los pasos intermedios, y el flujo reventaria al
   * interpolarlos —con un fallo que el operador leeria como un error del motor
   * y no como la consecuencia de su eleccion—. La prueba se hace contra el
   * contexto y no contra el indice en la topologia porque esta ultima deja
   * fuera a los satelites de contingencia, que son justo donde una reanudacion
   * selectiva resulta mas util: si el OCR corrio, se puede volver a el.
   *
   * Es un 400 y no un 409: lo que no encaja es el cuerpo de la peticion.
   */
  private resolveResumeCursor(
    execution: FsmExecution,
    schema: PipelineSchemaDto,
    workflow: Workflow,
    targetStepId?: string,
  ): string {
    // `activeCursor` ya esta comprobado no nulo por la guarda de arriba.
    const persisted = execution.activeCursor as string;

    if (targetStepId === undefined || targetStepId === persisted) {
      return persisted;
    }

    const target = schema.nodes[targetStepId];

    if (target === undefined) {
      throw new BadRequestException(
        `El nodo "${targetStepId}" no existe en el esquema del flujo "${workflow.name}".`,
      );
    }

    const context = execution.contextPayload ?? {};

    if (!Object.hasOwn(context, target.outputNamespace)) {
      throw new BadRequestException(
        `No se puede reanudar desde "${targetStepId}": ese paso no llego a ejecutarse en esta ejecucion, asi que los pasos intermedios se quedarian sin contexto. Elige un paso ya recorrido o reanuda desde "${persisted}".`,
      );
    }

    return targetStepId;
  }

  /**
   * Cierre manual de una ejecucion detenida (CU-09).
   *
   * Es la segunda salida de una PAUSADO, y la contraria a `resumeExecution`:
   * cuando la causa de la pausa es irrecuperable —un UUID de Drupal que no
   * existe, un buzon dado de baja— reanudar solo repite el mismo fallo, y hasta
   * ahora no habia forma de cerrar la fila.
   *
   * EL ORDEN DE LOS DOS PASOS NO ES INTERCAMBIABLE. Desactivar un flujo pasa
   * por `abortExecutionsForFlow`, que arrastra `EN_PROCESO|PAUSADO` a FALLIDO;
   * si se desactivara primero, el descarte encontraria la ejecucion ya FALLIDO,
   * responderia un 409 y la fila mentiria diciendo que el motor se rindio
   * cuando lo que hubo fue una decision humana. Por eso se cierra ANTES y con
   * `deactivateAfterDiscard`, que no dispara ese cierre en cascada.
   *
   * La escritura sobre `ejecuciones_flujo` la hace el MOTOR: este servicio no
   * tiene su repositorio, y abrir una excepcion a esa regla dejaria dos duenos
   * de la misma columna.
   *
   * @throws NotFoundException Si no existe la ejecucion o su flujo.
   * @throws ConflictException Si no esta PAUSADO.
   */
  public async discardExecution(
    executionId: string,
    userId: string,
    audit: DiscardAuditInput = { reason: null, sourceIp: null },
  ): Promise<DiscardExecutionResponseDto> {
    const { execution, lastCursor } =
      await this.fsmEngineService.discardExecution(executionId, userId);

    // El motor solo descarta ejecuciones PAUSADO (409 en otro caso), asi que
    // ese es siempre el estado del que viene.
    const workflow = await this.workflowsService.deactivateAfterDiscard(
      execution.flowId,
      {
        userId,
        executionId,
        previousState: ExecutionState.PAUSADO,
        reason: audit.reason,
        sourceIp: audit.sourceIp,
      },
    );

    this.logger.log(
      `Descarte manual (CU-09) del flujo "${workflow.name}" (${workflow.id}) detenido en "${lastCursor}" | ejecucion=${executionId} | usuario=${userId}`,
    );

    // DESPUES de las dos escrituras: el evento invita a la interfaz a repintar
    // ambas filas, y emitirlo antes abriria una ventana en la que la tabla
    // muestra un flujo inactivo que PostgreSQL todavia tiene activo.
    this.executionEvents.emitFlowDiscarded({
      executionId,
      flowId: execution.flowId,
      emittedAt: new Date().toISOString(),
      discardedBy: userId,
      lastCursor,
      workflowDeactivated: true,
    });

    return { execution: await this.toSummaryWithAlerts(execution), workflow };
  }

  /**
   * Lee una ejecucion o se rinde.
   *
   * @throws NotFoundException Si no existe.
   */
  private async requireExecution(executionId: string): Promise<FsmExecution> {
    const execution = await this.fsmExecutionQueryService.findById(executionId);

    if (execution === null) {
      throw new NotFoundException(
        `No existe la ejecucion "${executionId}" en ejecuciones_flujo.`,
      );
    }

    return execution;
  }

  /**
   * Proyeccion de la entidad al contrato publico.
   *
   * Las fechas salen en ISO 8601 y no como `Date`: JSON no transporta fechas, y
   * declarar `Date` en el DTO mentiria sobre lo que recibe el cliente.
   */
  private toSummary(
    execution: FsmExecution,
    hasAlerts: boolean,
  ): ExecutionSummaryResponseDto {
    return {
      executionId: execution.executionId,
      flowId: execution.flowId,
      state: execution.currentState,
      activeCursor: execution.activeCursor,
      logFilePath: execution.logFilePath,
      failureReason: execution.failureReason,
      startedAt: execution.createdAt.toISOString(),
      updatedAt: execution.updatedAt.toISOString(),
      hasAlerts,
    };
  }

  /** `toSummary` de una sola ejecucion, resolviendo sus alertas. */
  private async toSummaryWithAlerts(
    execution: FsmExecution,
  ): Promise<ExecutionSummaryResponseDto> {
    const withAlerts = await this.alertQueryService.findExecutionIdsWithAlerts([
      execution.executionId,
    ]);

    return this.toSummary(execution, withAlerts.has(execution.executionId));
  }
}
