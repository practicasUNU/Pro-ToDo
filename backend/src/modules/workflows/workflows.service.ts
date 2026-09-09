import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { buildOrderedTopology } from '@core/fsm/utils/pipeline-topology.util';
import { WorkflowTemplatesService } from '@modules/workflow-templates/workflow-templates.service';

import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { DEFAULT_MOCK_NAMESPACES } from './dto/execute-test-workflow.dto';

import { Workflow } from './entities/workflow.entity';

import type { CreateWorkflowDto } from './dto/create-workflow.dto';
import type { UpdateWorkflowDto } from './dto/update-workflow.dto';
import type { PipelineSummaryResponseDto } from './dto/pipeline-summary-response.dto';
import type { WorkflowDetailResponseDto } from './dto/workflow-detail-response.dto';
import type { ExecuteTestWorkflowDto } from './dto/execute-test-workflow.dto';
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
/**
 * Tipos de nodo que el despacho de PRUEBAS no ejecuta.
 *
 * Un disparador abre una conexion real por red y escribe su propio resultado en
 * `raw_email`, pisando el `mockData` que la prueba acaba de sembrar. Omitirlo es
 * lo que hace que este camino sea reproducible y no dependa de que haya un
 * correo sin leer en el buzon.
 *
 * Solo se aplica aqui: `runAutomaticWorkflow` SI ejecuta el disparador, porque
 * es de donde saca el correo que dispara el flujo.
 */
const TEST_MODE_SKIPPED_NODE_TYPES: readonly NodeType[] = [NodeType.TRIGGER_IMAP];

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly pipelineValidatorService: PipelineValidatorService,
    private readonly fsmEngineService: FsmEngineService,
    private readonly workflowTemplatesService: WorkflowTemplatesService,
  ) {}

  /**
   * Dispara un flujo de principio a fin con datos simulados y devuelve el
   * checkpoint resultante.
   *
   * @param workflowId Identificador de la fila de `flujos`.
   * @param executeTestWorkflowDto Namespaces iniciales; si no trae `mockData`
   *        se aplica `DEFAULT_MOCK_NAMESPACES`.
   * @throws NotFoundException Si el flujo no existe.
   * @throws BadRequestException Si no tiene esquema o el esquema no es integro.
   * @throws ConflictException Por dos vias distintas: la guarda de cupo de
   *         `createExecution`, o la perdida de la carrera contra el mutex
   *         `idx_flujo_activo` ya dentro de `executeWorkflow` (RNF-09).
   */
  public async executeTest(
    workflowId: string,
    executeTestWorkflowDto: ExecuteTestWorkflowDto,
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
    // Sustitucion, no mezcla: si el operador manda `mockData` es porque quiere
    // ESE contexto exacto, y fundirlo con el fixture le colaria namespaces que
    // no pidio y que enmascararian un `missingFields` legitimo.
    const execution = await this.fsmEngineService.createExecution(
      workflow.id,
      executeTestWorkflowDto.mockData ?? DEFAULT_MOCK_NAMESPACES,
    );

    this.logger.log(
      `Despacho manual del flujo "${workflow.name}" (${workflow.id}) | ejecucion=${execution.executionId}`,
    );

    // Sin `initialPayload` en las opciones a proposito: los namespaces ya
    // quedaron sembrados en `contexto_acumulado` por `createExecution`, y
    // `buildContext()` los restaura desde ahi. Pasarlos tambien aqui los
    // duplicaria bajo el namespace `trigger`, que ningun nodo espera.
    const finished = await this.fsmEngineService.executeWorkflow(
      execution.executionId,
      schema,
      { skipNodeTypes: TEST_MODE_SKIPPED_NODE_TYPES },
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
   * Dispara un flujo desde un disparador AUTOMATICO (Cron, IMAP).
   *
   * Se diferencia de `executeTest` en tres puntos, y por eso es un metodo
   * aparte en vez de una bandera:
   *
   * 1. EXIGE `activo = true`. La columna existe precisamente para gobernar los
   *    disparadores automaticos; el Camino B la ignora a proposito para poder
   *    probar un flujo antes de habilitarlo.
   * 2. NO siembra contexto simulado. Lo aporta el propio nodo disparador
   *    (`TRIGGER_IMAP` escribe el correo en su `outputNamespace`), asi que el
   *    namespace reservado `trigger` queda sin usar en este camino.
   * 3. NO omite ningun tipo de nodo. Ejecutar el disparador de verdad es
   *    justamente el motivo de este camino; pasarle
   *    `TEST_MODE_SKIPPED_NODE_TYPES` dejaria el flujo sin datos de entrada.
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
      .map((workflow) => this.toPipelineSummary(workflow));
  }

  /**
   * Da de alta un flujo con el pipeline que ensamblo el asistente.
   *
   * El esquema se valida con `PipelineValidatorService` ANTES de tocar la base de
   * datos: la columna `configuracion_pipeline` es la unica fuente de verdad del
   * motor, y admitir ahi un grafo con un `nextStep` huerfano significaria una
   * ejecucion que revienta a mitad de camino en lugar de un 400 al guardar.
   *
   * NACE INACTIVO por defecto (`active: false`). Es una decision de seguridad,
   * no un descuido: `flujos.activo` gobierna los disparadores automaticos, y un
   * flujo recien creado que se activase solo empezaria a consumir el buzon
   * corporativo —marcando los correos como leidos— sin que nadie hubiera
   * revisado su configuracion. Activarlo es un acto deliberado posterior.
   *
   * Sobre el registro en `ImapPollingService`: NO se inyecta aqui. `NodesModule`
   * ya importa `WorkflowsModule` para despachar los flujos que el sondeo
   * detecta, asi que la dependencia inversa crearia un ciclo de modulos. El
   * sondeo recoge los flujos nuevos por reconciliacion periodica, que ademas
   * cubre casos que una notificacion puntual no ve: la edicion de un esquema ya
   * guardado o una activacion hecha por SQL directo.
   *
   * @param createWorkflowDto Nombre, descripcion y grafo del pipeline.
   * @param userId Autor, tomado del token JWT y nunca del cuerpo.
   * @throws BadRequestException Si el esquema no supera forma, tipos o topologia.
   */
  public async createWorkflow(
    createWorkflowDto: CreateWorkflowDto,
    userId: string,
  ): Promise<PipelineSummaryResponseDto> {
    // La plantilla se comprueba ANTES de validar el grafo: es una consulta
    // barata y un `templateId` equivocado invalida la peticion entera.
    if (createWorkflowDto.templateId !== undefined) {
      await this.workflowTemplatesService.assertInstantiable(
        createWorkflowDto.templateId,
      );
    }

    const schema = await this.pipelineValidatorService.validateSchema(
      createWorkflowDto.pipelineSchema,
    );

    const workflow = this.workflowRepository.create({
      name: createWorkflowDto.name,
      description: createWorkflowDto.description ?? null,
      pipelineSchema: schema,
      active: createWorkflowDto.active ?? false,
      // El grafo se guarda COPIADO en la fila del flujo, no referenciado: editar
      // la plantilla despues no altera los flujos que ya salieron de ella. La
      // columna es trazabilidad de la procedencia, no una dependencia viva.
      templateId: createWorkflowDto.templateId ?? null,
      createdById: userId,
    });

    const saved = await this.workflowRepository.save(workflow);

    this.logger.log(
      `Flujo creado: "${saved.name}" (${saved.id}) | nodos=${Object.keys(schema.nodes).length} | activo=${String(saved.active)} | plantilla=${saved.templateId ?? 'ninguna'} | autor=${userId}`,
    );

    return this.toPipelineSummary(saved);
  }

  /**
   * Edita un flujo ya instanciado: nombre, descripcion, estado o grafo.
   *
   * Es la via por la que un flujo se HABILITA. Nace inactivo por decision de
   * seguridad —la estrategia IMAP marca los correos con `\Seen` y consumiria el
   * buzon real—, y hasta ahora la unica forma de activarlo era SQL directo.
   *
   * DOS GUARDAS, y son el motivo de que la activacion viva aqui y no en un
   * endpoint aparte:
   *
   * 1. Un `pipelineSchema` nuevo se revalida por completo antes de escribirse.
   * 2. Activar exige un esquema valido. Habilitar un flujo lo expone al sondeo
   *    IMAP, que lo recogera en su reconciliacion periodica sin volver a
   *    preguntar nada: esta es la ultima oportunidad de detectar un grafo roto
   *    antes de que un disparador automatico lo ejecute.
   *
   * Cada campo se aplica solo si viaja en el cuerpo (`!== undefined`), no si es
   * veraz: sin eso, `{ active: false }` y una descripcion vacia se ignorarian.
   *
   * @param workflowId Identificador de la fila de `flujos`.
   * @param updateWorkflowDto Campos a modificar; todos opcionales.
   * @throws NotFoundException Si el flujo no existe.
   * @throws BadRequestException Si el grafo nuevo no es integro, o si se intenta
   *         activar un flujo que no tiene esquema.
   */
  public async updateWorkflow(
    workflowId: string,
    updateWorkflowDto: UpdateWorkflowDto,
  ): Promise<PipelineSummaryResponseDto> {
    const workflow = await this.workflowRepository.findOne({
      where: { id: workflowId },
    });

    if (!workflow) {
      throw new NotFoundException(`Flujo con id "${workflowId}" no encontrado`);
    }

    if (updateWorkflowDto.name !== undefined) {
      workflow.name = updateWorkflowDto.name.trim();
    }

    if (updateWorkflowDto.description !== undefined) {
      workflow.description = updateWorkflowDto.description.trim();
    }

    if (updateWorkflowDto.pipelineSchema !== undefined) {
      workflow.pipelineSchema =
        await this.pipelineValidatorService.validateSchema(
          updateWorkflowDto.pipelineSchema,
        );
    }

    if (updateWorkflowDto.active !== undefined) {
      if (updateWorkflowDto.active) {
        await this.assertActivatable(workflow);
      }

      workflow.active = updateWorkflowDto.active;
    }

    const saved = await this.workflowRepository.save(workflow);

    this.logger.log(
      `Flujo actualizado: "${saved.name}" (${saved.id}) | activo=${String(saved.active)}`,
    );

    return this.toPipelineSummary(saved);
  }

  /**
   * Comprueba que un flujo puede exponerse a los disparadores automaticos.
   *
   * Un flujo sin esquema es un borrador legitimo del asistente, pero activarlo
   * dejaria al sondeo IMAP disparando ejecuciones que fallan en el primer paso.
   * Con esquema, se REVALIDA: la fila pudo escribirse por SQL directo o quedar
   * obsoleta si el contrato del grafo cambio desde que se guardo.
   *
   * @throws BadRequestException Si no hay esquema o el esquema no es integro.
   */
  private async assertActivatable(workflow: Workflow): Promise<void> {
    if (workflow.pipelineSchema === null) {
      throw new BadRequestException(
        `El flujo "${workflow.name}" no tiene pipeline_schema y no se puede activar: configuralo antes de habilitarlo.`,
      );
    }

    await this.pipelineValidatorService.validateSchema(workflow.pipelineSchema);
  }

  /**
   * Proyecta un flujo persistido a su resumen publicable.
   *
   * Compartido por el listado y el alta para que ambos devuelvan exactamente la
   * misma forma: si divergieran, el cliente tendria que tratar el flujo que acaba
   * de crear distinto de los que lee del catalogo.
   */
  private toPipelineSummary(workflow: Workflow): PipelineSummaryResponseDto {
    return {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      active: workflow.active,
      templateId: workflow.templateId,
      topology:
        workflow.pipelineSchema === null
          ? []
          : buildOrderedTopology(workflow.pipelineSchema, (orphanNodeId) =>
              this.logger.warn(
                `El flujo "${workflow.id}" apunta al nodo inexistente "${orphanNodeId}": la topologia se truncara ahi.`,
              ),
            ),
    };
  }

  /**
   * Un flujo con su topologia ordenada Y su grafo completo.
   *
   * Es la unica lectura que devuelve los `params` de los nodos. Existe para el
   * asistente de EDICION: sin ellos no hay nada que hidratar, y guardar
   * reescribiria el grafo con los valores en blanco del formulario.
   *
   * Se devuelven las dos vistas del mismo grafo a proposito. El cliente usa
   * `topology` para el ORDEN —ya resuelto aqui por `buildOrderedTopology`, con
   * su defensa contra ciclos— y `pipelineSchema` para los VALORES. Asi el
   * frontend no reimplementa el recorrido de `entrypoint`/`nextStep`, que es
   * justo donde una segunda implementacion divergiria de esta.
   *
   * @throws NotFoundException Si no existe ninguna fila con ese `id_flujo`.
   */
  public async findOneDetail(id: string): Promise<WorkflowDetailResponseDto> {
    const workflow = await this.findOne(id);

    return {
      ...this.toPipelineSummary(workflow),
      // El cast es el mismo que usa `WorkflowTemplatesService.findOne`: la
      // columna es `jsonb` y el DTO la expone sin tipar, porque su forma ya la
      // garantizo `PipelineValidatorService` al escribirla.
      pipelineSchema: workflow.pipelineSchema as Record<string, unknown> | null,
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
