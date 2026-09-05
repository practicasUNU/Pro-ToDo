import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';

import { Workflow } from './entities/workflow.entity';

import type { RunWorkflowTestDto } from './dto/run-workflow-test.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import type { Repository } from 'typeorm';

/**
 * Operacion de flujos: por ahora, el despacho manual de una ejecucion.
 *
 * Es el "Camino B" de la validacion E2E del motor: dispara el pipeline completo
 * (`FsmEngineService` + `StatePayloadContext` + estrategias) sembrando a mano el
 * contexto que en produccion aportaria el nodo disparador, sin depender de que
 * llegue un correo al buzon IMAP.
 *
 * NO reimplementa nada del motor: valida el esquema con
 * `PipelineValidatorService`, delega el alta y el control de concurrencia en
 * `FsmEngineService.createExecution` y el recorrido del grafo en
 * `executeWorkflow`. Su unico trabajo propio es traducir el resultado al DTO de
 * respuesta HTTP.
 *
 * Las excepciones se propagan sin capturar: el filtro global de Nest ya traduce
 * `NotFoundException` a 404, `BadRequestException` a 400 y la
 * `ConflictException` de RNF-09 a 409, que es exactamente el contrato del
 * endpoint.
 */
@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly pipelineValidatorService: PipelineValidatorService,
    private readonly fsmEngineService: FsmEngineService,
  ) {}

  /**
   * Dispara un flujo de principio a fin y devuelve el checkpoint resultante.
   *
   * @param workflowId Identificador de la fila de `flujos`.
   * @param runWorkflowTestDto Namespaces iniciales del contexto.
   * @throws NotFoundException Si el flujo no existe.
   * @throws BadRequestException Si no tiene esquema o el esquema no es integro.
   * @throws ConflictException Si el flujo agota su cupo de instancias activas.
   */
  public async runWorkflowTest(
    workflowId: string,
    runWorkflowTestDto: RunWorkflowTestDto,
  ): Promise<WorkflowExecutionResponseDto> {
    const workflow = await this.findOne(workflowId);

    // El esquema se revalida en cada disparo aunque ya pasara el validador al
    // guardarse: la columna JSONB se puede haber escrito por SQL directo, y el
    // motor da por hecho un grafo integro para recorrerlo sin defensas en cada
    // paso (ver el TSDoc de `PipelineValidatorService`).
    const schema = await this.pipelineValidatorService.validateSchema(
      this.requirePipelineSchema(workflow),
    );

    // La guarda de concurrencia (RNF-09) vive aqui dentro: si el flujo ya tiene
    // una instancia EN_PROCESO, esto lanza 409 y no se crea fila alguna.
    const execution = await this.fsmEngineService.createExecution(
      workflow.id,
      runWorkflowTestDto.initialPayload ?? {},
    );

    this.logger.log(
      `Despacho manual del flujo "${workflow.name}" (${workflow.id}) | ejecucion=${execution.executionId}`,
    );

    // Sin `initialPayload` como tercer argumento a proposito: los namespaces ya
    // quedaron sembrados en `contexto_acumulado` por `createExecution`, y
    // `buildContext()` los restaura desde ahi. Pasarlos tambien aqui los
    // duplicaria bajo el namespace `trigger`, que ningun nodo espera.
    const finished = await this.fsmEngineService.executeWorkflow(
      execution.executionId,
      schema,
    );

    return {
      executionId: finished.executionId,
      finalState: finished.currentState,
      activeCursor: finished.activeCursor,
      context: finished.contextPayload,
    };
  }

  /**
   * Busca un flujo por su identificador.
   *
   * @throws NotFoundException Si no existe ninguna fila con ese `id_flujo`.
   */
  public async findOne(id: string): Promise<Workflow> {
    const workflow = await this.workflowRepository.findOne({ where: { id } });

    if (workflow === null) {
      throw new NotFoundException(`No existe el flujo "${id}" en flujos.`);
    }

    return workflow;
  }

  /**
   * Clausula de guarda: un flujo sin esquema no se puede despachar.
   *
   * Es un 400 y no un 404: el flujo existe, lo que falta es terminar de
   * configurarlo en el asistente.
   */
  private requirePipelineSchema(workflow: Workflow): unknown {
    if (workflow.pipelineSchema === null) {
      throw new BadRequestException(
        `El flujo "${workflow.name}" (${workflow.id}) no tiene configuracion_pipeline: complete el asistente antes de despacharlo.`,
      );
    }

    return workflow.pipelineSchema;
  }
}
