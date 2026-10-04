import { NotFoundException } from '@nestjs/common';

import { StatePayloadContext } from '@core/fsm/context/state-payload.context';
import { NodeType } from '@core/fsm/types/pipeline-schema.types';
import { createTemplateRendererService } from '@test/factories/template-renderer.factory';

import {
  ERR_TEMPLATE_MISSING_VARS,
  ERR_TEMPLATE_NOT_RESOLVED,
  ERR_TEMPLATE_PENDING_VARS,
  ERR_TEMPLATE_RENDER,
  ERR_TEMPLATE_STRUCTURE,
  ERR_TEMPLATE_UNSUPPORTED_TAGS,
  TemplateMapperStrategy,
} from './template-mapper.strategy';

import type { HtmlTemplate } from '@modules/templates/entities/html-template.entity';
import type { TemplateRendererService } from '@modules/templates/services/template-renderer.service';
import type { TemplatesService } from '@modules/templates/templates.service';

const EXECUTION_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const WORKFLOW_ID = 'f0e9d8c7-6b5a-4938-8271-0a1b2c3d4e5f';
const INITIAL_STEP = 'mapeador_plantilla';
const TEMPLATE_ID = '5e2d1c4b-7a89-4f30-b1c2-6d5e4f3a2b10';
const AUTHOR_ID = '9c1f7b52-4d3a-4e6b-8f2c-1a0b9d8e7f60';

/** Esqueleto institucional: ranuras vacias, cero marcadores. */
const SKELETON_HTML =
  '<h1 class="titular"></h1><div class="cuerpo"><p></p></div>';

type TemplatesServiceMock = jest.Mocked<Pick<TemplatesService, 'findOne'>>;

/**
 * Plantilla ESQUELETO, que es la forma que el nodo admite desde el cambio de
 * semantica: sin `requiredVariables`, porque ya no interpola nada.
 */
const buildTemplate = (
  overrides: Partial<HtmlTemplate> = {},
): HtmlTemplate => ({
  id: TEMPLATE_ID,
  name: 'noticia-basica',
  description: null,
  htmlContent: SKELETON_HTML,
  requiredVariables: [],
  createdById: AUTHOR_ID,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** Plantilla HEREDADA de la etapa en que el nodo compilaba. */
const buildInterpolatedTemplate = (): HtmlTemplate =>
  buildTemplate({
    htmlContent:
      '<h1>{{parsed_email.clean_title}}</h1><p>{{llm_response.summary}}</p>',
    requiredVariables: ['parsed_email.clean_title', 'llm_response.summary'],
  });

const buildService = (): TemplatesServiceMock => ({ findOne: jest.fn() });

type TemplateRendererMock = jest.Mocked<
  Pick<TemplateRendererService, 'prepareInjectableMarkup' | 'auditStructure'>
>;

/** Doble del renderer, solo para el bloque que verifica la delegacion. */
const buildRendererMock = (): TemplateRendererMock => ({
  prepareInjectableMarkup: jest.fn().mockReturnValue({
    sanitized: SKELETON_HTML,
    wasFiltered: false,
    unsupportedTags: [],
  }),
  auditStructure: jest.fn().mockReturnValue({ missing: [], invalid: [] }),
});

/**
 * Instancia la estrategia. El renderer va REAL por defecto a proposito.
 *
 * Mockearlo en todas las pruebas volveria tautologicas las de saneado y las del
 * contrato estructural: comprobarian que un doble devuelve lo que se le dijo, no
 * que la lista blanca recorte de verdad ni que cheerio encuentre el selector —
 * justo la cobertura que impide que el nodo publique markup que el gestor habria
 * rechazado. Como el renderer es puro (sin repositorio, red ni estado), usarlo
 * de verdad no introduce acoplamiento alguno. El bloque 4 si lo mockea, porque
 * alli lo que se verifica es el contrato de delegacion.
 */
const buildStrategy = (
  service: TemplatesServiceMock,
  renderer:
    | TemplateRendererService
    | TemplateRendererMock = createTemplateRendererService(),
): TemplateMapperStrategy =>
  new TemplateMapperStrategy(
    service as unknown as TemplatesService,
    renderer as TemplateRendererService,
  );

/**
 * Contexto con namespaces poblados.
 *
 * Se siembra A PROPOSITO aunque el nodo ya no lo lea: varias pruebas verifican
 * justamente que su contenido no influye en la salida.
 */
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

  describe('1. Inyeccion de la plantilla base', () => {
    it('1.1 deberia inyectar el esqueleto saneado de la plantilla almacenada', async () => {
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
      expect(result.data?.compiled_markup).toBe(SKELETON_HTML);
      expect(service.findOne).toHaveBeenCalledWith(TEMPLATE_ID);
    });

    it('1.2 deberia sellar mapped_at con una marca ISO', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.data?.mapped_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it('1.3 NO deberia leer el contexto: un contexto vacio da el mismo markup', async () => {
      // 1. Arrange: la prueba central del cambio de semantica
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);
      const emptyContext = new StatePayloadContext(
        EXECUTION_ID,
        WORKFLOW_ID,
        INITIAL_STEP,
      );

      // 2. Act
      const withContext = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });
      const withoutContext = await strategy.execute(emptyContext, {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(withoutContext.success).toBe(true);
      expect(withoutContext.data?.compiled_markup).toBe(
        withContext.data?.compiled_markup,
      );
    });

    it('1.4 deberia descartar el markup que la lista blanca prohibe', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({
          htmlContent: `${SKELETON_HTML}<script>alert(1)</script>`,
        }),
      );
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).not.toContain('<script>');
      expect(result.data?.compiled_markup).toContain('titular');
    });

    it('1.5 deberia admitir rawTemplate como fallback sin base de datos', async () => {
      // 1. Arrange
      const service = buildService();
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        rawTemplate: '<p class="pie">Aviso institucional</p>',
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).toContain('Aviso institucional');
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('1.6 deberia sanear tambien el markup de rawTemplate', async () => {
      // 1. Arrange: `rawTemplate` no pasa por el gestor, asi que es el unico
      //    origen que podria colar markup nunca revisado.
      const strategy = buildStrategy(buildService());

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        rawTemplate: '<p>Texto</p><script>alert(1)</script>',
      });

      // 3. Assert
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).not.toContain('script');
    });
  });

  describe('2. Fallos GRAVE al resolver la plantilla', () => {
    it('2.1 deberia fallar sin templateId ni rawTemplate', async () => {
      // 1. Arrange
      const strategy = buildStrategy(buildService());

      // 2. Act
      const result = await strategy.execute(buildContext(), {});

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TEMPLATE_NOT_RESOLVED);
      expect(result.error?.missingFields).toContain('templateId');
    });

    it('2.2 deberia fallar cuando la plantilla no existe', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockRejectedValue(
        new NotFoundException(`Plantilla con id "${TEMPLATE_ID}" no encontrada`),
      );
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert: GRAVE y no URGENTE, para que entre en la politica de reintento
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TEMPLATE_NOT_RESOLVED);
    });

    it('2.3 deberia rechazar una plantilla desactivada', async () => {
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
      expect(result.error?.code).toBe(ERR_TEMPLATE_NOT_RESOLVED);
      expect(result.error?.message).toContain('desactivada');
    });

    it('2.4 deberia rechazar en voz alta una plantilla que aun interpola', async () => {
      // 1. Arrange: la guarda anti-corrupcion. Sin ella, estas llaves saldrian
      //    literales en el articulo publicado y nadie se enteraria.
      const service = buildService();
      service.findOne.mockResolvedValue(buildInterpolatedTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TEMPLATE_PENDING_VARS);
      expect(result.error?.missingFields).toEqual([
        'parsed_email.clean_title',
        'llm_response.summary',
      ]);
    });

    it('2.5 NO deberia resolver los marcadores aunque el contexto los tenga', async () => {
      // 1. Arrange: el contexto trae AMBOS valores; antes se habrian compilado.
      const service = buildService();
      service.findOne.mockResolvedValue(buildInterpolatedTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert: falla igual, porque ya no es su trabajo
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    });
  });

  describe('3. Inmutabilidad del contexto', () => {
    it('3.1 no deberia escribir en el contexto: eso es cosa del motor', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);
      const context = buildContext();

      // 2. Act
      await strategy.execute(context, { templateId: TEMPLATE_ID });

      // 3. Assert
      expect(context.getNamespace('rendered_html')).toBeUndefined();
    });
  });

  describe('4. Delegacion en TemplateRendererService', () => {
    it('4.1 deberia delegar el saneado y pasarle los allowedTags declarados', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const renderer = buildRendererMock();
      const strategy = buildStrategy(service, renderer);

      // 2. Act
      await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        allowedTags: ['h1', 'div'],
      });

      // 3. Assert
      expect(renderer.prepareInjectableMarkup).toHaveBeenCalledWith(
        SKELETON_HTML,
        ['h1', 'div'],
      );
    });

    it('4.2 deberia auditar la estructura sobre el markup YA saneado', async () => {
      // 1. Arrange: el saneador devuelve algo DISTINTO del original, de modo que
      //    la prueba distingue cual de los dos se audita.
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const renderer = buildRendererMock();
      renderer.prepareInjectableMarkup.mockReturnValue({
        sanitized: '<h1 class="titular"></h1>',
        wasFiltered: true,
        unsupportedTags: [],
      });
      const strategy = buildStrategy(service, renderer);

      // 2. Act
      await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['h1.titular'],
      });

      // 3. Assert
      expect(renderer.auditStructure).toHaveBeenCalledWith(
        '<h1 class="titular"></h1>',
        ['h1.titular'],
      );
    });

    it('4.3 deberia devolver el markup que el renderer saneo, sin retocarlo', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const renderer = buildRendererMock();
      renderer.prepareInjectableMarkup.mockReturnValue({
        sanitized: '<p>saneado por el doble</p>',
        wasFiltered: true,
        unsupportedTags: [],
      });
      const strategy = buildStrategy(service, renderer);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.data?.compiled_markup).toBe('<p>saneado por el doble</p>');
    });

    it('4.4 no deberia sanear siquiera si la plantilla aun interpola', async () => {
      // 1. Arrange: la guarda del paso 2 corta antes de gastar el saneado
      const service = buildService();
      service.findOne.mockResolvedValue(buildInterpolatedTemplate());
      const renderer = buildRendererMock();
      const strategy = buildStrategy(service, renderer);

      // 2. Act
      await strategy.execute(buildContext(), { templateId: TEMPLATE_ID });

      // 3. Assert
      expect(renderer.prepareInjectableMarkup).not.toHaveBeenCalled();
      expect(renderer.auditStructure).not.toHaveBeenCalled();
    });
  });

  describe('5. Inventario de salida (outputFields)', () => {
    it('5.1 deberia declarar las dos claves historicas del namespace', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());

      // 3. Assert: los nombres se CONSERVAN pese al cambio de contenido, para no
      //    dejar sin dato a los consumidores de rendered_html.compiled_markup
      expect(strategy.outputFields.map((field) => field.name)).toEqual([
        'compiled_markup',
        'mapped_at',
      ]);
    });

    it('5.2 deberia coincidir exactamente con las claves que emite execute', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(Object.keys(result.data ?? {}).sort()).toEqual(
        strategy.outputFields.map((field) => field.name).sort(),
      );
    });

    it('5.3 deberia describir compiled_markup como markup SIN interpolar', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());
      const field = strategy.outputFields.find(
        ({ name }) => name === 'compiled_markup',
      );

      // 3. Assert: el nombre ya no describe el contenido, asi que la descripcion
      //    es lo unico que evita que un auditor lea mal el namespace
      expect(field?.description).toMatch(/SIN interpolar/);
    });
  });

  describe('6. Contrato estructural y lista blanca', () => {
    it('6.1 deberia aceptar la plantilla que contiene los selectores exigidos', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['h1.titular', 'div.cuerpo'],
      });

      // 3. Assert
      expect(result.success).toBe(true);
    });

    it('6.2 deberia fallar nombrando el selector ausente', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['h1.titular', 'div.pie'],
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TEMPLATE_STRUCTURE);
      expect(result.error?.missingFields).toEqual(['div.pie']);
    });

    it('6.3 deberia contar como ausente el selector que el saneado elimino', async () => {
      // 1. Arrange: `<script>` cae con la lista blanca, asi que exigirlo no
      //    puede cumplirse por mucho que este en el HTML original. Auditar el
      //    markup crudo habria dado esta plantilla por valida.
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({ htmlContent: `${SKELETON_HTML}<script></script>` }),
      );
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['script'],
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_TEMPLATE_STRUCTURE);
    });

    it('6.4 deberia recortar la plantilla con los allowedTags declarados', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        allowedTags: ['h1'],
      });

      // 3. Assert: el <div class="cuerpo"> desaparece por no estar en la lista
      expect(result.success).toBe(true);
      expect(result.data?.compiled_markup).toContain('titular');
      expect(result.data?.compiled_markup).not.toContain('<div');
    });

    it('6.5 deberia rechazar un allowedTags que intente AMPLIAR la lista blanca', async () => {
      // 1. Arrange: conceder `script` por parametro seria abrir XSS
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        allowedTags: ['h1', 'script'],
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.level).toBe('GRAVE');
      expect(result.error?.code).toBe(ERR_TEMPLATE_UNSUPPORTED_TAGS);
      expect(result.error?.missingFields).toEqual(['script']);
    });

    it('6.6 deberia separar el selector invalido del simplemente ausente', async () => {
      // 1. Arrange: los dos arreglos son distintos — uno se corrige en la
      //    plantilla, el otro en la configuracion del nodo.
      const service = buildService();
      service.findOne.mockResolvedValue(buildTemplate());
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
        requiredSelectors: ['div[[['],
      });

      // 3. Assert
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(ERR_TEMPLATE_STRUCTURE);
      expect(result.error?.message).toContain('no son selectores validos');
    });

    it('6.7 no deberia exigir estructura alguna sin requiredSelectors', async () => {
      // 1. Arrange
      const service = buildService();
      service.findOne.mockResolvedValue(
        buildTemplate({ htmlContent: '<p>Solo un parrafo</p>' }),
      );
      const strategy = buildStrategy(service);

      // 2. Act
      const result = await strategy.execute(buildContext(), {
        templateId: TEMPLATE_ID,
      });

      // 3. Assert
      expect(result.success).toBe(true);
    });
  });

  describe('7. Contratos declarativos para el validador', () => {
    it('7.1 deberia declarar templateId incompleto sin ningun origen', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());

      // 3. Assert
      expect(strategy.getIncompleteParams({})).toEqual(['templateId']);
    });

    it('7.2 no deberia declarar nada incompleto con templateId', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());

      // 3. Assert
      expect(strategy.getIncompleteParams({ templateId: TEMPLATE_ID })).toEqual(
        [],
      );
    });

    it('7.3 deberia dar por completo un nodo que use rawTemplate', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());

      // 3. Assert
      expect(strategy.getIncompleteParams({ rawTemplate: '<p></p>' })).toEqual(
        [],
      );
    });

    it('7.4 deberia declarar inalcanzables los codigos de la etapa de compilacion', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());

      // 3. Assert: asi la regla 10 rechaza al GUARDAR una ruta onErrorStep que
      //    los cite, en vez de dejarla como un respaldo que jamas correria
      expect(strategy.getUnreachableErrorCodes({})).toEqual([
        ERR_TEMPLATE_MISSING_VARS,
        ERR_TEMPLATE_RENDER,
      ]);
    });

    it('7.5 no deberia declarar inalcanzable ningun codigo que si emite', () => {
      // 1. Arrange & 2. Act
      const strategy = buildStrategy(buildService());
      const unreachable = strategy.getUnreachableErrorCodes({});

      // 3. Assert
      expect(unreachable).not.toContain(ERR_TEMPLATE_NOT_RESOLVED);
      expect(unreachable).not.toContain(ERR_TEMPLATE_PENDING_VARS);
      expect(unreachable).not.toContain(ERR_TEMPLATE_STRUCTURE);
      expect(unreachable).not.toContain(ERR_TEMPLATE_UNSUPPORTED_TAGS);
    });
  });
});
