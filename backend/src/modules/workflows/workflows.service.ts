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

import type {
  PipelineStepDto,
  PipelineSummaryResponseDto,
} from './dto/pipeline-summary-response.dto';
import type { RunWorkflowTestDto } from './dto/run-workflow-test.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';
import type {
  PipelineNodeConfig,
  PipelineSchema,
} from '@core/fsm/types/pipeline-schema.types';
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
   * @throws ConflictException Por dos vias distintas: la guarda de cupo de
   *         `createExecution`, o la perdida de la carrera contra el mutex
   *         `idx_flujo_activo` ya dentro de `executeWorkflow` (RNF-09).
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
   * Dispara un flujo desde un disparador AUTOMATICO (Cron, IMAP).
   *
   * Se diferencia de `runWorkflowTest` en dos puntos, y por eso es un metodo
   * aparte en vez de una bandera:
   *
   * 1. EXIGE `activo = true`. La columna existe precisamente para gobernar los
   *    disparadores automaticos; el Camino B la ignora a proposito para poder
   *    probar un flujo antes de habilitarlo.
   * 2. NO siembra `initialPayload`. El contexto lo aporta el propio nodo
   *    disparador (`TRIGGER_IMAP` escribe el correo en su `outputNamespace`),
   *    asi que el namespace reservado `trigger` queda sin usar en este camino.
   *
   * @param flowId Identificador de la fila de `flujos`.
   * @returns El identificador de la ejecucion que quedo registrada.
   * @throws NotFoundException Si el flujo no existe.
   * @throws BadRequestException Si esta desactivado o no tiene esquema integro.
   * @throws ConflictException Si el flujo ya tiene una instancia EN_PROCESO
   *         (RNF-09). Quien sondea debe tratarlo como condicion normal.
   */
  public async runAutomaticWorkflow(flowId: string): Promise<string> {
    const workflow = await this.findOne(flowId);

    if (!workflow.active) {
      throw new BadRequestException(
        `El flujo "${workflow.name}" (${workflow.id}) esta desactivado: los disparadores automaticos no deben ejecutarlo.`,
      );
    }

    const schema = await this.pipelineValidatorService.validateSchema(
      this.requirePipelineSchema(workflow),
    );

    const execution = await this.fsmEngineService.createExecution(
      workflow.id,
      {},
    );

    this.logger.log(
      `Despacho automatico del flujo "${workflow.name}" (${workflow.id}) | ejecucion=${execution.executionId}`,
    );

    const finished = await this.fsmEngineService.executeWorkflow(
      execution.executionId,
      schema,
    );

    return finished.executionId;
  }

  /**
   * Flujos utilizables como plantilla en el asistente, con su topologia ordenada.
   *
   * Se filtran los que no tienen `configuracion_pipeline`: un flujo a medio
   * crear no sirve como plantilla de la que partir, y el asistente no tendria
   * pasos que mostrar.
   *
   * NO se revalida el esquema con `PipelineValidatorService`. Es un listado de
   * lectura, no un despacho: un esquema corrupto debe poder verse en la interfaz
   * para que alguien lo corrija, no desaparecer del catalogo. La revalidacion
   * sigue ocurriendo donde importa, al ejecutar.
   */
  public async findSelectablePipelines(): Promise<
    PipelineSummaryResponseDto[]
  > {
    const workflows = await this.workflowRepository.find({
      order: { createdAt: 'DESC' },
    });

    return workflows
      .filter((workflow) => workflow.pipelineSchema !== null)
      .map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        active: workflow.active,
        // El `!` es seguro: el `filter` de arriba ya descarto los nulos.
        topology: this.buildOrderedTopology(workflow.pipelineSchema!),
      }));
  }

  /**
   * Proyecta un `pipeline_schema` a la secuencia de pasos EN ORDEN DE EJECUCION.
   *
   * El orden NO puede salir de `Object.values(schema.nodes)`: ese mapa esta
   * indexado por `nodeId` y sus claves conservan el orden de escritura del JSON,
   * que no tiene por que coincidir con el camino de ejecucion. Un esquema
   * guardado con los nodos en cualquier orden pintaria un stepper desordenado.
   * Asi que se recorre el grafo desde `entrypoint` siguiendo `nextStep`.
   *
   * El `Set` de visitados no es defensa contra un esquema valido:
   * `validatePipelineTopology` ya garantiza que el camino activo es aciclico y
   * termina en un nodo terminal. Cubre el caso de una fila escrita por SQL
   * directo, que se salta esa validacion — sin el, un `nextStep` circular
   * colgaria la peticion HTTP en un bucle infinito.
   *
   * Un puntero huerfano (apunta a un nodo que no existe) corta el recorrido en
   * silencio y devuelve lo acumulado: es un esquema roto, pero el catalogo debe
   * seguir respondiendo para que el operador pueda verlo y arreglarlo.
   */
  private buildOrderedTopology(schema: PipelineSchema): PipelineStepDto[] {
    const steps: PipelineStepDto[] = [];
    const visited = new Set<string>();

    let cursor: string | null = schema.entrypoint;

    while (cursor !== null && !visited.has(cursor)) {
      // Anotacion explicita obligada: `cursor` se reasigna desde `node.nextStep`,
      // asi que sin ella TypeScript entra en inferencia circular (TS7022).
      const node: PipelineNodeConfig | undefined = schema.nodes[cursor];

      if (node === undefined) {
        this.logger.warn(
          `El flujo "${schema.flowId}" apunta al nodo inexistente "${cursor}": la topologia se truncara ahi.`,
        );
        break;
      }

      visited.add(cursor);
      steps.push({
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        outputNamespace: node.outputNamespace,
      });

      cursor = node.nextStep;
    }

    return steps;
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
