import { NotFoundException } from '@nestjs/common';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';

import { TemplateMapperStrategy } from './template-mapper.strategy';

import type { HtmlTemplate } from '@modules/templates/entities/html-template.entity';
import type { TemplatesService } from '@modules/templates/templates.service';

const EXECUTION_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const WORKFLOW_ID = 'f0e9d8c7-6b5a-4938-8271-0a1b2c3d4e5f';
const INITIAL_STEP = 'mapeador_plantilla';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';
const AUTHOR_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';

type TemplatesServiceMock = jest.Mocked<Pick<TemplatesService, 'findOne'>>;

/** Plantilla completa; los tests sobrescriben solo lo que les concierne. */
const buildTemplate = (
  overrides: Partial<HtmlTemplate> = {},
): HtmlTemplate => ({
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: null,
  htmlContent:
    '<h1>{{parsed_email.clean_title}}</h1><p>{{llm_response.summary}}</p>',
  requiredVariables: ['parsed_email.clean_title', 'llm_response.summary'],
  createdById: AUTHOR_ID,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildService = (): TemplatesServiceMock => ({ findOne: jest.fn() });

/** El doble no implementa `TemplatesService` entero; el cast se aisla aqui. */
const buildStrategy = (service: TemplatesServiceMock): TemplateMapperStrategy =>
  new TemplateMapperStrategy(service as unknown as TemplatesService);

/** Contexto con los namespaces que la plantilla por defecto espera. */
const buildContext = (): StatePayloadContext => {
  const context = new StatePayloadContext(
    EXECUTION_ID,
    WORKFLOW_ID,
    INITIAL_STEP,
  );

  context.setNamespace('parsed_email', {
    clean_title: 'Innovacion en Madrid',
  });
  context.setNamespace('llm_response', {
    summary: 'Resumen estructurado del articulo.',
  });

  return context;
};

describe('TemplateMapperStrategy', () => {
  it('0.1 deberia declararse como el nodo MAPEADOR_PLANTILLA', () => {
    // 1. Arrange & 2. Act
    const strategy = buildStrategy(buildService());

    // 3. Assert: la factoria indexa por este valor
    expect(strategy.nodeType).toBe(NodeType.MAPEADOR_PLANTILLA);
  });

  describe('1. Compilacion contra el contexto', () => {
    it('1.1 deberia interpolar la plantilla almacenada', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).toBe(
        '<h1>Innovacion en Madrid</h1><p>Resumen estructurado del articulo.</p>',
      );
      expect(service.findOne).toHaveBeenCalledWith(TEMPLATE_ID);
    });

    it('1.2 deberia sellar la ejecucion con un mapped_at en ISO 8601', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      const mappedAt = result.data?.mapped_at;
      expect(typeof mappedAt).toBe('string');
      expect(new Date(mappedAt as string).toISOString()).toBe(mappedAt);
    });

    it('1.3 deberia resolver rutas anidadas con indice', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({
          htmlContent: '<h2>{{llm_response.articles.[0].title}}</h2>',
          requiredVariables: ['llm_response.articles.0.title'],
        }),
      );
      const strategy = buildStrategy(service);
      const context = buildContext();
      context.setNamespace('llm_response', {
        articles: [{ title: 'Primer titular' }],
      });

      // 2. Act
      const result = await strategy.execute(context, {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).toBe('<h2>Primer titular</h2>');
    });

    it('1.4 deberia escapar el HTML que llegue en un valor del contexto', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({
          htmlContent: '<h1>{{parsed_email.clean_title}}</h1>',
          requiredVariables: ['parsed_email.clean_title'],
        }),
      );
      const strategy = buildStrategy(service);
      const context = buildContext();
      context.setNamespace('parsed_email', {
        clean_title: '<script>alert(1)</script>',
      });

      // 2. Act
      const result = await strategy.execute(context, {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert: sin triple-stash, ningun valor puede inyectar markup
      expect(result.data?.compiled_markup).not.toContain('<script>');
      expect(result.data?.compiled_markup).toContain('&lt;script&gt;');
    });

    it('1.5 deberia admitir rawTemplate como fallback sin base de datos', async () => {
      // 1. Arrange
      const service = buildService();
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        rawTemplate: '<p>{{llm_response.summary}}</p>',
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).toBe(
        '<p>Resumen estructurado del articulo.</p>',
      );
      expect(service.findOne).not.toHaveBeenCalled();
    });
  });

  describe('2. Fallos GRAVE', () => {
    it('2.1 deberia fallar GRAVE si el templateId no existe', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockRejectedValue(
        new NotFoundException(
          `Plantilla con id "${TEMPLATE_ID}" no encontrada`,
        ),
      );
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert: GRAVE y no URGENTE, para que el motor pueda reintentarlo
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain(
        'No se pudo resolver la plantilla',
      );
    });

    it('2.2 deberia fallar GRAVE si la plantilla esta desactivada', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate({ active: false }));
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('desactivada');
    });

    it('2.3 deberia fallar GRAVE sin templateId ni rawTemplate', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildService());

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toContain('templateId');
    });

    it('2.4 deberia reportar TODAS las variables ausentes del contexto', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({
          htmlContent:
            '<h1>{{scraped_web.headline}}</h1><p>{{raw_email.body}}</p>',
          requiredVariables: ['scraped_web.headline', 'raw_email.body'],
        }),
      );
      const strategy = buildStrategy(service);

      // 2. Act: el contexto solo trae parsed_email y llm_response
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert: el pre-chequeo informa de las dos de golpe, no solo de la
      // primera, que es lo unico que daria Handlebars en modo estricto
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.missingFields).toEqual([
        'scraped_web.headline',
        'raw_email.body',
      ]);
    });

    it('2.5 deberia fallar GRAVE si rawTemplate referencia una variable ausente', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildService());

      // 2. Act: sin requiredVariables, el corte lo pone el modo estricto
      const result = await strategy.execute(buildContext(), {
        rawTemplate: '<p>{{scraped_web.headline}}</p>',
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.message).toContain('Fallo al compilar la plantilla');
    });
  });

  describe('3. Inmutabilidad del contexto', () => {
    it('3.1 no deberia mutar el contexto: escribir el resultado es del motor', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);
      const context = buildContext();
      const before = context.getAllContext();

      // 2. Act
      const result = await strategy.execute(context, {
        templateId: TEMPLATE_ID,
        outputNamespace: 'rendered_html',
      });

      // 3. Assert: el markup viaja en `data` y el contexto queda intacto;
      // `FsmEngineService` lo depositara en el `outputNamespace` del nodo
      expect(result.success).toBe(true);
      expect(context.getAllContext()).toEqual(before);
      expect(context.getNamespace('rendered_html')).toBeUndefined();
    });
  });
});
