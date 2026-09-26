import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { AiPromptTemplate } from './entities/ai-prompt-template.entity';

import type { CreateAiPromptTemplateDto } from './dto/create-ai-prompt-template.dto';
import type {
  AiPromptTemplateDetailResponseDto,
  AiPromptTemplateResponseDto,
} from './dto/ai-prompt-template-response.dto';
import type { UpdateAiPromptTemplateDto } from './dto/update-ai-prompt-template.dto';
import type { FindOptionsWhere, Repository } from 'typeorm';

/**
 * Repositorio de prompts de IA (PROT-15.2).
 *
 * Logica de negocio del CRUD y unica capa que decide que sale hacia la API. Los
 * metodos publicos devuelven DTOs y no la entidad: `AiPromptTemplate` tiene una relacion
 * `createdBy` hacia `User`, y `User` lleva `secreto_otp` dentro. Basta con que
 * alguien anada un `relations: ['createdBy']` a una consulta para que ese campo
 * viaje al cliente. `findByName` y `findOneEntity` si devuelven la entidad,
 * porque sus consumidores son internos: la estrategia del nodo `PROCESADOR_IA`
 * que se conecta en PROT-15.3.
 */
@Injectable()
export class AiPromptTemplatesService {
  private readonly logger = new Logger(AiPromptTemplatesService.name);

  constructor(
    @InjectRepository(AiPromptTemplate)
    private readonly aiPromptTemplateRepository: Repository<AiPromptTemplate>,
  ) {}

  /**
   * Lista los prompts.
   *
   * @param onlyActive Excluye los retirados. Por defecto si: el consumidor
   *                   natural del listado es el selector del nodo IA, y ofrecer
   *                   ahi un prompt dado de baja seria un Poka-Yoke al reves.
   */
  public async findAll(
    onlyActive = true,
  ): Promise<AiPromptTemplateResponseDto[]> {
    const where: FindOptionsWhere<AiPromptTemplate> = onlyActive
      ? { active: true }
      : {};

    // Orden alfabetico y no por fecha, por el mismo motivo: se lee en un
    // selector, no en una bitacora.
    const prompts = await this.aiPromptTemplateRepository.find({
      where,
      order: { name: 'ASC' },
    });

    return prompts.map((prompt) => this.toSummary(prompt));
  }

  public async findOne(id: string): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    return {
      ...this.toSummary(prompt),
      promptText: prompt.promptText,
    };
  }

  /**
   * Devuelve la ENTIDAD, para quien necesita el registro y no la respuesta.
   *
   * @throws NotFoundException Si no existe ningun prompt con ese id.
   */
  public async findOneEntity(id: string): Promise<AiPromptTemplate> {
    const prompt = await this.aiPromptTemplateRepository.findOne({
      where: { id },
    });

    if (!prompt) {
      throw new NotFoundException(`Prompt con id "${id}" no encontrado`);
    }

    return prompt;
  }

  /**
   * Resuelve un prompt por su nombre unico.
   *
   * Devuelve `null` en vez de lanzar: el consumidor previsto es la estrategia
   * del nodo IA, que ante un prompt inexistente debe producir un `NodeResult`
   * con `success: false` y su nivel de severidad, no una excepcion HTTP.
   */
  public async findByName(name: string): Promise<AiPromptTemplate | null> {
    return this.aiPromptTemplateRepository.findOne({
      where: { name: name.trim() },
    });
  }

  /**
   * Registra un prompt nuevo.
   *
   * @param createAiPromptTemplateDto Datos ya validados por `class-validator`.
   * @param createdById Autor, tomado del JWT y no del cuerpo de la peticion.
   */
  public async create(
    createAiPromptTemplateDto: CreateAiPromptTemplateDto,
    createdById: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    const name = createAiPromptTemplateDto.name.trim();

    await this.assertNameAvailable(name);

    // `active` del DTO se ignora en el alta: todo prompt nace activo. El campo
    // existe en el DTO solo para que la edicion pueda reactivar uno retirado.
    const prompt = this.aiPromptTemplateRepository.create({
      name,
      description: createAiPromptTemplateDto.description?.trim() ?? null,
      promptText: createAiPromptTemplateDto.promptText,
      createdById,
    });

    const saved = await this.aiPromptTemplateRepository.save(prompt);
    this.logger.log(`Prompt "${name}" creado por el usuario ${createdById}`);

    return this.findOne(saved.id);
  }

  /**
   * Actualiza un prompt existente.
   *
   * Se comprueba campo a campo con `!== undefined` y no por veracidad: con una
   * comprobacion laxa, `active: false` o una descripcion vaciada a proposito se
   * descartarian silenciosamente.
   */
  public async update(
    id: string,
    updateAiPromptTemplateDto: UpdateAiPromptTemplateDto,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    if (updateAiPromptTemplateDto.name !== undefined) {
      const name = updateAiPromptTemplateDto.name.trim();
      await this.assertNameAvailable(name, id);
      prompt.name = name;
    }

    if (updateAiPromptTemplateDto.description !== undefined) {
      prompt.description = updateAiPromptTemplateDto.description.trim();
    }

    if (updateAiPromptTemplateDto.promptText !== undefined) {
      prompt.promptText = updateAiPromptTemplateDto.promptText;
    }

    // Unica via para REACTIVAR un prompt retirado: `softDelete` solo sabe
    // apagarlo. Mismo criterio que `TemplatesService`.
    if (updateAiPromptTemplateDto.active !== undefined) {
      prompt.active = updateAiPromptTemplateDto.active;
    }

    const saved = await this.aiPromptTemplateRepository.save(prompt);
    this.logger.log(`Prompt "${saved.name}" actualizado`);

    return this.findOne(saved.id);
  }

  /**
   * Borrado logico (Poka-Yoke): no elimina el registro fisico.
   *
   * Una ejecucion ya trazada apunta al prompt con el que se genero su salida;
   * borrarlo dejaria la auditoria sin la pieza que explica el resultado. El
   * prompt desaparece del selector, pero la fila sigue ahi.
   */
  public async softDelete(
    id: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    prompt.active = false;

    const saved = await this.aiPromptTemplateRepository.save(prompt);
    this.logger.log(`Prompt "${saved.name}" retirado (borrado logico)`);

    return this.findOne(saved.id);
  }

  /** Proyeccion de la entidad al contrato del listado, sin el cuerpo del prompt. */
  private toSummary(prompt: AiPromptTemplate): AiPromptTemplateResponseDto {
    return {
      id: prompt.id,
      name: prompt.name,
      description: prompt.description,
      active: prompt.active,
      createdById: prompt.createdById,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  }

  /**
   * Rechaza un nombre ya tomado antes de tocar la base de datos.
   *
   * Se pre-comprueba en vez de atrapar el `23505` de PostgreSQL porque no hay
   * ningun filtro global de excepciones en el backend: un error de constraint
   * subiria crudo como 500. Es el mismo helper de `TemplatesService` y
   * `WorkflowTemplatesService`.
   *
   * @param excludeId Id de la propia fila en una edicion, para que conservar su
   *                  nombre no cuente como colision.
   */
  private async assertNameAvailable(
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.aiPromptTemplateRepository.findOne({
      where: { name },
    });

    if (existing && existing.id !== excludeId) {
      throw new ConflictException(`El prompt "${name}" ya esta registrado`);
    }
  }
}
