import { TemplateRendererService } from './template-renderer.service';

import type { RenderNamespaces } from './template-renderer.service';

/** Contexto tipico de una ejecucion a mitad de pipeline. */
const buildNamespaces = (): RenderNamespaces => ({
  parsed_email: { clean_title: 'Innovacion en Madrid' },
  llm_response: {
    summary: 'Resumen estructurado.',
    articles: [{ title: 'Primer titular' }],
  },
});

describe('TemplateRendererService', () => {
  let renderer: TemplateRendererService;

  beforeEach(() => {
    renderer = new TemplateRendererService();
  });

  describe('1. Render exitoso', () => {
    it('1.1 deberia sustituir las variables por su valor', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h1>{{parsed_email.clean_title}}</h1>',
        ['parsed_email.clean_title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<h1>Innovacion en Madrid</h1>' });
    });

    it('1.2 deberia resolver rutas anidadas con indice', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h2>{{llm_response.articles.[0].title}}</h2>',
        ['llm_response.articles.0.title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({ markup: '<h2>Primer titular</h2>' });
    });

    it('1.3 deberia escapar el HTML presente en un valor del contexto', () => {
      // 1. Arrange
      const namespaces: RenderNamespaces = {
        parsed_email: { clean_title: '<img src=x onerror=alert(1)>' },
      };

      // 2. Act
      const outcome = renderer.renderStrict(
        '<h1>{{parsed_email.clean_title}}</h1>',
        ['parsed_email.clean_title'],
        namespaces,
      );

      // 3. Assert: el escapado por defecto de {{ }} es la razon por la que el
      // gestor prohibe el triple-stash al guardar
      expect(outcome).toHaveProperty('markup');
      expect('markup' in outcome && outcome.markup).not.toContain('<img');
    });

    it('1.4 deberia devolver intacto un HTML sin variables', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict('<p>Texto fijo</p>', [], {});

      // 3. Assert
      expect(outcome).toEqual({ markup: '<p>Texto fijo</p>' });
    });
  });

  describe('2. Variables ausentes', () => {
    it('2.1 deberia reportar TODAS las rutas que faltan, no solo la primera', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<p>{{scraped_web.headline}}{{raw_email.body}}</p>',
        ['scraped_web.headline', 'raw_email.body'],
        buildNamespaces(),
      );

      // 3. Assert: Handlebars estricto solo delataria la primera; el
      // pre-chequeo existe para que el operador arregle el flujo de una vez
      expect(outcome).toEqual({
        missingFields: ['scraped_web.headline', 'raw_email.body'],
      });
    });

    it('2.2 deberia detectar un indice fuera de rango', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '<h2>{{llm_response.articles.[5].title}}</h2>',
        ['llm_response.articles.5.title'],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toEqual({
        missingFields: ['llm_response.articles.5.title'],
      });
    });

    it('2.3 deberia fallar por modo estricto si la ruta no venia declarada', () => {
      // 1. Arrange & 2. Act: sin requiredVariables no hay pre-chequeo, y el
      // corte lo pone `strict: true` de Handlebars
      const outcome = renderer.renderStrict(
        '<p>{{scraped_web.headline}}</p>',
        [],
        buildNamespaces(),
      );

      // 3. Assert
      expect(outcome).toHaveProperty('failure');
    });
  });

  describe('3. Fallo de compilacion', () => {
    it('3.1 deberia devolver failure con stackTrace ante sintaxis rota', () => {
      // 1. Arrange & 2. Act
      const outcome = renderer.renderStrict(
        '{{#if algo}}<p>sin cerrar</p>',
        [],
        {},
      );

      // 3. Assert
      expect(outcome).toHaveProperty('failure');
      expect('failure' in outcome && outcome.stackTrace).toBeDefined();
    });

    it('3.2 no deberia lanzar nunca: el fallo viaja en el valor de retorno', () => {
      // 1. Arrange & 2. Act & 3. Assert
      expect(() => renderer.renderStrict('{{/each}}', [], {})).not.toThrow();
    });
  });
});
