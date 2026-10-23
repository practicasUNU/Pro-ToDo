import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CrudEventsCoordinator } from '@common/services/crud-events.coordinator';
import {
  AUDIT_RELATIONS,
  stampCreated,
  stampUpdated,
  toAuditFields,
} from '@common/utils/audit.util';

import { PipelineValidatorService } from '@core/fsm/services/pipeline-validator.service';
import { buildOrderedTopology } from '@core/fsm/utils/pipeline-topology.util';

import { WorkflowTemplate } from './entities/workflow-template.entity';

import type { CreateWorkflowTemplateDto } from './dto/create-workflow-template.dto';
import type { UpdateWorkflowTemplateDto } from './dto/update-workflow-template.dto';
import type {
  WorkflowTemplateDetailResponseDto,
  WorkflowTemplateResponseDto,
} from './dto/workflow-template-response.dto';
import type { FindOptionsWhere, Repository } from 'typeorm';
import type { CrudAction } from '@common/types/crud-events.types';

/**
 * Catalogo de plantillas de flujo (blueprints maestros).
 *
 * Su razon de ser no es el CRUD, sino que el grafo se valide ANTES de entrar en
 * el catalogo: una plantilla es el punto de partida de N flujos, asi que un
 * `nextStep` roto aqui se propaga a cada instancia que alguien cree a partir de
 * ella. Se reutiliza `PipelineValidatorService`, el mismo que valida el esquema
 * de un flujo, para que ambos caminos exijan exactamente lo mismo.
 *
 * Las excepciones se propagan sin capturar: el filtro global de Nest traduce
 * `NotFoundException` a 404, `ConflictException` a 409 y `BadRequestException` a
 * 400, que es el contrato del endpoint.
 */
@Injectable()
export class WorkflowTemplatesService {
  private readonly logger = new Logger(WorkflowTemplatesService.name);

  constructor(
    @InjectRepository(WorkflowTemplate)
    private readonly templateRepository: Repository<WorkflowTemplate>,
    private readonly pipelineValidatorService: PipelineValidatorService,
    private readonly crudEvents: CrudEventsCoordinator,
  ) {}
  /**
   * Difunde la mutacion a los paneles abiertos.
   *
   * Siempre DESPUES de confirmar la escritura: emitir antes abriria una ventana
   * en la que otro panel pinta una fila que PostgreSQL aun no tiene.
   *
   * Una baja logica viaja como `UPDATED` y no como `DELETED`, porque la fila
   * sigue existiendo con `active` en falso: es el cliente quien decide si la
   * oculta, segun liste o no las inactivas.
   */
  private publishMutation(
    action: CrudAction,
    id: string,
    data: WorkflowTemplateDetailResponseDto,
  ): void {
    this.crudEvents.dispatch({
      entity: 'workflow_templates',
      action,
      id,
      data,
      emittedAt: new Date().toISOString(),
    });
  }

  /**
   * Lista las plantillas con su topologia proyectada.
   *
   * Orden alfabetico y no por fecha: el consumidor natural es el selector de la
   * Fase 0 del asistente, donde el operador busca una plantilla por su nombre.
   *
   * @param onlyActive `false` incluye las retiradas, para la tabla administrativa.
   */
  public async findAll(
    onlyActive = true,
  ): Promise<WorkflowTemplateResponseDto[]> {
    const where: FindOptionsWhere<WorkflowTemplate> = onlyActive
      ? { active: true }
      : {};

    const templates = await this.templateRepository.find({
      where,
      order: { name: 'ASC' },
      relations: AUDIT_RELATIONS,
    });

    return templates.map((template) => this.toSummary(template));
  }

  /** Plantilla con su grafo completo, para el editor administrativo. */
  public async findOne(id: string): Promise<WorkflowTemplateDetailResponseDto> {
    const template = await this.findOneEntity(id);

    return {
      ...this.toSummary(template),
      pipelineSchema: template.pipelineSchema as unknown as Record<
        string,
        unknown
      >,
    };
  }

  /**
   * Fila cruda, para los consumidores que necesitan la entidad.
   *
   * Publico porque `WorkflowsService` lo invoca para comprobar el `templateId`
   * que recibe al instanciar un flujo. Devolver la entidad y no el DTO es
   * deliberado: ahi lo que importa es `active`, no la topologia proyectada.
   *
   * @throws NotFoundException Si no existe la plantilla.
   */
  public async findOneEntity(id: string): Promise<WorkflowTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id },
      relations: AUDIT_RELATIONS,
    });

    if (!template) {
      throw new NotFoundException(
        `Plantilla de flujo con id "${id}" no encontrada`,
      );
    }

    return template;
  }

  /**
   * Registra una plantilla nueva.
   *
   * El nombre se comprueba ANTES de validar el grafo: es la comprobacion mas
   * barata y la que el usuario corrige mas a menudo.
   *
   * @throws ConflictException Si el nombre ya esta registrado.
   * @throws BadRequestException Si el grafo no pasa la validacion.
   */
  public async create(
    createDto: CreateWorkflowTemplateDto,
    actorId: string,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    const name = createDto.name.trim();

    await this.assertNameAvailable(name);

    const schema = await this.pipelineValidatorService.validateSchema(
      createDto.pipelineSchema,
    );

    const template = this.templateRepository.create({
      name,
      description: createDto.description?.trim() ?? null,
      pipelineSchema: schema,
      active: createDto.active ?? true,
    });

    const saved = await this.templateRepository.save(
      stampCreated(template, actorId),
    );

    this.logger.log(
      `Plantilla de flujo creada: "${saved.name}" (${saved.id}) | nodos=${Object.keys(schema.nodes).length} | activa=${String(saved.active)}`,
    );

    const detail = await this.findOne(saved.id);
    this.publishMutation('CREATED', detail.id, detail);

    return detail;
  }

  /**
   * Actualiza una plantilla. Cubre editar, activar e inactivar.
   *
   * Cada campo se aplica solo si viaja en el cuerpo: `PartialType` deja los
   * cuatro opcionales, y comprobar `!== undefined` en vez de la veracidad del
   * valor es lo que permite enviar `active: false` o una descripcion vacia sin
   * que se ignoren.
   *
   * @throws NotFoundException Si no existe la plantilla.
   * @throws ConflictException Si el nombre nuevo ya lo usa OTRA plantilla.
   * @throws BadRequestException Si el grafo nuevo no pasa la validacion.
   */
  public async update(
    id: string,
    updateDto: UpdateWorkflowTemplateDto,
    actorId: string,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    const template = await this.findOneEntity(id);

    if (updateDto.name !== undefined) {
      const name = updateDto.name.trim();
      await this.assertNameAvailable(name, id);
      template.name = name;
    }

    if (updateDto.description !== undefined) {
      template.description = updateDto.description.trim();
    }

    if (updateDto.pipelineSchema !== undefined) {
      // Se revalida siempre: una plantilla es el punto de partida de N flujos, y
      // guardar aqui un grafo roto lo propagaria a cada uno de ellos.
      template.pipelineSchema =
        await this.pipelineValidatorService.validateSchema(
          updateDto.pipelineSchema,
        );
    }

    if (updateDto.active !== undefined) {
      template.active = updateDto.active;
    }

    const saved = await this.templateRepository.save(
      stampUpdated(template, actorId),
    );

    const detail = await this.findOne(saved.id);
    this.publishMutation('UPDATED', detail.id, detail);

    return detail;
  }

  /**
   * Borrado logico: retira la plantilla del selector sin eliminar la fila.
   *
   * Los flujos que la instanciaron apuntan a ella con `id_plantilla_origen`, y
   * su trazabilidad depende de que la fila siga existiendo: borrarla fisicamente
   * dejaria a esos flujos sin la pieza que explica de donde salio su topologia.
   * Mismo criterio que `TemplatesService.softDelete`.
   */
  public async softDelete(
    id: string,
    actorId: string,
  ): Promise<WorkflowTemplateDetailResponseDto> {
    const template = await this.findOneEntity(id);

    template.active = false;
    const saved = await this.templateRepository.save(
      stampUpdated(template, actorId),
    );

    this.logger.log(
      `Plantilla de flujo retirada del catalogo: "${saved.name}" (${saved.id})`,
    );

    const detail = await this.findOne(saved.id);
    this.publishMutation('UPDATED', detail.id, detail);

    return detail;
  }

  /**
   * Comprueba que la plantilla se puede instanciar.
   *
   * La usa `WorkflowsService` al crear un flujo con `templateId`. Una plantilla
   * retirada no se puede instanciar: permitirlo vaciaria de sentido el borrado
   * logico, que existe justo para que deje de usarse.
   *
   * @throws NotFoundException Si no existe la plantilla.
   * @throws BadRequestException Si esta retirada del catalogo.
   */
  public async assertInstantiable(id: string): Promise<WorkflowTemplate> {
    const template = await this.findOneEntity(id);

    if (!template.active) {
      throw new BadRequestException(
        `La plantilla "${template.name}" esta retirada del catalogo y no se puede instanciar`,
      );
    }

    return template;
  }

  /** Proyeccion comun del listado y del detalle. */
  private toSummary(template: WorkflowTemplate): WorkflowTemplateResponseDto {
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      active: template.active,
      topology: buildOrderedTopology(template.pipelineSchema, (orphanNodeId) =>
        this.logger.warn(
          `La plantilla "${template.id}" apunta al nodo inexistente "${orphanNodeId}": la topologia se truncara ahi.`,
        ),
      ),
      // La clave se OMITE cuando la plantilla no declara politica, en vez de
      // viajar como `undefined`: es lo que permite al asistente distinguir
      // "no hereda nada" sin tener que interpretar un objeto vacio.
      ...(template.pipelineSchema.executionPolicy !== undefined
        ? { executionPolicy: template.pipelineSchema.executionPolicy }
        : {}),
      ...toAuditFields(template),
    };
  }

  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.templateRepository.findOne({ where: { name } });

    if (existing && existing.id !== excludeId) {
      throw new ConflictException(
        `La plantilla de flujo "${name}" ya esta registrada`,
      );
    }
  }
}
