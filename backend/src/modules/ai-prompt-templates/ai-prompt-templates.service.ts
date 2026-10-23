import {
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

import { extractNamespaceRoots } from '@core/fsm/context/state-payload.context';

import { AiPromptTemplate } from './entities/ai-prompt-template.entity';

import { MAX_CODE_LENGTH } from './dto/create-ai-prompt-template.dto';

import type { CreateAiPromptTemplateDto } from './dto/create-ai-prompt-template.dto';
import type {
  AiPromptTemplateDetailResponseDto,
  AiPromptTemplateResponseDto,
} from './dto/ai-prompt-template-response.dto';
import type { UpdateAiPromptTemplateDto } from './dto/update-ai-prompt-template.dto';
import type { FindOptionsWhere, Repository } from 'typeorm';
import type { CrudAction } from '@common/types/crud-events.types';

/**
 * Repositorio de prompts de IA (PROT-15.2).
 *
 * Logica de negocio del CRUD y unica capa que decide que sale hacia la API. Los
 * metodos publicos devuelven DTOs y no la entidad: `AiPromptTemplate` tiene
 * relaciones `creatorUser`, `createdBy` y `updatedBy` hacia `User`, y `User`
 * lleva `secreto_otp` dentro. Basta con que alguien anada un
 * `relations: ['creatorUser']` a una consulta para que ese campo viaje al
 * cliente. `findByName` y `findOneEntity` si devuelven la entidad,
 * porque sus consumidores son internos: la estrategia del nodo `PROCESADOR_IA`
 * que se conecta en PROT-15.3.
 */
/** Codigo de ultimo recurso cuando el nombre no deja un solo alfanumerico. */
const FALLBACK_CODE = 'PROMPT';

/**
 * Tope de intentos al desempatar un codigo derivado.
 *
 * Un `while (true)` consultando la base de datos es un bucle infinito esperando
 * a ocurrir. Cincuenta plantillas con nombres que colapsan al mismo slug es un
 * escenario que ya no se arregla con otro sufijo.
 */
const MAX_CODE_ATTEMPTS = 50;

/** Marcas diacriticas que deja la descomposicion NFD. */
const DIACRITICS = /[\u0300-\u036f]/g;

/**
 * Deriva una clave de maquina a partir del nombre visible.
 *
 * "Extraccion de noticias (ES)" → `EXTRACCION_DE_NOTICIAS_ES`.
 *
 * Los simbolos pasan a `_` en vez de borrarse: borrarlos pegaria las palabras
 * ("Plan de innovacion" → `PLANDEINNOVACION`), que es ilegible justo donde el
 * codigo tiene que leerse —escrito a mano en los `params` de un nodo—.
 *
 * DIVERGE A PROPOSITO DEL BACKFILL de la migracion 023, que usaba
 * `[^a-zA-Z0-9]` y convertia los acentos en `_` ("Extraccion" → `EXTRACCI_N`).
 * Aquel era un rescate puntual de filas preexistentes escrito en SQL, donde
 * plegar diacriticos no sale gratis; este es el camino permanente y puede
 * permitirse el NFD.
 *
 * Exportada para poder probarla sin instanciar el servicio: no toca estado ni
 * base de datos.
 */
export const deriveCodeFromName = (name: string): string => {
  const normalized = name
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');

  // Los `_` de los extremos se recortan ANTES del corte, y el respaldo se
  // aplica DESPUES: un nombre que sea todo simbolos ("¿?") colapsa a cadena
  // vacia, y `CODE_PATTERN` exige al menos un caracter.
  const trimmed = normalized.replace(/^_+|_+$/g, '').slice(0, MAX_CODE_LENGTH);

  return trimmed.length > 0 ? trimmed : FALLBACK_CODE;
};

@Injectable()
export class AiPromptTemplatesService {
  private readonly logger = new Logger(AiPromptTemplatesService.name);

  constructor(
    @InjectRepository(AiPromptTemplate)
    private readonly aiPromptTemplateRepository: Repository<AiPromptTemplate>,
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
    data: AiPromptTemplateDetailResponseDto,
  ): void {
    this.crudEvents.dispatch({
      entity: 'ai_prompts',
      action,
      id,
      data,
      emittedAt: new Date().toISOString(),
    });
  }

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
      relations: AUDIT_RELATIONS,
    });

    return prompts.map((prompt) => this.toSummary(prompt));
  }

  public async findOne(id: string): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    return this.toDetail(prompt);
  }

  /**
   * Resuelve un prompt por su clave de maquina.
   *
   * LANZA, al reves que `findByName`, que devuelve `null`. La diferencia no es
   * un descuido: `findByName` sirve a un selector donde "no hay ninguno asi" es
   * una respuesta normal, mientras que un `promptCode` escrito en los `params`
   * de un nodo que no resuelve es una configuracion rota. La estrategia del
   * nodo IA ya traduce esta excepcion a su propio `ERR_LLM_PROMPT_UNRESOLVED`.
   *
   * La comparacion es exacta y en mayusculas porque esa es la forma que impone
   * el DTO (`CODE_PATTERN`); normalizar aqui ocultaria un codigo mal escrito en
   * el esquema del flujo en vez de senalarlo.
   *
   * @throws NotFoundException Si no existe ningun prompt con ese codigo.
   */
  public async findByCode(code: string): Promise<AiPromptTemplate> {
    const prompt = await this.aiPromptTemplateRepository.findOne({
      where: { code: code.trim() },
      relations: AUDIT_RELATIONS,
    });

    if (!prompt) {
      throw new NotFoundException(`Prompt con codigo "${code}" no encontrado`);
    }

    return prompt;
  }

  /** Detalle de un prompt resuelto por su clave de maquina. */
  public async findOneByCode(
    code: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    return this.toDetail(await this.findByCode(code));
  }

  /**
   * Devuelve la ENTIDAD, para quien necesita el registro y no la respuesta.
   *
   * @throws NotFoundException Si no existe ningun prompt con ese id.
   */
  public async findOneEntity(id: string): Promise<AiPromptTemplate> {
    const prompt = await this.aiPromptTemplateRepository.findOne({
      where: { id },
      relations: AUDIT_RELATIONS,
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
    const providedCode = createAiPromptTemplateDto.code?.trim();

    await this.assertNameAvailable(name);

    // DOS CAMINOS, Y LA DIFERENCIA IMPORTA. Un codigo SUMINISTRADO que choque
    // da 409 y no se renombra: ahi una persona eligio ese literal, muy
    // probablemente porque ya lo cita un `pipeline_schema`, y cambiarselo a su
    // espalda romperia el flujo que venia a configurar. Un codigo DERIVADO no
    // expresa ninguna intencion, asi que desempatarlo con un sufijo es
    // preferible a negarle el alta a quien solo escribio un nombre.
    let code: string;

    if (providedCode !== undefined && providedCode.length > 0) {
      code = providedCode.toUpperCase();
      await this.assertCodeAvailable(code);
    } else {
      code = await this.resolveAvailableCode(deriveCodeFromName(name));
    }

    // `active` del DTO se ignora en el alta: todo prompt nace activo. El campo
    // existe en el DTO solo para que la edicion pueda reactivar uno retirado.
    const prompt = this.aiPromptTemplateRepository.create({
      code,
      name,
      description: createAiPromptTemplateDto.description?.trim() ?? null,
      promptText: createAiPromptTemplateDto.promptText,
      createdById,
    });

    const saved = await this.aiPromptTemplateRepository.save(
      stampCreated(prompt, createdById),
    );
    this.logger.log(
      `Prompt "${name}" (${code}) creado por el usuario ${createdById}`,
    );

    const detail = await this.findOne(saved.id);
    this.publishMutation('CREATED', detail.id, detail);

    return detail;
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
    actorId: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    // `code` NO se lee, aunque `PartialType` lo herede. Es la clave de maquina
    // que citan los `params` de los nodos: cambiarla dejaria a cada flujo que
    // la referencia apuntando a un prompt inexistente, y el fallo no saldria
    // hasta la siguiente ejecucion. La etiqueta editable es `name`.
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

    const saved = await this.aiPromptTemplateRepository.save(
      stampUpdated(prompt, actorId),
    );
    this.logger.log(`Prompt "${saved.name}" actualizado`);

    const detail = await this.findOne(saved.id);
    this.publishMutation('UPDATED', detail.id, detail);

    return detail;
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
    actorId: string,
  ): Promise<AiPromptTemplateDetailResponseDto> {
    const prompt = await this.findOneEntity(id);

    prompt.active = false;

    const saved = await this.aiPromptTemplateRepository.save(
      stampUpdated(prompt, actorId),
    );
    this.logger.log(`Prompt "${saved.name}" retirado (borrado logico)`);

    const detail = await this.findOne(saved.id);
    this.publishMutation('UPDATED', detail.id, detail);

    return detail;
  }

  /**
   * Proyeccion al contrato del detalle: el resumen, el texto y los namespaces.
   *
   * `requiredNamespaces` se DERIVA aqui reutilizando `extractNamespaceRoots`
   * del contexto de la FSM, que es el mismo analizador que usa el motor para
   * interpolar. Reimplementar la expresion regular en este modulo garantizaria
   * que las dos divergieran a la primera correccion.
   */
  private toDetail(
    prompt: AiPromptTemplate,
  ): AiPromptTemplateDetailResponseDto {
    return {
      ...this.toSummary(prompt),
      promptText: prompt.promptText,
      requiredNamespaces: extractNamespaceRoots(prompt.promptText),
    };
  }

  /** Proyeccion de la entidad al contrato del listado, sin el cuerpo del prompt. */
  private toSummary(prompt: AiPromptTemplate): AiPromptTemplateResponseDto {
    return {
      id: prompt.id,
      code: prompt.code,
      name: prompt.name,
      description: prompt.description,
      active: prompt.active,
      createdById: prompt.createdById,
      ...toAuditFields(prompt),
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

  /**
   * Rechaza una clave de maquina ya tomada.
   *
   * Sin `excludeId`, al contrario que `assertNameAvailable`: el codigo es
   * inmutable, asi que la unica vez que se comprueba es en el alta y nunca hay
   * una fila propia de la que desentenderse.
   */
  /**
   * Primer codigo libre a partir de una base derivada.
   *
   * Desempata con `_2`, `_3`… recortando LA BASE a `MAX_CODE_LENGTH` menos lo
   * que ocupa el sufijo, no el resultado: al reves, un nombre que ya rozase los
   * 50 caracteres perderia el sufijo en el truncado y volveria a colisionar
   * indefinidamente. Es el mismo criterio del bucle de la migracion 023.
   *
   * El indice UNIQUE de la columna sigue siendo la ultima palabra: entre
   * comprobar y guardar cabe otra alta simultanea, y ahi quien decide es la
   * base de datos.
   */
  private async resolveAvailableCode(baseCode: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? '' : `_${attempt}`;
      const candidate =
        baseCode.slice(0, MAX_CODE_LENGTH - suffix.length) + suffix;

      const existing = await this.aiPromptTemplateRepository.findOne({
        where: { code: candidate },
      });

      if (!existing) {
        return candidate;
      }
    }

    throw new ConflictException(
      `No se pudo derivar un codigo libre a partir de "${baseCode}": ` +
        'elige un nombre mas distintivo o suministra el codigo a mano.',
    );
  }

  private async assertCodeAvailable(code: string): Promise<void> {
    const existing = await this.aiPromptTemplateRepository.findOne({
      where: { code },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe un prompt con el codigo "${code}"`,
      );
    }
  }
}
