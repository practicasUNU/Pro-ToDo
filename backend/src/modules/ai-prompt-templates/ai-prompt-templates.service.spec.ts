import { ConflictException, NotFoundException } from '@nestjs/common';

import { AiPromptTemplatesService } from './ai-prompt-templates.service';

import type { AiPromptTemplate } from './entities/ai-prompt-template.entity';
import type { CreateAiPromptTemplateDto } from './dto/create-ai-prompt-template.dto';
import type { Repository } from 'typeorm';

const PROMPT_ID = '3c9a1f52-8b47-4d21-9e06-5a7b8c9d0e1f';
const OTHER_PROMPT_ID = '9f8e7d6c-5b4a-4321-8765-1a2b3c4d5e6f';
const AUTHOR_ID = 'd4e5f6a7-b8c9-4012-a345-6b7c8d9e0f12';
const PROMPT_CODE = 'EXTRACCION_NOTICIA_ES';

const buildPrompt = (
  overrides: Partial<AiPromptTemplate> = {},
): AiPromptTemplate =>
  ({
    id: PROMPT_ID,
    code: PROMPT_CODE,
    name: 'extraccion-noticia-es',
    description: 'Extrae titular y resumen de un correo en espanol',
    promptText: 'Extrae el titular de: {{parsed_email.clean_body}}',
    active: true,
    createdById: AUTHOR_ID,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }) as AiPromptTemplate;

const buildCreateDto = (
  overrides: Partial<CreateAiPromptTemplateDto> = {},
): CreateAiPromptTemplateDto => ({
  code: PROMPT_CODE,
  name: 'extraccion-noticia-es',
  description: 'Extrae titular y resumen de un correo en espanol',
  promptText: 'Extrae el titular de: {{parsed_email.clean_body}}',
  ...overrides,
});

interface Harness {
  readonly service: AiPromptTemplatesService;
  readonly repository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
}

/**
 * Servicio con el repositorio doblado.
 *
 * Cero red y cero base de datos: `create` fusiona el parcial en una entidad
 * completa —que es lo que hace el repositorio real— y `save` devuelve lo que
 * recibe.
 */
const buildHarness = (): Harness => {
  const repository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn((partial: Partial<AiPromptTemplate>) =>
      buildPrompt(partial),
    ),
    save: jest.fn((entity: AiPromptTemplate) => Promise.resolve(entity)),
  };

  const service = new AiPromptTemplatesService(
    repository as unknown as Repository<AiPromptTemplate>,
  );

  return { service, repository };
};

describe('AiPromptTemplatesService · repositorio de prompts de IA', () => {
  describe('1. Listado', () => {
    it('1.1 deberia filtrar por activo y ordenar por nombre', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([buildPrompt()]);

      // 2. Act
      await service.findAll();

      // 3. Assert: el consumidor natural es el selector del nodo IA, donde el
      //    operador busca por nombre y no por fecha.
      expect(repository.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { name: 'ASC' },
      });
    });

    it('1.2 deberia incluir los retirados cuando se piden', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([]);

      // 2. Act
      await service.findAll(false);

      // 3. Assert: sin filtro de estado, para la tabla administrativa.
      expect(repository.find).toHaveBeenCalledWith({
        where: {},
        order: { name: 'ASC' },
      });
    });

    it('1.3 no deberia exponer el cuerpo del prompt en el listado', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.find.mockResolvedValue([buildPrompt()]);

      // 2. Act
      const [summary] = await service.findAll();

      // 3. Assert: la tabla muestra decenas de filas y una instruccion puede
      //    ocupar kilobytes; el cuerpo se pide en el detalle.
      expect(summary).not.toHaveProperty('promptText');
      expect(summary?.name).toBe('extraccion-noticia-es');
    });
  });

  describe('2. Consulta individual', () => {
    it('2.1 deberia devolver el detalle con la instruccion completa', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act
      const detail = await service.findOne(PROMPT_ID);

      // 3. Assert
      expect(detail.id).toBe(PROMPT_ID);
      expect(detail.promptText).toBe(
        'Extrae el titular de: {{parsed_email.clean_body}}',
      );
      expect(detail.createdById).toBe(AUTHOR_ID);
    });

    it('2.2 deberia lanzar NotFoundException con un id inexistente', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.findOne(PROMPT_ID)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne(PROMPT_ID)).rejects.toThrow(
        `Prompt con id "${PROMPT_ID}" no encontrado`,
      );
    });

    it('2.3 findByName deberia devolver null en vez de lanzar', async () => {
      // 1. Arrange: el consumidor previsto es la estrategia del nodo IA, que
      //    ante un prompt ausente debe emitir un NodeResult fallido y no una
      //    excepcion HTTP.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act
      const prompt = await service.findByName('  extraccion-noticia-es  ');

      // 3. Assert: y busca por el nombre ya recortado.
      expect(prompt).toBeNull();
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { name: 'extraccion-noticia-es' },
      });
    });
  });

  describe('3. Alta', () => {
    it('3.1 deberia asignar la autoria recibida y recortar el nombre', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null) // assertNameAvailable: nombre libre
        .mockResolvedValueOnce(null) // assertCodeAvailable: codigo libre
        .mockResolvedValueOnce(buildPrompt()); // findOne final

      // 2. Act
      await service.create(
        buildCreateDto({ name: '  extraccion-noticia-es  ' }),
        AUTHOR_ID,
      );

      // 3. Assert: la autoria viene del JWT, nunca del cuerpo.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'extraccion-noticia-es',
          createdById: AUTHOR_ID,
        }),
      );
    });

    it('3.2 deberia ignorar el active del DTO: todo prompt nace activo', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildPrompt());

      // 2. Act
      await service.create(buildCreateDto({ active: false }), AUTHOR_ID);

      // 3. Assert: `active` existe en el DTO solo para que la EDICION pueda
      //    reactivar un prompt retirado.
      expect(repository.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ active: false }),
      );
    });

    it('3.3 deberia normalizar una descripcion ausente a null', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildPrompt());
      const dto = buildCreateDto();
      delete (dto as { description?: string }).description;

      // 2. Act
      await service.create(dto, AUTHOR_ID);

      // 3. Assert: la columna es nullable, y `undefined` no es un valor que
      //    PostgreSQL entienda.
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ description: null }),
      );
    });

    it('3.4 deberia rechazar un codigo ya registrado', async () => {
      // 1. Arrange 📐: el nombre esta libre y el codigo no. Las dos guardas son
      //    independientes, asi que se encadenan las respuestas del repositorio
      //    en el orden en que el servicio las consulta.
      const { service, repository } = buildHarness();
      repository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildPrompt());

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(service.create(buildCreateDto(), AUTHOR_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('3.5 deberia rechazar un nombre ya registrado', async () => {
      // 1. Arrange: no hay filtro global del 23505, asi que sin esta guarda el
      //    error de constraint subiria como 500.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act & 3. Assert
      await expect(service.create(buildCreateDto(), AUTHOR_ID)).rejects.toThrow(
        ConflictException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('4. Edicion', () => {
    it('4.1 deberia dejar intactos los campos omitidos', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act: solo se toca la instruccion.
      await service.update(PROMPT_ID, { promptText: 'Resume: {{x.y}}' });

      // 3. Assert
      const [saved] = repository.save.mock.calls[0] as [AiPromptTemplate];
      expect(saved.promptText).toBe('Resume: {{x.y}}');
      expect(saved.name).toBe('extraccion-noticia-es');
      expect(saved.description).toBe(
        'Extrae titular y resumen de un correo en espanol',
      );
    });

    it('4.2 deberia permitir reactivar un prompt retirado', async () => {
      // 1. Arrange: `softDelete` solo sabe apagar; esta es la unica via de vuelta.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt({ active: false }));

      // 2. Act
      await service.update(PROMPT_ID, { active: true });

      // 3. Assert
      const [saved] = repository.save.mock.calls[0] as [AiPromptTemplate];
      expect(saved.active).toBe(true);
    });

    it('4.3 no deberia considerar colision conservar el propio nombre', async () => {
      // 1. Arrange: la fila que devuelve la comprobacion es ella misma.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act & 3. Assert
      await expect(
        service.update(PROMPT_ID, { name: 'extraccion-noticia-es' }),
      ).resolves.toBeDefined();
    });

    it('4.4 deberia rechazar el nombre de OTRO prompt', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(
        buildPrompt({ id: OTHER_PROMPT_ID, name: 'otro-prompt' }),
      );

      // 2. Act & 3. Assert
      await expect(
        service.update(PROMPT_ID, { name: 'otro-prompt' }),
      ).rejects.toThrow(ConflictException);
    });

    it('4.5 deberia lanzar NotFoundException si el prompt no existe', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(
        service.update(PROMPT_ID, { promptText: 'x' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('5. Retirada (borrado logico)', () => {
    it('5.1 deberia apagar el prompt sin borrar la fila', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act
      await service.softDelete(PROMPT_ID);

      // 3. Assert: una ejecucion ya trazada apunta al prompt con el que se
      //    genero su salida; borrarlo dejaria la auditoria coja.
      const [saved] = repository.save.mock.calls[0] as [AiPromptTemplate];
      expect(saved.active).toBe(false);
      expect(saved.id).toBe(PROMPT_ID);
    });

    it('5.2 deberia lanzar NotFoundException si el prompt no existe', async () => {
      // 1. Arrange
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act & 3. Assert
      await expect(service.softDelete(PROMPT_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('6. Resolucion por clave de maquina', () => {
    it('6.1 findByCode deberia devolver la entidad buscando por codigo', async () => {
      // 1. Arrange 📐
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act ⚙️
      const prompt = await service.findByCode(PROMPT_CODE);

      // 3. Assert 🎯
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { code: PROMPT_CODE },
      });
      expect(prompt.code).toBe(PROMPT_CODE);
      // Entidad y no DTO: el consumidor es interno (la estrategia del nodo IA).
      expect(prompt.promptText).toBeDefined();
    });

    it('6.2 findByCode deberia LANZAR con un codigo inexistente', async () => {
      // 1. Arrange 📐: al reves que `findByName`, que devuelve null. Un codigo
      //    escrito en los params de un nodo que no resuelve es configuracion
      //    rota, no una busqueda sin resultados.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(null);

      // 2. Act ⚙️ & 3. Assert 🎯
      await expect(service.findByCode('NO_EXISTE')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('6.3 findOneByCode deberia derivar los namespaces del texto del prompt', async () => {
      // 1. Arrange 📐: dos marcadores de dos namespaces distintos, mas uno
      //    repetido, para comprobar que se deduplica.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(
        buildPrompt({
          promptText:
            'Redacta {{parsed_email.clean_body}} con {{scraped_web.full_article_content}} y {{parsed_email.clean_title}}.',
        }),
      );

      // 2. Act ⚙️
      const detail = await service.findOneByCode(PROMPT_CODE);

      // 3. Assert 🎯
      expect(detail.requiredNamespaces).toEqual([
        'parsed_email',
        'scraped_web',
      ]);
    });

    it('6.4 deberia devolver una lista vacia si el prompt no lleva marcadores', async () => {
      // 1. Arrange 📐: un prompt puede ser texto fijo; eso no es un error.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(
        buildPrompt({ promptText: 'Resume el material recibido.' }),
      );

      // 2. Act ⚙️
      const detail = await service.findOneByCode(PROMPT_CODE);

      // 3. Assert 🎯
      expect(detail.requiredNamespaces).toEqual([]);
    });
  });

  describe('7. Inmutabilidad del codigo', () => {
    it('7.1 update NO deberia cambiar el codigo aunque venga en el DTO', async () => {
      // 1. Arrange 📐: cambiarlo dejaria a cada flujo que lo cita en sus
      //    `params` apuntando a un prompt inexistente, y el fallo no saldria
      //    hasta la siguiente ejecucion.
      const { service, repository } = buildHarness();
      repository.findOne.mockResolvedValue(buildPrompt());

      // 2. Act ⚙️
      await service.update(PROMPT_ID, {
        code: 'OTRO_CODIGO',
      });

      // 3. Assert 🎯
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ code: PROMPT_CODE }),
      );
    });
  });
});
