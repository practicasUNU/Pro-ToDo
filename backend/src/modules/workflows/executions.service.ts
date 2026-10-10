import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { Workflow } from '@modules/workflows/entities/workflow.entity';

import {
  DEFAULT_PAGE_LIMIT,
  ListExecutionsQueryDto,
} from './dto/list-executions-query.dto';
import { requirePipelineSchema } from './validators/require-pipeline-schema.validator';

import type { ExecutionDetailResponseDto } from './dto/execution-detail-response.dto';
import type {
  ExecutionPageResponseDto,
  ExecutionSummaryResponseDto,
} from './dto/execution-summary-response.dto';
import type { ResumeExecutionDto } from './dto/resume-execution.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { Repository } from 'typeorm';

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
  ) {}

  /** Pagina de ejecuciones, de la mas reciente a la mas antigua. */
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
    });

    return {
      items: items.map((execution) => this.toSummary(execution)),
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
      ...this.toSummary(execution),
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
   * @throws NotFoundException Si no existe la ejecucion o su flujo.
   * @throws ConflictException Si no esta PAUSADO o perdio el cursor.
   * @throws BadRequestException Si el esquema ya no es valido o el cursor
   *         apunta a un nodo que se borro.
   * @throws SystemCapacityExceededException Si el motor esta saturado (429).
   */
  public async resumeExecution(
    executionId: string,
    resumeExecutionDto: ResumeExecutionDto,
    userId: string,
  ): Promise<WorkflowExecutionResponseDto> {
    const execution = await this.requireExecution(executionId);

    // Un 409 y no un 400: la peticion esta bien formada y el recurso existe; lo
    // que no encaja es su estado. El estado real va en el mensaje porque es la
    // unica forma de que el operador sepa si llego tarde (ya se reanudo) o si
    // esta mirando la ejecucion equivocada.
    if (execution.currentState !== ExecutionState.PAUSADO) {
      throw new ConflictException(
        `La ejecucion "${executionId}" esta en estado ${execution.currentState} y solo se puede reanudar una PAUSADO.`,
      );
    }

    // Defensivo: `pauseAt` siempre escribe el cursor, asi que llegar aqui sin el
    // significa que alguien toco la fila por SQL. Sin cursor no hay desde donde
    // reanudar, y dejarlo pasar arrancaria el flujo desde el principio
    // repitiendo trabajo ya hecho.
    if (execution.activeCursor === null) {
      throw new ConflictException(
        `La ejecucion "${executionId}" esta PAUSADO pero no conserva el paso en el que se detuvo: no hay desde donde reanudarla.`,
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

    // La reanudacion entra al motor por `executeWorkflow` y no por
    // `createExecution`, asi que la guarda de saturacion no se aplicaria sola.
    // Sin esta llamada, cada reintento manual sumaria una ejecucion por encima
    // del techo global y la barrera dejaria de significar lo que dice.
    await this.fsmEngineService.assertGlobalCapacityAvailable();

    await this.fsmEngineService.prepareResume(
      executionId,
      resumeExecutionDto.contextPatch,
      resumeExecutionDto.resetRetries ?? true,
    );

    this.logger.log(
      `Reanudacion manual (CU-09) del flujo "${workflow.name}" (${workflow.id}) desde el nodo "${execution.activeCursor}" | ejecucion=${executionId} | usuario=${userId}`,
    );

    // Sin `skipNodeTypes` ni `initialPayload`: el disparador ya corrio en el
    // intento original y su salida esta en el contexto acumulado. Volver a
    // sembrar el namespace `trigger` pisaria datos reales con un fixture.
    const finished = await this.fsmEngineService.executeWorkflow(
      executionId,
      schema,
      { flowName: workflow.name },
    );

    return {
      executionId: finished.executionId,
      workflowId: workflow.id,
      status: finished.currentState,
      activeCursor: finished.activeCursor,
      context: finished.contextPayload,
    };
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
  private toSummary(execution: FsmExecution): ExecutionSummaryResponseDto {
    return {
      executionId: execution.executionId,
      flowId: execution.flowId,
      state: execution.currentState,
      activeCursor: execution.activeCursor,
      logFilePath: execution.logFilePath,
      failureReason: execution.failureReason,
      startedAt: execution.createdAt.toISOString(),
      updatedAt: execution.updatedAt.toISOString(),
    };
  }
}
