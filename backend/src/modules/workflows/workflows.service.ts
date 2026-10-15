import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import { FlowPollingCoordinator } from '@common/services/flow-polling.coordinator';
import { FsmEngineService } from '@core/fsm/services/fsm-engine.service';
import { FsmExecutionQueryService } from '@core/fsm/services/fsm-execution-query.service';
import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { buildOrderedTopology } from '@core/fsm/utils/pipeline-topology.util';
import { ADMIN_ONLY_MODELS } from '@modules/nodes/services/llm-provider-catalog.service';
import { UserRole } from '@modules/users/enums/user-role.enum';
import { WorkflowTemplatesService } from '@modules/workflow-templates/workflow-templates.service';
import { assertModelPermissions } from './validators/model-permissions.validator';
import { requirePipelineSchema } from './validators/require-pipeline-schema.validator';

import { ExecutionState } from '@core/fsm/types/fsm.enums';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { DEFAULT_MOCK_NAMESPACES } from './dto/execute-test-workflow.dto';

import { Workflow } from './entities/workflow.entity';

import type { CreateWorkflowDto } from './dto/create-workflow.dto';
import type { UpdateWorkflowDto } from './dto/update-workflow.dto';
import type { PipelineSummaryResponseDto } from './dto/pipeline-summary-response.dto';
import type { WorkflowDetailResponseDto } from './dto/workflow-detail-response.dto';
import type { ExecuteTestWorkflowDto } from './dto/execute-test-workflow.dto';
import type { WorkflowExecutionResponseDto } from './dto/workflow-execution-response.dto';

import type { FsmExecution } from '@core/fsm/entities/fsm-execution.entity';
import type { PipelineSchema } from '@core/fsm/types/pipeline-schema.types';
import type { CrudAction } from '@common/types/crud-events.types';
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
 * Se omiten los DISPARADORES, cada uno por su motivo. `TRIGGER_IMAP` abre una
 * conexion real por red y escribe su propio resultado en `raw_email`, pisando
 * el `mockData` que la prueba acaba de sembrar. `TRIGGER_CRON` no hace E/S
 * alguna, pero esperar a su proxima ventana —o dar por bueno un disparo que
 * nadie programo— no dice nada sobre si el resto del flujo funciona.
 *
 * Contrapartida asumida en `TRIGGER_CRON`: al omitirlo, su namespace no se
 * deposita, asi que un mapeador que interpole `{{cron_trigger.triggered_at}}`
 * vera el campo vacio en la prueba manual y no en la ejecucion real.
 *
 * Solo se aplica aqui: `runAutomaticWorkflow` SI ejecuta el disparador, porque
 * es de donde sale el dato que dispara el flujo.
 */
const TEST_MODE_SKIPPED_NODE_TYPES: readonly NodeType[] = [
  NodeType.TRIGGER_IMAP,
  NodeType.TRIGGER_CRON,
];

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    @InjectRepository(Workflow)
    private readonly workflowRepository: Repository<Workflow>,
    private readonly pipelineValidatorService: PipelineValidatorService,
    private readonly fsmEngineService: FsmEngineService,
    private readonly fsmExecutionQueryService: FsmExecutionQueryService,
    private readonly workflowTemplatesService: WorkflowTemplatesService,
    private readonly flowPollingCoordinator: FlowPollingCoordinator,
    private readonly crudEvents: CrudEventsCoordinator,
  ) {}

  /**
   * Difunde la mutacion del flujo a los paneles abiertos.
   *
   * Reutiliza el resumen que el metodo ya calcula para devolver, de modo que no
   * hay una segunda proyeccion que pueda divergir de la respuesta REST.
   *
   * `workflows` no produce `DELETED` jamas: no existe `@Delete` en el
   * controlador y retirar un flujo es `PATCH { active: false }`, es decir un
   * `UPDATED` con la fila ya actualizada.
   */
  private publishMutation(
    action: CrudAction,
    summary: PipelineSummaryResponseDto,
  ): void {
    this.crudEvents.dispatch({
      entity: 'workflows',
      action,
      id: summary.id,
      data: summary,
      emittedAt: new Date().toISOString(),
    });
  }

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
      {
        skipNodeTypes: TEST_MODE_SKIPPED_NODE_TYPES,
        flowName: workflow.name,
      },
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
      { flowName: workflow.name },
    );

    await this.applyStopOnFirstSuccess(workflow, schema, finished);

    return finished.executionId;
  }

  /**
   * Apaga el flujo si su esquema declara `executionPolicy.stopOnFirstSuccess`.
   *
   * Tres condiciones, y las tres importan:
   *
   * 1. La politica esta declarada y en `true`.
   * 2. La ejecucion cerro en EXITOSO. Una detenida por `halt` cierra en
   *    OMITIDO desde la migracion 030, de modo que esta sola condicion ya la
   *    descarta.
   * 3. `haltReason` es `undefined`, es decir, recorrio el grafo ENTERO. Hoy es
   *    REDUNDANTE con la condicion 2 y se conserva a proposito: es la
   *    comprobacion directa del hecho que importa —"no hizo ningun trabajo"—,
   *    mientras que el estado es una consecuencia de el. Sin alguna de las dos,
   *    un flujo IMAP con la politica activa se apagaria en su primer sondeo en
   *    vacio, antes de haber procesado un solo correo.
   * 4. `tookContingency` no esta puesto, es decir, no se desvio por ninguna
   *    ruta de error. Una recuperacion funcional cierra EXITOSO con razon —el
   *    trabajo se hizo— pero esta politica describe un flujo que ya funciona sin
   *    incidencias, y una ejecucion que necesito un desvio no lo demuestra.
   *    Apagarlo ahi enterraria el fallo junto con el flujo.
   *
   * Vive aqui y no en `FsmEngineService` porque desactivar es tocar la entidad
   * `Workflow`, que pertenece a `@modules`: el motor esta en `@core` y no puede
   * importar de ahi. El motor se limita a informar de COMO termino; que hacer
   * con esa informacion es una decision de negocio.
   *
   * Solo se invoca desde el despacho automatico. `executeTestWorkflow` queda
   * fuera a proposito: el banco de pruebas existe para iterar sobre un flujo, y
   * apagarlo en cada prueba exitosa lo convertiria en un interruptor.
   */
  private async applyStopOnFirstSuccess(
    workflow: Workflow,
    schema: PipelineSchema,
    finished: FsmExecution,
  ): Promise<void> {
    if (
      schema.executionPolicy?.stopOnFirstSuccess !== true ||
      finished.currentState !== ExecutionState.EXITOSO ||
      finished.haltReason !== undefined ||
      finished.tookContingency === true
    ) {
      return;
    }

    workflow.active = false;
    await this.workflowRepository.save(workflow);

    this.logger.log(
      `Flujo "${workflow.name}" (${workflow.id}) desactivado automaticamente por executionPolicy.stopOnFirstSuccess | ejecucion=${finished.executionId}`,
    );

    // Reutiliza la limpieza de la desactivacion manual: el residuo es el mismo
    // —temporizador en memoria y ejecuciones vivas— y duplicar el orden de esas
    // dos operaciones seria duplicar tambien la razon por la que va en ese orden.
    await this.releaseDeactivatedFlow(workflow);
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
   * Sobre el registro en `ImapPollingService`: sigue sin inyectarse aqui, y no
   * puede hacerlo. `NodesModule` ya importa `WorkflowsModule` para despachar los
   * flujos que el sondeo detecta, asi que la dependencia inversa cerraria un
   * ciclo de modulos. La notificacion puntual que si existe —ver
   * `updateWorkflow`— viaja por `FlowPollingCoordinator`, el puerto que vive en
   * el modulo global y al que el sondeo se inscribe solo.
   *
   * Un flujo recien creado no la necesita: nace inactivo, asi que no hay nada
   * que programar. Y la reconciliacion periodica sigue siendo la red de
   * seguridad para lo que el puerto no ve, como una activacion hecha por SQL
   * directo.
   *
   * @param createWorkflowDto Nombre, descripcion y grafo del pipeline.
   * @param userId Autor, tomado del token JWT y nunca del cuerpo.
   * @throws BadRequestException Si el esquema no supera forma, tipos o topologia.
   */
  public async createWorkflow(
    createWorkflowDto: CreateWorkflowDto,
    userId: string,
    userRole: UserRole,
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

    // DESPUES de validar y no antes, aunque sea una comprobacion mas barata:
    // `pipelineSchema` llega como `Record<string, unknown>` y solo el validador
    // lo convierte en un grafo tipado. Adelantarla obligaria a recorrer JSON
    // crudo adivinando la forma, que es exactamente el trabajo que el validador
    // ya hace. El coste es que un esquema mal formado da 400 antes que 403.
    this.assertModelPermissions(schema, userRole);

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

    const summary = this.toPipelineSummary(saved);
    // Despues de confirmar la escritura, nunca antes: emitir en vuelo haria que
    // otro panel pintase una fila que PostgreSQL aun no tiene.
    this.publishMutation('CREATED', summary);

    return summary;
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
    userRole: UserRole,
  ): Promise<PipelineSummaryResponseDto> {
    const workflow = await this.workflowRepository.findOne({
      where: { id: workflowId },
    });

    if (!workflow) {
      throw new NotFoundException(`Flujo con id "${workflowId}" no encontrado`);
    }

    // Se captura ANTES de aplicar el DTO: la entidad se muta en sitio mas abajo
    // y despues ya no hay forma de distinguir un `false -> false` (que no es
    // transicion y no debe limpiar nada) de la desactivacion real.
    const wasActive = workflow.active;

    if (updateWorkflowDto.name !== undefined) {
      workflow.name = updateWorkflowDto.name.trim();
    }

    if (updateWorkflowDto.description !== undefined) {
      workflow.description = updateWorkflowDto.description.trim();
    }

    if (updateWorkflowDto.pipelineSchema !== undefined) {
      const schema = await this.pipelineValidatorService.validateSchema(
        updateWorkflowDto.pipelineSchema,
      );

      this.assertModelPermissions(schema, userRole);

      workflow.pipelineSchema = schema;
    }

    if (updateWorkflowDto.active !== undefined) {
      await this.assertNotInFlight(workflow);

      if (updateWorkflowDto.active) {
        await this.assertActivatable(workflow);
      }

      workflow.active = updateWorkflowDto.active;
    }

    const saved = await this.workflowRepository.save(workflow);

    this.logger.log(
      `Flujo actualizado: "${saved.name}" (${saved.id}) | activo=${String(saved.active)}`,
    );

    // DESPUES del `save`, nunca antes. El sondeo lee `flujos WHERE activo=true`
    // y `runAutomaticWorkflow` relee la columna: si limpiaramos con el cambio
    // aun sin comprometer, una reconciliacion que se colara veria el flujo
    // todavia activo y reinscribiria el temporizador que acabamos de borrar,
    // deshaciendo nuestra propia parada.
    if (wasActive && !saved.active) {
      await this.releaseDeactivatedFlow(saved);
    }

    // La activacion no aborta nada —las PAUSADO son la cola de reintento de
    // CU-09 y sobreviven a proposito—, pero si adelanta la reinscripcion: sin
    // esto el operador pulsa "Activar" y el flujo no sondea hasta el siguiente
    // ciclo de reconciliacion, hasta un minuto de silencio inexplicable.
    if (!wasActive && saved.active) {
      await this.flowPollingCoordinator.refreshPolling();
    }

    const summary = this.toPipelineSummary(saved);
    // Al FINAL, despues de liberar o registrar el sondeo: emitir antes
    // anunciaria un flujo activo cuyo temporizador aun no existe.
    this.publishMutation('UPDATED', summary);

    return summary;
  }

  /**
   * Libera los recursos que un flujo desactivado deja detras.
   *
   * Dos residuos distintos y ninguno se limpia solo:
   *
   * 1. El temporizador en memoria del sondeo IMAP, que seguiria abriendo
   *    conexiones contra el buzon hasta la siguiente reconciliacion.
   * 2. Las ejecuciones vivas en `ejecuciones_flujo`. Una EN_PROCESO huerfana
   *    reserva el mutex parcial `idx_flujo_activo`, asi que si el flujo vuelve
   *    a activarse NUNCA podria arrancar otra ejecucion.
   *
   * NO PROPAGA. La desactivacion ya esta comprometida en la base de datos
   * cuando llegamos aqui: convertir un fallo de limpieza en un 500 le diria al
   * cliente que la operacion fallo cuando si ocurrio, y su reintento seria un
   * no-op que jamas volveria a intentar la limpieza. Se registra y se sigue; la
   * reconciliacion periodica borra el intervalo de todos modos, y la guarda
   * `!active` de `runAutomaticWorkflow` ya impide ejecuciones nuevas.
   */
  /**
   * Impide conmutar `activo` mientras haya trabajo REALMENTE en vuelo.
   *
   * SOLO EN_PROCESO BLOQUEA, y la exclusion de PAUSADO es deliberada, no un
   * olvido. Las pausadas son la cola de reintento de CU-09 y sobreviven a
   * proposito a los cambios de estado del flujo (ver la nota de
   * `updateWorkflow` sobre la activacion): contarlas aqui dejaria un flujo con
   * una incidencia sin cerrar IMPOSIBLE de desactivar, que es justo lo que un
   * operador quiere hacer cuando algo va mal.
   *
   * Una EN_PROCESO es otra cosa: tiene un bucle del motor atendiendola y
   * reserva el mutex parcial `idx_flujo_activo`. Desactivar bajo ella la
   * cerraria como FALLIDO a mitad de camino (`releaseDeactivatedFlow`) y
   * activar competiria con el sondeo por una ejecucion que ya existe.
   *
   * Se reutiliza `findLiveByFlow` —que devuelve ambos estados por diseno— y se
   * filtra aqui, en vez de anadir una consulta casi identica al servicio.
   *
   * @throws ConflictException Si el flujo tiene una ejecucion EN_PROCESO.
   */
  private async assertNotInFlight(workflow: Workflow): Promise<void> {
    const live = await this.fsmExecutionQueryService.findLiveByFlow(
      workflow.id,
    );

    const inFlight = live.filter(
      (execution) => execution.currentState === ExecutionState.EN_PROCESO,
    );

    if (inFlight.length > 0) {
      throw new ConflictException(
        `No se puede activar o desactivar el flujo "${workflow.name}" mientras tiene una ejecucion en curso.`,
      );
    }
  }

  private async releaseDeactivatedFlow(workflow: Workflow): Promise<void> {
    // Primero cortar la fuente de trabajo nuevo y despues matar lo que ya
    // corre: al reves, el intervalo podria disparar un tick mas y crear una
    // ejecucion fresca justo despues del barrido.
    this.flowPollingCoordinator.stopPollingForFlow(workflow.id);

    try {
      const closed = await this.fsmEngineService.abortExecutionsForFlow(
        workflow.id,
        'Flujo padre desactivado',
      );

      if (closed > 0) {
        this.logger.warn(
          `Flujo "${workflow.name}" (${workflow.id}) desactivado: ${closed} ejecucion(es) viva(s) cerradas como FALLIDO.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `El flujo "${workflow.name}" (${workflow.id}) quedo desactivado, pero no se pudieron cerrar sus ejecuciones vivas: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
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

    // `requireRunnableParams` es la asimetria deliberada entre guardar y activar.
    // Un flujo se GUARDA a medio configurar —es un borrador, y su plantilla de
    // origen ni siquiera trae operativa—, pero activarlo es ponerlo a disparar:
    // sin esto, un extractor web sin `targetUrl` elegido se habilitaria y
    // fallaria en la primera ejecucion con el flujo ya PAUSADO.
    await this.pipelineValidatorService.validateSchema(
      workflow.pipelineSchema,
      {
        requireRunnableParams: true,
      },
    );
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
   * Envoltorio sobre la guarda de esquema ausente.
   *
   * La funcion libre vive en `validators/` porque la comparten tambien el
   * despacho automatico y la reanudacion manual de CU-09, que esta en otro
   * servicio. Mismo criterio que `assertModelPermissions`.
   */
  private requirePipelineSchema(workflow: Workflow): unknown {
    return requirePipelineSchema(workflow);
  }
  /**
   * Envoltorio sobre la guarda de modelos de pago.
   *
   * La lista de modelos restringidos se IMPORTA del catalogo, que es la unica
   * fuente de verdad sobre que modelos existen; reescribirla aqui crearia una
   * segunda lista que se desincroniza al anadir el primer modelo nuevo.
   */
  private assertModelPermissions(
    schema: PipelineSchema,
    userRole: UserRole,
  ): void {
    assertModelPermissions(schema, userRole, ADMIN_ONLY_MODELS);
  }
}
