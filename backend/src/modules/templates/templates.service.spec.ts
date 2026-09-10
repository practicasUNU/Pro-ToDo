import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

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

/**
 * El doble no implementa `Repository` entero; el cast se aisla aqui.
 *
 * El renderer va REAL: es puro (sin repositorio, red ni estado), y la vista
 * previa se prueba mejor comprobando el markup que sale de verdad que
 * aseverando sobre un doble.
 */
const buildService = (repository: TemplateRepositoryMock): TemplatesService =>
  new TemplatesService(
    repository as unknown as Repository<HtmlTemplate>,
    createTemplateRendererService(),
  );

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

    // `softDelete` solo sabe apagar la plantilla; reactivarla pasa por aqui. Sin
    // estos casos, la tabla administrativa mostraria filas inactivas que ninguna
    // ruta puede recuperar.
    it('4.3 deberia reactivar una plantilla retirada', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        active: false,
      });
      const service = buildService(repository);

      // 2. Act
      const result = await service.update(TEMPLATE_ID, { active: true });

      // 3. Assert
      expect(result.active).toBe(true);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('4.4 deberia retirar una plantilla activa desde la edicion', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({ ...STORED_TEMPLATE });
      const service = buildService(repository);

      // 2. Act
      const result = await service.update(TEMPLATE_ID, { active: false });

      // 3. Assert
      expect(result.active).toBe(false);
    });

    it('4.5 NO deberia tocar active cuando el DTO lo omite', async () => {
      // 1. Arrange: parte de una plantilla ya retirada
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        active: false,
      });
      const service = buildService(repository);

      // 2. Act: se edita solo la descripcion
      const result = await service.update(TEMPLATE_ID, {
        description: 'Descripcion nueva',
      });

      // 3. Assert: editar el texto no puede resucitar una plantilla retirada
      expect(result.active).toBe(false);
      expect(result.description).toBe('Descripcion nueva');
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

  describe('6. Previsualizacion', () => {
    it('6.1 deberia autogenerar marcadores por cada variable requerida', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        htmlContent: '<h1>{{parsed_email.clean_title}}</h1>',
        requiredVariables: ['parsed_email.clean_title'],
      });
      const service = buildService(repository);

      // 2. Act
      const { compiledMarkup } = await service.previewTemplate(TEMPLATE_ID, {});

      // 3. Assert: sin datos del cliente, la maqueta se ve igualmente
      expect(compiledMarkup).toBe('<h1>«parsed_email.clean_title»</h1>');
    });

    it('6.2 deberia dejar que samplePayload gane sobre el marcador', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        htmlContent:
          '<h1>{{parsed_email.clean_title}}</h1><p>{{llm_response.summary}}</p>',
        requiredVariables: ['parsed_email.clean_title', 'llm_response.summary'],
      });
      const service = buildService(repository);

      // 2. Act: solo se aporta una de las dos rutas
      const { compiledMarkup } = await service.previewTemplate(TEMPLATE_ID, {
        samplePayload: {
          parsed_email: { clean_title: 'Innovacion en Madrid' },
        },
      });

      // 3. Assert: la aportada sale real, la otra sigue como marcador
      expect(compiledMarkup).toBe(
        '<h1>Innovacion en Madrid</h1><p>«llm_response.summary»</p>',
      );
    });

    it('6.3 deberia construir el anidamiento de una ruta profunda', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        htmlContent: '<h2>{{llm_response.articles.[0].title}}</h2>',
        requiredVariables: ['llm_response.articles.0.title'],
      });
      const service = buildService(repository);

      // 2. Act
      const { compiledMarkup } = await service.previewTemplate(TEMPLATE_ID, {});

      // 3. Assert
      expect(compiledMarkup).toBe('<h2>«llm_response.articles.0.title»</h2>');
    });

    it('6.4 deberia escapar el HTML que llegue por samplePayload', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        htmlContent: '<h1>{{parsed_email.clean_title}}</h1>',
        requiredVariables: ['parsed_email.clean_title'],
      });
      const service = buildService(repository);

      // 2. Act
      const { compiledMarkup } = await service.previewTemplate(TEMPLATE_ID, {
        samplePayload: {
          parsed_email: { clean_title: '<script>alert(1)</script>' },
        },
      });

      // 3. Assert
      expect(compiledMarkup).not.toContain('<script>');
      expect(compiledMarkup).toContain('&lt;script&gt;');
    });

    it('6.5 deberia previsualizar tambien una plantilla desactivada', async () => {
      // 1. Arrange
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        active: false,
        htmlContent: '<p>fija</p>',
        requiredVariables: [],
      });
      const service = buildService(repository);

      // 2. Act & 3. Assert: revisar por que se retiro una es motivo para conservarla
      await expect(service.previewTemplate(TEMPLATE_ID, {})).resolves.toEqual({
        compiledMarkup: '<p>fija</p>',
      });
    });

    it('6.6 deberia lanzar NotFoundException si la plantilla no existe', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act & 3. Assert
      await expect(service.previewTemplate(TEMPLATE_ID, {})).rejects.toThrow(
        NotFoundException,
      );
    });

    it('6.7 deberia lanzar BadRequestException si la plantilla no compila', async () => {
      // 1. Arrange: HTML con un bloque sin cerrar; solo alcanzable por SQL directo,
      // porque el alta lo habria rechazado antes de guardarlo
      const repository = buildRepository();
      repository.findOne.mockResolvedValue({
        ...STORED_TEMPLATE,
        htmlContent: '{{#if algo}}<p>roto</p>',
        requiredVariables: [],
      });
      const service = buildService(repository);

      // 2. Act
      const response = await expectBadRequest(
        service.previewTemplate(TEMPLATE_ID, {}),
      );

      // 3. Assert
      expect(response.message).toContain('no compila');
    });
  });

  describe('7. Markup no publicable', () => {
    it('7.1 deberia rechazar una plantilla con <script>', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'con-script',
            htmlContent:
              '<p>{{parsed_email.clean_title}}</p><script>alert(1)</script>',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert: el saneado al compilar lo purgaria igualmente; esto es lo que
      // hace que el autor se entere en vez de descubrirlo publicado a medias.
      expect(response.message).toContain('no se puede publicar');
      expect(response.sanitizedHtml).toBe(
        '<p>{{parsed_email.clean_title}}</p>',
      );
      // `violations` es lo que permite al editor subrayar el sitio exacto en
      // lugar de mostrar solo un parrafo generico.
      expect(response.violations).toEqual([
        {
          target: 'script',
          type: 'tag',
          message: 'Etiqueta <script> no permitida',
        },
      ]);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('7.2 deberia rechazar un atributo de evento en linea', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'con-onerror',
            htmlContent: '<img src="x" onerror="alert(1)">',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.violations).toEqual([
        {
          target: 'onerror',
          type: 'attribute',
          message: "Atributo de evento 'onerror' no permitido",
        },
      ]);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('7.3 deberia rechazar un enlace con protocolo javascript:', async () => {
      // 1. Arrange
      const repository = buildRepository();
      const service = buildService(repository);

      // 2. Act
      const response = await expectBadRequest(
        service.create(
          {
            name: 'con-js',
            htmlContent: '<a href="javascript:alert(1)">click</a>',
          },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.violations).toEqual([
        {
          target: 'javascript:',
          type: 'protocol',
          message: "Protocolo 'javascript:' no permitido en el atributo 'href'",
        },
      ]);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('7.4 deberia aceptar las etiquetas nuevas de la lista blanca', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act
      const result = await service.create(
        {
          name: 'con-figura',
          htmlContent:
            '<figure><img src="https://x/a.png" alt="foto" />' +
            '<figcaption>{{parsed_email.clean_title}}</figcaption></figure>',
        },
        AUTHOR_ID,
      );

      // 3. Assert
      expect(result.requiredVariables).toEqual(['parsed_email.clean_title']);
    });

    it('7.5 NO deberia rechazar por una simple normalizacion del parser', async () => {
      // 1. Arrange
      const service = buildService(buildRepository());

      // 2. Act: `<br>` se normaliza a `<br />`, pero eso no es un filtrado
      const result = await service.create(
        { name: 'con-br', htmlContent: '<p>hola<br>mundo</p>' },
        AUTHOR_ID,
      );

      // 3. Assert: el HTML se guarda TAL CUAL lo escribio el autor; la guarda
      // solo comprueba, no reescribe.
      expect(result.htmlContent).toBe('<p>hola<br>mundo</p>');
    });

    it('7.6 deberia rechazar al actualizar sin tocar la entidad', async () => {
      // 1. Arrange
      const stored = { ...STORED_TEMPLATE };
      const repository = buildRepository();
      repository.findOne.mockResolvedValue(stored);
      const service = buildService(repository);

      // 2. Act
      const response = await expectBadRequest(
        service.update(TEMPLATE_ID, {
          htmlContent: '<div onclick="alert(1)">x</div>',
        }),
      );

      // 3. Assert
      expect(response.violations).toEqual([
        {
          target: 'onclick',
          type: 'attribute',
          message: "Atributo de evento 'onclick' no permitido",
        },
      ]);
      expect(stored.htmlContent).toBe('<h1>{{parsed_email.clean_title}}</h1>');
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  describe('8. Infracciones localizables de variables', () => {
    /**
     * Invariante compartida por los tres emisores de tipo `variable`: el
     * `target` es una subcadena VERBATIM del HTML. Si no lo fuera, el editor
     * buscaria un texto que no existe y no subrayaria nada.
     */
    const expectVerbatimTarget = (
      response: Record<string, unknown>,
      htmlContent: string,
    ): void => {
      const [violation] = response.violations as Array<Record<string, unknown>>;

      expect(violation?.type).toBe('variable');
      expect(htmlContent).toContain(violation?.target as string);
    };

    it('8.1 deberia localizar un namespace fuera de la lista blanca', async () => {
      // 1. Arrange: con espacios dentro de las llaves, que es donde un target
      //    reconstruido a mano dejaria de coincidir con el documento.
      const repository = buildRepository();
      const htmlContent = '<h1>{{ bad_ns.titulo }}</h1>';

      // 2. Act
      const response = await expectBadRequest(
        buildService(repository).create(
          { name: 'ns-malo', htmlContent },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expect(response.violations).toEqual([
        {
          target: '{{ bad_ns.titulo }}',
          type: 'variable',
          // La lista se deriva de la constante y no se transcribe: anadir un
          // namespace nuevo no debe romper esta prueba, que verifica el
          // localizador de infracciones, no el contenido de la lista blanca.
          message: `Namespace 'bad_ns' no permitido. Solo se admiten: ${ALLOWED_NAMESPACES.join(', ')}.`,
        },
      ]);
      expectVerbatimTarget(response, htmlContent);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('8.2 deberia localizar la sintaxis prohibida', async () => {
      // 1. Arrange
      const htmlContent = '<p>{{#if parsed_email.clean_title}}x{{/if}}</p>';

      // 2. Act
      const response = await expectBadRequest(
        buildService(buildRepository()).create(
          { name: 'con-bloque', htmlContent },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expectVerbatimTarget(response, htmlContent);
      expect(
        (response.violations as Array<Record<string, unknown>>)[0]?.target,
      ).toBe('{{#');
    });

    it('8.3 deberia localizar un marcador no interpretable', async () => {
      // 1. Arrange: namespace suelto, sin ruta
      const htmlContent = '<h1>{{titulo}}</h1>';

      // 2. Act
      const response = await expectBadRequest(
        buildService(buildRepository()).create(
          { name: 'suelto', htmlContent },
          AUTHOR_ID,
        ),
      );

      // 3. Assert
      expectVerbatimTarget(response, htmlContent);

      const [violation] = response.violations as Array<Record<string, unknown>>;

      expect(violation?.target).toBe('{{titulo}}');
      expect(violation?.message).toContain('no interpretable');
    });
  });
});
