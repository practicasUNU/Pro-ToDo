import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { ALLOWED_NAMESPACES, TemplatesService } from './templates.service';

import type { HtmlTemplate } from './entities/html-template.entity';
import type { Repository } from 'typeorm';

const AUTHOR_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';

/** Plantilla ya persistida, para los caminos de lectura y mutacion. */
const STORED_TEMPLATE: HtmlTemplate = {
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: 'Cuerpo de noticia con titular y resumen',
  htmlContent: '<h1>{{parsed_email.clean_title}}</h1>',
  requiredVariables: ['parsed_email.clean_title'],
  createdById: AUTHOR_ID,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

type TemplateRepositoryMock = jest.Mocked<
  Pick<
    Repository<HtmlTemplate>,
    'create' | 'save' | 'find' | 'findOne' | 'remove'
  >
>;

/** Repositorio doble: `create` refleja el literal, `save` lo resuelve tal cual. */
const buildRepository = (): TemplateRepositoryMock =>
  ({
    create: jest.fn((entity: Partial<HtmlTemplate>) => entity as HtmlTemplate),
    save: jest.fn((entity: HtmlTemplate) => Promise.resolve(entity)),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    remove: jest.fn((entity: HtmlTemplate) => Promise.resolve(entity)),
  }) as unknown as TemplateRepositoryMock;

/** El doble no implementa `Repository` entero; el cast se aisla aqui. */
const buildService = (repository: TemplateRepositoryMock): TemplatesService =>
  new TemplatesService(repository as unknown as Repository<HtmlTemplate>);

/**
 * Ejecuta la promesa esperando una `BadRequestException` y devuelve su cuerpo,
 * para poder aseverar tambien el `invalidVariable` y no solo el tipo.
 */
const expectBadRequest = async (
  action: Promise<unknown>,
): Promise<Record<string, unknown>> => {
  try {
    await action;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<
      string,
      unknown
    >;
  }

  throw new Error('Se esperaba una BadRequestException y no se lanzo ninguna.');
};

describe('TemplatesService', () => {
  describe('1. Validacion estatica de namespaces', () => {
    it('1.1 deberia guardar una plantilla con variables de la lista blanca', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act
      const result = await service.create(
        {
          name: 'noticia-basica',
          htmlContent:
            '<h1>{{parsed_email.clean_title}}</h1><p>{{ llm_response.summary }}</p>',
        },
        AUTHOR_ID,
      );

      // 3. Assert
      expect(result.requiredVariables).toEqual([
        'parsed_email.clean_title',
        'llm_response.summary',
      ]);
      expect(result.createdById).toBe(AUTHOR_ID);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('1.2 deberia deduplicar las rutas repetidas conservando el orden', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const result = await service.create(
        {
          name: 'con-repeticiones',
          htmlContent:
            '<h1>{{llm_response.title}}</h1><h2>{{llm_response.title}}</h2><p>{{raw_email.body}}</p>',
        },
        AUTHOR_ID,
      );

      // 3. Assert
      expect(result.requiredVariables).toEqual([
        'llm_response.title',
        'raw_email.body',
      ]);
    });

    it('1.3 deberia lanzar BadRequestException si el namespace es desconocido', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          { name: 'mala', htmlContent: '<p>{{contacto.telefono}}</p>' },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.invalidVariable).toBe('contacto.telefono');
      expect(response.message).toContain(
        'Namespace no permitido o desconocido',
      );
      expect(response.message).toContain('"contacto"');
    });

    it('1.4 deberia rechazar un namespace desconocido tambien en rutas profundas', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'profunda-mala',
            htmlContent: '<p>{{contacto.datos.movil}}</p>',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert: la raiz se valida sin importar la profundidad de la ruta
      expect(response.invalidVariable).toBe('contacto.datos.movil');
    });

    it('1.5 deberia aceptar rutas profundas con indice y normalizarlas', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const result = await service.create(
        {
          name: 'con-indices',
          htmlContent:
            '<h1>{{llm_response.articles.[0].title}}</h1><p>{{scraped_web.meta.author}}</p>',
        },
        AUTHOR_ID,
      );

      // 3. Assert: `.[0]` pasa a `.0`, la forma que navega `resolvePath`
      expect(result.requiredVariables).toEqual([
        'llm_response.articles.0.title',
        'scraped_web.meta.author',
      ]);
    });

    it('1.6 deberia rechazar el triple-stash por desactivar el escapado de HTML', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'sin-escapar',
            htmlContent: '<p>{{{llm_response.summary}}}</p>',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.invalidVariable).toBe('{{{');
    });

    it('1.7 deberia rechazar los bloques y helpers de Handlebars', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'con-logica',
            htmlContent:
              '{{#if llm_response.summary}}<p>{{llm_response.summary}}</p>{{/if}}',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.invalidVariable).toBe('{{#');
    });

    it('1.8 deberia rechazar un namespace suelto sin ruta', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act: `{{titulo}}` no es interpolable y el patron no lo reconoce
      const response = await expectBadRequest(
        service.create(
          { name: 'suelta', htmlContent: '<h1>{{titulo}}</h1>' },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.invalidVariable).toBe('{{titulo}}');
      expect(response.message).toContain('Marcador no interpretable');
    });

    it('1.9 deberia guardar un HTML sin variables con requiredVariables vacio', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const result = await service.create(
        { name: 'estatica', htmlContent: '<p>Texto fijo sin marcadores</p>' },
        AUTHOR_ID,
      );

      // 3. Assert
      expect(result.requiredVariables).toEqual([]);
    });

    it('1.10 deberia cubrir los seis namespaces declarados en la lista blanca', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());
      const htmlContent = ALLOWED_NAMESPACES.map(
        (namespace) => `<p>{{${namespace}.campo}}</p>`,
      ).join('');

      // 2. Act
      const result = await service.create(
        { name: 'todos-los-namespaces', htmlContent },
        AUTHOR_ID,
      );

      // 3. Assert
      expect(result.requiredVariables).toEqual(
        ALLOWED_NAMESPACES.map((namespace) => `${namespace}.campo`),
      );
    });
  });

  describe('2. Lectura', () => {
    it('2.1 deberia listar solo las plantillas activas por defecto', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.find.mockResolvedValue([STORED_TEMPLATE]);
      const service = buildService(repository);

      // 2. Act
      const result = await service.findAll();

      // 3. Assert
      expect(result).toEqual([STORED_TEMPLATE]);
      expect(repository.find).toHaveBeenCalledWith({
        where: { active: true },
        order: { name: 'ASC' },
      });
    });

    it('2.2 deberia incluir las desactivadas cuando onlyActive es false', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act
      await service.findAll(false);

      // 3. Assert
      expect(repository.find).toHaveBeenCalledWith({
        where: {},
        order: { name: 'ASC' },
      });
    });

    it('2.3 deberia lanzar NotFoundException si el id no existe', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act & 3. Assert
      await expect(service.findOne(TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('3. Unicidad del nombre', () => {
    it('3.1 deberia lanzar ConflictException si el nombre ya existe', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue(STORED_TEMPLATE);
      const service = buildService(repository);

      // 2. Act & 3. Assert
      await expect(
        service.create(
          { name: 'noticia-basica', htmlContent: '<p>otro</p>' },
          AUTHOR_ID,
        ),
      ).rejects.toThrow(ConflictException);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('3.2 no deberia dar conflicto al renombrar una plantilla consigo misma', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({ ...STORED_TEMPLATE });
      const service = buildService(repository);

      // 2. Act
      const result = await service.update(TEMPLATE_ID, {
        name: 'noticia-basica',
      });

      // 3. Assert
      expect(result.name).toBe('noticia-basica');
    });
  });

  describe('4. Actualizacion', () => {
    it('4.1 deberia recalcular requiredVariables al cambiar el HTML', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({ ...STORED_TEMPLATE });
      const service = buildService(repository);

      // 2. Act
      const result = await service.update(TEMPLATE_ID, {
        htmlContent: '<p>{{validated_drupal_json.body}}</p>',
      });

      // 3. Assert: las variables antiguas no sobreviven al cambio de plantilla
      expect(result.requiredVariables).toEqual(['validated_drupal_json.body']);
      expect(result.htmlContent).toBe('<p>{{validated_drupal_json.body}}</p>');
    });

    it('4.2 no deberia persistir un HTML invalido ni tocar las variables previas', async () => {
      // 1. Arrange
      const stored = { ...STORED_TEMPLATE };
      const repository = buildRepository();
      repository.findOne.mockResolvedValue(stored);
      const service = buildService(repository);

      // 2. Act
      await expectBadRequest(
        service.update(TEMPLATE_ID, {
          htmlContent: '<p>{{contacto.telefono}}</p>',
        }),
      );

      // 3. Assert: la validacion precede a la asignacion, asi que nada cambio
      expect(stored.requiredVariables).toEqual(['parsed_email.clean_title']);
      expect(stored.htmlContent).toBe('<h1>{{parsed_email.clean_title}}</h1>');
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('5. Borrado logico', () => {
    it('5.1 deberia marcar active en false sin eliminar el registro', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({ ...STORED_TEMPLATE });
      const service = buildService(repository);

      // 2. Act
      const result = await service.softDelete(TEMPLATE_ID);

      // 3. Assert
      expect(result.active).toBe(false);
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it('5.2 deberia lanzar NotFoundException al desactivar un id inexistente', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act & 3. Assert
      await expect(service.softDelete(TEMPLATE_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.save).not.toHaveBeenCalled();
    });
  });
});
